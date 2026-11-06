import assert from "node:assert/strict";
import { test } from "node:test";
import { requestQuote } from "../src/client/quote.ts";
import type { PaymentRequest } from "../src/payment-request.ts";
import { SELLER, TOKENS } from "./fixtures.ts";

const USDC = TOKENS[1];
const now = Date.parse("2026-11-06T12:00:00.000Z");
const REQUEST: PaymentRequest = {
  version: 1,
  requestId: "req-1",
  amount: "200000000000000",
  assetId: "nep141:base.omft.near",
  chain: "base",
  symbol: "ETH",
  decimals: 18,
  recipient: SELLER,
  expiresAt: "2026-11-06T12:10:00.000Z",
};

function api(quote: Record<string, unknown> | null, status = 200, message?: string) {
  const sent: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    sent.push({ body: JSON.parse(init.body as string), headers: init.headers as Record<string, string> });
    if (status !== 200) return Response.json({ message }, { status });
    return Response.json({
      quote: {
        depositAddress: "Dep1",
        amountIn: "485583",
        minAmountIn: "480727",
        amountOut: REQUEST.amount,
        refundFee: "238733",
        timeEstimate: 24,
        deadline: "2026-11-09T12:10:00.000Z",
        ...quote,
      },
    });
  }) as typeof fetch;
  return { fetch: fetchFn, sent };
}

const base = { request: REQUEST, source: USDC, refundTo: "Payer1", maxAmountIn: "1000000", now: () => now };

test("asks for an exact-output quote that binds the swap to this request", async () => {
  const a = api({});
  await requestQuote({ ...base, apiKey: "k", fetch: a.fetch });
  const { body, headers } = a.sent[0];
  assert.deepEqual(body, {
    dry: false,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 100,
    originAsset: USDC.assetId,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: REQUEST.assetId,
    amount: REQUEST.amount,
    recipient: SELLER,
    recipientType: "DESTINATION_CHAIN",
    refundTo: "Payer1",
    refundType: "ORIGIN_CHAIN",
    deadline: REQUEST.expiresAt,
  });
  assert.equal(headers["X-API-Key"], "k");
});

test("returns what the payer needs to approve", async () => {
  const quote = await requestQuote({ ...base, fetch: api({}).fetch });
  assert.deepEqual(quote, {
    depositAddress: "Dep1",
    depositMemo: undefined,
    amountIn: "485583",
    minAmountIn: "480727",
    amountOut: REQUEST.amount,
    refundFee: "238733",
    timeEstimateSeconds: 24,
    refundsBeginAt: REQUEST.expiresAt,
    addressInactiveAt: "2026-11-09T12:10:00.000Z",
  });
});

test("rejects a quote that costs more than the payer's maximum", async () => {
  await assert.rejects(
    requestQuote({ ...base, maxAmountIn: "485582", fetch: api({}).fetch }),
    /costs 0\.485583 USDC, more than the maximum of 0\.485582 USDC/,
  );
});

test("accepts a quote at exactly the maximum", async () => {
  const quote = await requestQuote({ ...base, maxAmountIn: "485583", fetch: api({}).fetch });
  assert.equal(quote.amountIn, "485583");
});

test("rejects a quote the payer cannot afford", async () => {
  await assert.rejects(
    requestQuote({ ...base, balance: "400000", fetch: api({}).fetch }),
    /costs 0\.485583 USDC, but the payer holds 0\.4 USDC/,
  );
});

test("rejects a quote that would not deliver the exact price", async () => {
  await assert.rejects(requestQuote({ ...base, fetch: api({ amountOut: "1" }).fetch }), /deliver 1, not 200000000000000/);
});

test("rejects a quote with no deposit address", async () => {
  await assert.rejects(requestQuote({ ...base, fetch: api({ depositAddress: undefined }).fetch }), /deposit address/);
});

test("refuses to quote a request that expires too soon to pay", async () => {
  const a = api({});
  await assert.rejects(
    requestQuote({ ...base, now: () => Date.parse(REQUEST.expiresAt) - 30_000, fetch: a.fetch }),
    /expires in 30 s/,
  );
  assert.equal(a.sent.length, 0);
});

test("passes on the API's reason when it refuses to quote", async () => {
  await assert.rejects(
    requestQuote({ ...base, fetch: api(null, 400, "Amount is too low for bridge, try at least 105965808135820").fetch }),
    /HTTP 400: Amount is too low for bridge, try at least 105965808135820/,
  );
});

test("rejects a maximum that is not a whole number of smallest units", async () => {
  await assert.rejects(requestQuote({ ...base, maxAmountIn: "0.5", fetch: api({}).fetch }), /maxAmountIn/);
});
