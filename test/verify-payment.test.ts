import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import {
  PAYMENT_DEPOSIT_HEADER,
  PAYMENT_HEADER,
  parsePaymentRequest,
  type PaymentRequest,
} from "../src/payment-request.ts";
import { createPaywall } from "../src/seller/paywall.ts";
import { createRequestStore } from "../src/seller/request-store.ts";
import { createPaymentVerifier } from "../src/seller/verify-payment.ts";
import { SELLER, tokensFetch } from "./fixtures.ts";

const PRICE = "200000000000000";
const ASSET = "nep141:base.omft.near";
const RPC = "http://base-rpc";
const TX = "0xabc";

function issue(store = createRequestStore(), id = "req-1"): [ReturnType<typeof createRequestStore>, PaymentRequest] {
  const request: PaymentRequest = {
    version: 1,
    requestId: id,
    amount: PRICE,
    assetId: ASSET,
    chain: "base",
    symbol: "ETH",
    decimals: 18,
    recipient: SELLER,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  store.issue(request);
  return [store, request];
}

type World = {
  status?: string;
  httpStatus?: number;
  quoteRequest?: Record<string, unknown>;
  amountOut?: string | null;
  hashes?: string[];
  receipt?: { status: string; blockNumber: string } | null;
  tx?: { to: string | null; value: string };
  balances?: Record<string, string>;
};

function world(request: PaymentRequest, w: World = {}) {
  const calls: Array<{ url: string; headers?: HeadersInit; method?: string }> = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    if (url.startsWith("https://1click.chaindefuser.com/v0/status")) {
      calls.push({ url, headers: init.headers });
      if (w.httpStatus && w.httpStatus !== 200) return new Response("{}", { status: w.httpStatus });
      return Response.json({
        status: w.status ?? "SUCCESS",
        quoteResponse: {
          quoteRequest: {
            swapType: "EXACT_OUTPUT",
            recipient: SELLER,
            destinationAsset: ASSET,
            amount: PRICE,
            deadline: request.expiresAt,
            ...w.quoteRequest,
          },
        },
        swapDetails: {
          amountOut: w.amountOut === undefined ? PRICE : w.amountOut,
          destinationChainTxHashes: (w.hashes ?? [TX]).map((hash) => ({ hash, explorerUrl: "" })),
        },
      });
    }
    assert.equal(url, RPC);
    const { method, params } = JSON.parse(init.body as string);
    calls.push({ url, method });
    const result =
      method === "eth_getTransactionReceipt"
        ? w.receipt === undefined
          ? { status: "0x1", blockNumber: "0x10" }
          : w.receipt
        : method === "eth_getTransactionByHash"
          ? (w.tx ?? { to: SELLER, value: "0x" + BigInt(PRICE).toString(16) })
          : (w.balances ?? {})[params[1]];
    return Response.json({ jsonrpc: "2.0", id: 1, result });
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

const req = (deposit?: string) =>
  ({ headers: deposit ? { [PAYMENT_DEPOSIT_HEADER]: deposit } : {} }) as unknown as IncomingMessage;

function verifier(store: ReturnType<typeof createRequestStore>, fetchFn: typeof fetch, apiKey?: string) {
  return createPaymentVerifier({
    store,
    recipient: SELLER,
    assetId: ASSET,
    amount: PRICE,
    baseRpcUrl: RPC,
    apiKey,
    fetch: fetchFn,
    log: () => {},
  });
}

test("accepts a direct transfer of the price to the seller, once", async () => {
  const [store, request] = issue();
  const verify = verifier(store, world(request).fetch);
  assert.equal(await verify("req-1", req("dep-1")), true);
  assert.equal(await verify("req-1", req("dep-1")), false);
});

test("accepts a delivery made inside a contract call, by the balance change in that block", async () => {
  const [store, request] = issue();
  const w = world(request, {
    tx: { to: "0x00000000000000000000000000000000000000aa", value: "0x0" },
    balances: { "0xf": "0x0", "0x10": "0x" + BigInt(PRICE).toString(16) },
  });
  assert.equal(await verifier(store, w.fetch)("req-1", req("dep-1")), true);
});

const refusals: Array<[string, World | ((r: PaymentRequest) => World)]> = [
  ["the swap has not succeeded", { status: "PROCESSING" }],
  ["the swap pays someone else", { quoteRequest: { recipient: "0x00000000000000000000000000000000000000bb" } }],
  ["the swap pays another asset", { quoteRequest: { destinationAsset: "nep141:other" } }],
  ["the swap is for a different amount", { quoteRequest: { amount: "1" } }],
  ["the swap is not exact-output", { quoteRequest: { swapType: "EXACT_INPUT" } }],
  ["the swap was quoted for another request", { quoteRequest: { deadline: "2026-01-01T00:00:00.000Z" } }],
  ["less than the price was delivered", { amountOut: "1" }],
  ["no delivery transaction is reported", { hashes: [] }],
  ["the delivery is not on Base yet", { receipt: null }],
  ["the delivery transaction failed", { receipt: { status: "0x0", blockNumber: "0x10" } }],
  [
    "the seller's balance did not rise by the price",
    {
      tx: { to: "0x00000000000000000000000000000000000000aa", value: "0x0" },
      balances: { "0xf": "0x0", "0x10": "0x1" },
    },
  ],
  ["1Click does not know the deposit address", { httpStatus: 404 }],
];

for (const [name, w] of refusals) {
  test(`refuses when ${name}, and lets the request be tried again`, async () => {
    const [store, request] = issue();
    const verify = verifier(store, world(request, typeof w === "function" ? w(request) : w).fetch);
    assert.equal(await verify("req-1", req("dep-1")), false);
    assert.equal(store.claim("req-1", "dep-1").ok, true, "released after refusal");
  });
}

test("refuses without asking anyone when the deposit address is missing", async () => {
  const [store, request] = issue();
  const w = world(request);
  assert.equal(await verifier(store, w.fetch)("req-1", req()), false);
  assert.equal(w.calls.length, 0);
});

test("refuses a deposit address that already paid for another request", async () => {
  const [store, request] = issue();
  issue(store, "req-2");
  const verify = verifier(store, world(request).fetch);
  assert.equal(await verify("req-1", req("dep-1")), true);
  assert.equal(await verify("req-2", req("dep-1")), false);
});

test("throws when 1Click is failing, and frees the request for a retry", async () => {
  const [store, request] = issue();
  await assert.rejects(verifier(store, world(request, { httpStatus: 503 }).fetch)("req-1", req("dep-1")), /503/);
  assert.equal(store.claim("req-1", "dep-1").ok, true);
});

test("compares the recipient without regard to case", async () => {
  const [store, request] = issue();
  const w = world(request, { quoteRequest: { recipient: SELLER.toLowerCase() } });
  assert.equal(await verifier(store, w.fetch)("req-1", req("dep-1")), true);
});

test("asks 1Click itself, with the seller's key, for the swap behind the deposit address", async () => {
  const [store, request] = issue();
  const w = world(request);
  await verifier(store, w.fetch, "seller-key")("req-1", req("dep/1"));
  assert.match(w.calls[0].url, /\/v0\/status\?depositAddress=dep%2F1$/);
  assert.equal((w.calls[0].headers as Record<string, string>)["X-API-Key"], "seller-key");
});

let server: Server | undefined;
afterEach(() => server?.close());

test("end to end: 402, then served once after a verified payment", async () => {
  const store = createRequestStore();
  let issued: PaymentRequest | undefined;
  const fetchFn = (async (url: string, init?: RequestInit) =>
    url.endsWith("/v0/tokens") ? tokensFetch(url) : world(issued!).fetch(url, init)) as typeof fetch;
  const paywall = await createPaywall({
    symbol: "ETH",
    chain: "base",
    amount: PRICE,
    recipient: SELLER,
    fetch: fetchFn,
    onIssue: (r) => {
      issued = r;
      store.issue(r);
    },
    verify: verifier(store, fetchFn),
  });
  server = createServer((rq, rs) => void paywall(rq, rs, () => rs.end("data")));
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const first = await fetch(url);
  assert.equal(first.status, 402);
  const { requestId } = parsePaymentRequest(await first.json());
  const headers = { [PAYMENT_HEADER]: requestId, [PAYMENT_DEPOSIT_HEADER]: "dep-1" };

  const paid = await fetch(url, { headers });
  assert.equal(paid.status, 200);
  assert.equal(await paid.text(), "data");

  const replay = await fetch(url, { headers });
  assert.equal(replay.status, 402);
});
