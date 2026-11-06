import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { askInTerminal } from "../src/client/approve-cli.ts";
import type { ApprovalSummary } from "../src/client/deposit.ts";

const SUMMARY: ApprovalSummary = {
  pay: "0.453 USDC",
  refundTo: "Payer1",
  sellerGets: "0.0002 ETH on base",
  recipient: "0xSeller",
  timeEstimateSeconds: 24,
  refundsBeginAt: "2026-11-06T12:10:00.000Z",
  refundFee: "0.24 USDC",
  depositAddress: "Dep1",
};

async function answer(text: string) {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = "";
  output.on("data", (chunk) => (shown += chunk));
  const result = askInTerminal(SUMMARY, { input, output });
  input.end(`${text}\n`);
  return { approved: await result, shown };
}

for (const [text, expected] of [
  ["yes", true],
  ["YES ", true],
  ["y", false],
  ["", false],
  ["no", false],
] as const) {
  test(`"${text}" ${expected ? "approves" : "does not approve"}`, async () => {
    assert.equal((await answer(text)).approved, expected);
  });
}

test("shows the payment before asking", async () => {
  const { shown } = await answer("no");
  assert.match(shown, /Pay 0\.453 USDC from Payer1/);
  assert.match(shown, /1Click keeps about 0\.24 USDC/);
});
