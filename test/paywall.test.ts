import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { PAYMENT_HEADER, parsePaymentRequest } from "../src/payment-request.ts";
import { createPaywall, type PaywallOptions } from "../src/seller/paywall.ts";
import { SELLER, tokensFetch } from "./fixtures.ts";

const PRICE = { symbol: "ETH", chain: "base", amount: "200000000000000", recipient: SELLER };

let server: Server | undefined;
afterEach(() => server?.close());

async function serve(options: Partial<PaywallOptions> = {}): Promise<string> {
  const paywall = await createPaywall({ ...PRICE, fetch: tokensFetch, ...options });
  server = createServer((req, res) => {
    void paywall(req, res, () => res.end("served"));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("answers an unpaid request with a 402 carrying the full payment request", async () => {
  const before = Date.now();
  const res = await fetch(await serve());

  assert.equal(res.status, 402);
  assert.equal(res.headers.get("cache-control"), "no-store");

  const request = parsePaymentRequest(await res.json());
  assert.equal(request.amount, PRICE.amount);
  assert.equal(request.assetId, "nep141:base.omft.near");
  assert.equal(request.chain, "base");
  assert.equal(request.recipient, SELLER);
  assert.equal(request.symbol, "ETH");
  assert.equal(request.decimals, 18);
  assert.ok(request.requestId.length > 0);
  assert.ok(Date.parse(request.expiresAt) >= before + 10 * 60 * 1000);
});

test("gives each request its own id", async () => {
  const url = await serve();
  const [a, b] = await Promise.all([fetch(url), fetch(url)]);
  const [first, second] = [parsePaymentRequest(await a.json()), parsePaymentRequest(await b.json())];
  assert.notEqual(first.requestId, second.requestId);
});

test("never serves a claimed payment when no verifier is configured", async () => {
  const res = await fetch(await serve(), { headers: { [PAYMENT_HEADER]: "anything" } });
  assert.equal(res.status, 402);
});

test("serves only when the verifier accepts the request id", async () => {
  const seen: string[] = [];
  const url = await serve({
    verify: (requestId) => {
      seen.push(requestId);
      return requestId === "paid";
    },
  });

  const paid = await fetch(url, { headers: { [PAYMENT_HEADER]: "paid" } });
  assert.equal(paid.status, 200);
  assert.equal(await paid.text(), "served");

  const unpaid = await fetch(url, { headers: { [PAYMENT_HEADER]: "unpaid" } });
  assert.equal(unpaid.status, 402);
  assert.deepEqual(seen, ["paid", "unpaid"]);
});

test("fails closed when the verifier throws", async () => {
  const url = await serve({
    verify: () => {
      throw new Error("rpc down at https://secret.example");
    },
  });
  const res = await fetch(url, { headers: { [PAYMENT_HEADER]: "paid" } });
  assert.equal(res.status, 500);
  assert.doesNotMatch(await res.text(), /secret\.example/);
});

test("records each request before issuing it, and issues nothing if that fails", async () => {
  const issued: string[] = [];
  const res = await fetch(await serve({ onIssue: (r) => void issued.push(r.requestId) }));
  assert.deepEqual(issued, [parsePaymentRequest(await res.json()).requestId]);
  server?.close();

  const failing = await fetch(
    await serve({
      onIssue: () => {
        throw new Error("store down");
      },
    }),
  );
  assert.equal(failing.status, 500);
});

test("honours a custom expiry window", async () => {
  const before = Date.now();
  const res = await fetch(await serve({ ttlMs: 60_000 }));
  const { expiresAt } = parsePaymentRequest(await res.json());
  assert.ok(Date.parse(expiresAt) <= before + 61_000);
});

test("refuses bad configuration at startup", async () => {
  const cases: Array<[Partial<PaywallOptions>, RegExp]> = [
    [{ amount: "0.0002" }, /amount/],
    [{ amount: "0" }, /amount/],
    [{ recipient: "not-an-address" }, /recipient/],
    [{ symbol: "NOPE" }, /NOPE on base is not supported/],
    [{ ttlMs: 0 }, /ttlMs/],
  ];
  for (const [options, message] of cases) {
    await assert.rejects(createPaywall({ ...PRICE, fetch: tokensFetch, ...options }), message);
  }
});
