import assert from "node:assert/strict";
import { test } from "node:test";
import {
  pollSwapStatus,
  SwapStatusTimeout,
  type PollOptions,
} from "../src/client/poll-status.ts";

type Step = { status: string; body?: object } | number | Error | "bad-json";

/** Plays back one step per poll, on a fake clock that sleeping advances. */
function harness(steps: Step[], options: Partial<PollOptions> = {}) {
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const logs: string[] = [];
  const urls: string[] = [];
  const inits: RequestInit[] = [];
  let i = 0;

  const fetchFn = (async (url: string, init: RequestInit) => {
    urls.push(url);
    inits.push(init);
    const step = steps[Math.min(i++, steps.length - 1)];
    if (step instanceof Error) throw step;
    if (step === "bad-json") return new Response("<html>", { status: 200 });
    if (typeof step === "number") return new Response("{}", { status: step });
    return Response.json({
      status: step.status,
      correlationId: `changes-every-response-${i}`,
      swapDetails: { refundedAmount: "0" },
      ...step.body,
    });
  }) as typeof fetch;

  const run = pollSwapStatus({
    depositAddress: "Dep/osit+Addr",
    fetch: fetchFn,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    log: (line) => logs.push(line),
    ...options,
  });
  return { run, sleeps, logs, urls, inits, polls: () => i };
}

for (const terminal of ["SUCCESS", "REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"]) {
  test(`stops at ${terminal}`, async () => {
    const { run, polls } = harness([{ status: "PROCESSING" }, { status: terminal }, { status: "NEVER" }]);
    assert.equal((await run).status, terminal);
    assert.equal(polls(), 2);
  });
}

test("keeps polling through every non-terminal status", async () => {
  const { run, polls } = harness([
    { status: "PENDING_DEPOSIT" },
    { status: "KNOWN_DEPOSIT_TX" },
    { status: "PROCESSING" },
    { status: "SUCCESS" },
  ]);
  assert.equal((await run).status, "SUCCESS");
  assert.equal(polls(), 4);
});

test("keeps polling through a status it does not know", async () => {
  const { run, logs } = harness([{ status: "BRAND_NEW" }, { status: "SUCCESS" }]);
  assert.equal((await run).status, "SUCCESS");
  assert.ok(logs.some((l) => l.includes("BRAND_NEW")));
});

test("logs elapsed time from the moment the deposit was sent", async () => {
  const { run, logs } = harness([{ status: "PROCESSING" }, { status: "SUCCESS" }], {
    startedAt: 1_000_000 - 3_000,
    intervalMs: 2_000,
  });
  const result = await run;
  assert.equal(result.elapsedMs, 5_000);
  assert.match(logs.at(-1)!, /swap Dep\/osit\+Addr SUCCESS after 5\.0 s/);
});

test("logs only when the status changes", async () => {
  const { run, logs } = harness([
    { status: "PROCESSING" },
    { status: "PROCESSING" },
    { status: "PROCESSING" },
    { status: "SUCCESS" },
  ]);
  await run;
  assert.equal(logs.length, 2);
});

test("names the swap by deposit address, because correlationId changes per response", async () => {
  const { run, logs } = harness([{ status: "PROCESSING" }, { status: "SUCCESS" }]);
  const result = await run;
  assert.equal(result.depositAddress, "Dep/osit+Addr");
  assert.equal(logs.length, 2);
  for (const line of logs) {
    assert.ok(line.startsWith("swap Dep/osit+Addr "));
    assert.doesNotMatch(line, /changes-every-response/);
  }
});

test("returns the swap details", async () => {
  const { run } = harness([
    {
      status: "REFUNDED",
      body: { swapDetails: { refundedAmount: "229000", refundReason: "PARTIAL_DEPOSIT" } },
    },
  ]);
  const result = await run;
  assert.equal(result.details.refundedAmount, "229000");
  assert.equal(result.details.refundReason, "PARTIAL_DEPOSIT");
});

test("retries network errors, 429s, 5xx and bad JSON instead of giving up", async () => {
  const { run, polls } = harness([
    new TypeError("fetch failed"),
    429,
    503,
    "bad-json",
    { status: "SUCCESS" },
  ]);
  assert.equal((await run).status, "SUCCESS");
  assert.equal(polls(), 5);
});

test("backs off while the API is failing, and recovers afterwards", async () => {
  const { run, sleeps } = harness(
    [503, 503, 503, { status: "PROCESSING" }, { status: "SUCCESS" }],
    { intervalMs: 2_000 },
  );
  await run;
  assert.deepEqual(sleeps, [4_000, 8_000, 16_000, 2_000]);
});

test("caps the backoff", async () => {
  const { run, sleeps } = harness([503, 503, 503, 503, 503, 503, { status: "SUCCESS" }], {
    intervalMs: 2_000,
  });
  await run;
  assert.equal(Math.max(...sleeps), 30_000);
});

test("a response that is not a status counts as a failed check", async () => {
  const { run, polls } = harness([{ status: 7 as unknown as string }, { status: "SUCCESS" }]);
  assert.equal((await run).status, "SUCCESS");
  assert.equal(polls(), 2);
});

test("times out with the last status and says the swap may still finish", async () => {
  const { run, logs } = harness([{ status: "PROCESSING" }], { timeoutMs: 10_000, intervalMs: 2_000 });
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof SwapStatusTimeout);
    assert.equal(error.lastStatus, "PROCESSING");
    assert.equal(error.elapsedMs, 10_000);
    assert.match(error.message, /may still complete/);
    assert.match(error.message, /Do not pay again/);
    return true;
  });
  assert.match(logs.at(-1)!, /gave up after 10\.0 s/);
});

test("times out even if every check fails", async () => {
  const { run } = harness([new TypeError("fetch failed")], { timeoutMs: 10_000 });
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof SwapStatusTimeout);
    assert.equal(error.lastStatus, null);
    return true;
  });
});

test("never sleeps past the timeout", async () => {
  const { run, sleeps } = harness([503], { timeoutMs: 10_000, intervalMs: 2_000 });
  await assert.rejects(run, SwapStatusTimeout);
  assert.equal(sleeps.reduce((a, b) => a + b, 0), 10_000);
});

for (const [code, message] of [
  [401, /401/],
  [404, /404/],
  [400, /400/],
] as const) {
  test(`stops immediately on ${code}, which retrying cannot fix`, async () => {
    const { run, polls, logs } = harness([code, { status: "SUCCESS" }]);
    await assert.rejects(run, message);
    assert.equal(polls(), 1);
    assert.match(logs.at(-1)!, /after 0\.0 s/);
  });
}

test("encodes the address, and sends the memo and key when given", async () => {
  const { run, urls, inits } = harness([{ status: "SUCCESS" }], {
    depositMemo: "12 34",
    apiKey: "key-1",
  });
  await run;
  assert.match(urls[0], /\/v0\/status\?depositAddress=Dep%2Fosit%2BAddr&depositMemo=12\+34$/);
  assert.equal((inits[0].headers as Record<string, string>)["X-API-Key"], "key-1");
  assert.ok(inits[0].signal instanceof AbortSignal);
});

test("sends no key header without a key", async () => {
  const { run, inits } = harness([{ status: "SUCCESS" }]);
  await run;
  assert.deepEqual(inits[0].headers, {});
});
