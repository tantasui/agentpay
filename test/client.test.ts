import assert from "node:assert/strict";
import { test } from "node:test";
import { listSolanaHoldings, type Holding } from "../src/client/holdings.ts";
import { pickSourceAsset } from "../src/client/pick-source.ts";
import { parsePaymentRequest, type PaymentRequest } from "../src/payment-request.ts";
import { SELLER, TOKENS, USDC_MINT } from "./fixtures.ts";

const REQUEST: PaymentRequest = {
  version: 1,
  requestId: "req-1",
  amount: "200000000000000", // 0.0002 ETH, $0.48 at the fixture price
  assetId: "nep141:base.omft.near",
  chain: "base",
  symbol: "ETH",
  decimals: 18,
  recipient: SELLER,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

const usdc = (amount: string): Holding => ({ chain: "sol", contract: USDC_MINT, amount });
const sol = (amount: string): Holding => ({ chain: "sol", contract: null, amount });

test("parsePaymentRequest rejects anything malformed or expired", () => {
  const body = (payment: unknown) => ({ error: "payment_required", payment });
  const cases: Array<[unknown, RegExp]> = [
    [null, /payment request/],
    [{ error: "nope" }, /payment request/],
    [body({ ...REQUEST, version: 2 }), /version/],
    [body({ ...REQUEST, requestId: "" }), /requestId/],
    [body({ ...REQUEST, amount: "1.5" }), /amount/],
    [body({ ...REQUEST, amount: 200 }), /amount/],
    [body({ ...REQUEST, assetId: 7 }), /assetId/],
    [body({ ...REQUEST, recipient: "0x123" }), /recipient/],
    [body({ ...REQUEST, decimals: -1 }), /decimals/],
    [body({ ...REQUEST, expiresAt: "soon" }), /expiresAt/],
    [body({ ...REQUEST, expiresAt: new Date(Date.now() - 1000).toISOString() }), /expired/],
  ];
  for (const [input, message] of cases) assert.throws(() => parsePaymentRequest(input), message);
  assert.deepEqual(parsePaymentRequest(body(REQUEST)), REQUEST);
});

test("picks a supported holding that covers the price", () => {
  const { source, skipped } = pickSourceAsset([usdc("5000000")], TOKENS, REQUEST);
  assert.equal(source?.token.symbol, "USDC");
  assert.equal(source?.holding.amount, "5000000");
  assert.deepEqual(skipped, []);
});

test("skips unsupported holdings with a message naming them", () => {
  const junk: Holding = { chain: "sol", contract: "JunkMint111", amount: "1000" };
  const { source, skipped } = pickSourceAsset([junk, usdc("5000000")], TOKENS, REQUEST);
  assert.equal(source?.token.symbol, "USDC");
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /JunkMint111 on sol is not supported by NEAR Intents/);
});

test("matches native assets, which have no contract address", () => {
  const { source } = pickSourceAsset([sol("1000000000")], TOKENS, REQUEST);
  assert.equal(source?.token.assetId, "nep141:sol.omft.near");
});

test("skips holdings too small to cover the price, with both values", () => {
  const { source, skipped } = pickSourceAsset([usdc("100000")], TOKENS, REQUEST);
  assert.equal(source, null);
  assert.match(skipped[0].reason, /USDC on sol is worth about \$0\.10, needs about \$0\.50/);
});

test("leaves room for swap costs when deciding what covers the price", () => {
  // $0.48 covers the bare price but not the cost of swapping.
  assert.equal(pickSourceAsset([usdc("480000")], TOKENS, REQUEST).source, null);
});

test("prefers the holding with the most value", () => {
  const { source, skipped } = pickSourceAsset([usdc("1000000"), sol("1000000000")], TOKENS, REQUEST);
  assert.equal(source?.token.symbol, "SOL");
  assert.deepEqual(skipped, []);
});

test("skips a holding already in the seller's asset", () => {
  const base: Holding = { chain: "base", contract: null, amount: "1000000000000000000" };
  const { source, skipped } = pickSourceAsset([base], TOKENS, REQUEST);
  assert.equal(source, null);
  assert.match(skipped[0].reason, /already the seller's asset/);
});

test("uses the token list's decimals, not the seller's claim", () => {
  const lying = { ...REQUEST, decimals: 6 }; // would value the price at $480 billion
  assert.equal(pickSourceAsset([usdc("5000000")], TOKENS, lying).source?.token.symbol, "USDC");
});

test("throws when the seller's asset is not supported", () => {
  assert.throws(
    () => pickSourceAsset([usdc("5000000")], TOKENS, { ...REQUEST, assetId: "nep141:nope" }),
    /nep141:nope is not supported by NEAR Intents/,
  );
});

function rpcFetch(accounts: Record<string, Array<[string, string]>>, lamports: number, status = 200) {
  return (async (_url: string, init: RequestInit) => {
    if (status !== 200) return new Response("busy", { status });
    const { method, params } = JSON.parse(init.body as string);
    if (method === "getBalance") return Response.json({ result: { value: lamports } });
    const value = (accounts[params[1].programId] ?? []).map(([mint, amount]) => ({
      account: { data: { parsed: { info: { mint, tokenAmount: { amount } } } } },
    }));
    return Response.json({ result: { value } });
  }) as typeof fetch;
}

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

test("lists SOL and tokens from both token programs, dropping empty accounts", async () => {
  const holdings = await listSolanaHoldings({
    rpcUrl: "http://rpc",
    owner: "owner",
    fetch: rpcFetch(
      { [TOKEN_PROGRAM]: [[USDC_MINT, "5000000"], ["Empty", "0"]], [TOKEN_2022]: [["Mint2022", "7"]] },
      1_000_000_000,
    ),
  });
  assert.deepEqual(holdings, [
    { chain: "sol", contract: null, amount: "995000000" },
    { chain: "sol", contract: USDC_MINT, amount: "5000000" },
    { chain: "sol", contract: "Mint2022", amount: "7" },
  ]);
});

test("keeps SOL back for fees, so a small balance is not offered as a source", async () => {
  const holdings = await listSolanaHoldings({
    rpcUrl: "http://rpc",
    owner: "owner",
    fetch: rpcFetch({}, 5_000_000),
  });
  assert.deepEqual(holdings, []);
});

test("reports RPC failures", async () => {
  await assert.rejects(
    listSolanaHoldings({ rpcUrl: "http://rpc", owner: "owner", fetch: rpcFetch({}, 0, 429) }),
    /Solana RPC returned 429/,
  );
});
