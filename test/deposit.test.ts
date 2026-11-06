import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { address, getBase58Decoder, type Address, type Instruction } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { approveAndDeposit, buildDepositInstructions, formatApproval, type SolanaChain } from "../src/client/deposit.ts";
import type { Quote } from "../src/client/quote.ts";
import { loadSolanaSigner } from "../src/client/solana-signer.ts";
import type { PaymentRequest } from "../src/payment-request.ts";
import { SELLER, TOKENS } from "./fixtures.ts";

const USDC = TOKENS[1];
const SOL = TOKENS[2];
const DEPOSIT = address("13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK");
const NOW = Date.parse("2026-11-06T12:00:00.000Z");

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

const QUOTE: Quote = {
  depositAddress: DEPOSIT,
  amountIn: "485583",
  minAmountIn: "480727",
  amountOut: REQUEST.amount,
  refundFee: "238733",
  timeEstimateSeconds: 24,
  refundsBeginAt: REQUEST.expiresAt,
  addressInactiveAt: "2026-11-09T12:10:00.000Z",
};

function secret64(): Uint8Array {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const priv = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return new Uint8Array([...priv, ...pub]);
}

function fakeChain(options: { lamports?: bigint; ataExists?: boolean; mintOwner?: Address } = {}) {
  const sent: Instruction[][] = [];
  const chain: SolanaChain = {
    lamports: async () => options.lamports ?? 10_000_000n,
    exists: async () => options.ataExists ?? false,
    owner: async () => options.mintOwner ?? TOKEN_PROGRAM_ADDRESS,
    rentExemptMinimum: async () => 2_039_280n,
    send: async (instructions) => {
      sent.push(instructions);
      return "Sig111";
    },
  };
  return { chain, sent };
}

function submitFetch(status = 200) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) });
    return new Response("{}", { status });
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

async function run(
  overrides: Partial<Parameters<typeof approveAndDeposit>[0]> = {},
  chainOptions: Parameters<typeof fakeChain>[0] = {},
) {
  const { chain, sent } = fakeChain(chainOptions);
  const submit = submitFetch();
  const logs: string[] = [];
  const asked: string[] = [];
  const signer = await loadSolanaSigner(JSON.stringify([...secret64()]));
  const result = approveAndDeposit({
    quote: QUOTE,
    source: USDC,
    request: REQUEST,
    signer,
    chain,
    approve: async (summary) => {
      asked.push(formatApproval(summary));
      return true;
    },
    fetch: submit.fetch,
    now: () => NOW,
    log: (line) => logs.push(line),
    ...overrides,
  });
  return { result, sent, submit, logs, asked };
}

test("sends nothing when the payer declines", async () => {
  const { result, sent, submit } = await run({ approve: async () => false });
  await assert.rejects(result, /declined/);
  assert.equal(sent.length, 0);
  assert.equal(submit.calls.length, 0);
});

test("after approval, sends the deposit, logs its id and tells 1Click", async () => {
  const { result, sent, submit, logs } = await run();
  const { signature, sentAt } = await result;
  assert.equal(signature, "Sig111");
  assert.equal(sentAt, NOW);
  assert.equal(sent.length, 1);
  assert.ok(logs.includes("deposit sent: Sig111"));
  assert.deepEqual(submit.calls, [
    { url: "https://1click.chaindefuser.com/v0/deposit/submit", body: { txHash: "Sig111", depositAddress: DEPOSIT } },
  ]);
});

test("shows the payer the cost, what the seller gets, the refund terms and the fee", async () => {
  const { result, asked } = await run();
  await result;
  const text = asked[0];
  assert.match(text, /Pay 0\.485583 USDC/);
  assert.match(text, /Seller receives exactly 0\.0002 ETH on base at 0x2527D02599Ba641c19FEa793cD0F167589a0f10D/);
  assert.match(text, /about 24 s/);
  assert.match(text, /refunds begin at 2026-11-06T12:10:00\.000Z/);
  assert.match(text, /1Click keeps about 0\.238733 USDC/);
});

test("refuses before asking for approval when there is not enough SOL for fees and rent", async () => {
  const { result, asked, sent } = await run({}, { lamports: 1_000_000n });
  await assert.rejects(result, /needs 0\.00204428 SOL for fees and rent, holds 0\.001 SOL/);
  assert.equal(asked.length, 0);
  assert.equal(sent.length, 0);
});

test("needs no rent when the deposit address already has a token account", async () => {
  const { result } = await run({}, { lamports: 5_000n, ataExists: true });
  assert.equal((await result).signature, "Sig111");
});

test("paying in SOL needs the amount as well as the fee", async () => {
  const quote = { ...QUOTE, amountIn: "5000000" };
  const { result } = await run({ source: SOL, quote }, { lamports: 5_004_999n });
  await assert.rejects(result, /needs 0\.005005 SOL/);
});

test("refuses tokens that are not classic SPL tokens", async () => {
  const { result } = await run({}, { mintOwner: address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") });
  await assert.rejects(result, /only classic SPL tokens/);
});

test("refuses to deposit if approval took until refunds are about to begin", async () => {
  let clock = NOW;
  const { result, sent } = await run({
    now: () => clock,
    approve: async () => {
      clock = Date.parse(REQUEST.expiresAt) - 10_000;
      return true;
    },
  });
  await assert.rejects(result, /too close to the refund time/);
  assert.equal(sent.length, 0);
});

test("a failed notice to 1Click does not fail the payment", async () => {
  const failing = submitFetch(500);
  const { result, logs } = await run({ fetch: failing.fetch });
  assert.equal((await result).signature, "Sig111");
  assert.ok(logs.some((l) => /could not notify 1Click/.test(l)));
});

test("builds an idempotent token account creation and a checked transfer for SPL tokens", async () => {
  const signer = await loadSolanaSigner(JSON.stringify([...secret64()]));
  const instructions = await buildDepositInstructions({ source: USDC, signer, depositAddress: DEPOSIT, amount: "485583" });
  assert.equal(instructions.length, 2);
  assert.equal(instructions[0].programAddress, "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  assert.equal(instructions[1].programAddress, TOKEN_PROGRAM_ADDRESS);
});

test("builds one system transfer for SOL", async () => {
  const signer = await loadSolanaSigner(JSON.stringify([...secret64()]));
  const instructions = await buildDepositInstructions({ source: SOL, signer, depositAddress: DEPOSIT, amount: "5000000" });
  assert.equal(instructions.length, 1);
  assert.equal(instructions[0].programAddress, SYSTEM_PROGRAM_ADDRESS);
});

test("loads a key as a JSON byte array or as base58, to the same address", async () => {
  const bytes = secret64();
  const fromJson = await loadSolanaSigner(JSON.stringify([...bytes]));
  const fromBase58 = await loadSolanaSigner(getBase58Decoder().decode(bytes));
  assert.equal(fromJson.address, fromBase58.address);
  await assert.rejects(loadSolanaSigner("not a key"), /SOLANA_PRIVATE_KEY/);
  await assert.rejects(loadSolanaSigner("[1,2,3]"), /64 bytes/);
});
