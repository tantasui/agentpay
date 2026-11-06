// Runs each step of a payment against mainnet without moving any funds:
//   MON-83  a real committed quote, and a max-amount rejection
//   MON-84  the real deposit transaction, simulated on Solana from a real USDC
//           holder's address. Nothing is signed or sent.
//   MON-86  the seller's verifier on that unpaid swap, which must refuse it
//   Base    the RPC calls the verifier makes, on a recent real transaction
//
// The quote uses placeholder addresses from the 1Click spec. Never deposit to it.
//
// Usage: npm run spike:dryrun

import type { IncomingMessage } from "node:http";
import { address, createNoopSigner, createSolanaRpc, type Address } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { buildDepositInstructions } from "../src/client/deposit.ts";
import { requestQuote } from "../src/client/quote.ts";
import { createSolanaChain } from "../src/client/solana-chain.ts";
import { PAYMENT_DEPOSIT_HEADER, type PaymentRequest } from "../src/payment-request.ts";
import { createRequestStore } from "../src/seller/request-store.ts";
import { createPaymentVerifier } from "../src/seller/verify-payment.ts";
import { fetchTokens } from "../src/tokens.ts";

const SOLANA_RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const BASE_RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const SELLER = "0x2527D02599Ba641c19FEa793cD0F167589a0f10D";
const PAYER = "13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

const tokens = await fetchTokens();
const usdc = tokens.find((t) => t.symbol === "USDC" && t.blockchain === "sol")!;
const eth = tokens.find((t) => t.symbol === "ETH" && t.blockchain === "base")!;
const request: PaymentRequest = {
  version: 1,
  requestId: "dry-run",
  amount: "200000000000000",
  assetId: eth.assetId,
  chain: "base",
  symbol: "ETH",
  decimals: 18,
  recipient: SELLER,
  expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
};

console.log("--- MON-83 quote");
try {
  await requestQuote({ request, source: usdc, refundTo: PAYER, maxAmountIn: "100000" });
  console.log("FAIL: a $0.10 maximum was accepted");
} catch (error) {
  console.log(`rejected as expected: ${(error as Error).message}`);
}
const quote = await requestQuote({ request, source: usdc, refundTo: PAYER, maxAmountIn: "1000000" });
console.log(`accepted: pay ${quote.amountIn} for exactly ${quote.amountOut}, refund fee ${quote.refundFee}`);
console.log(`refunds begin ${quote.refundsBeginAt}, address inactive ${quote.addressInactiveAt}`);

console.log("--- MON-84 deposit, simulated");
const rpc = createSolanaRpc(SOLANA_RPC);
const chain = createSolanaChain(SOLANA_RPC);
const mint = address(usdc.contractAddress!);
// Find a wallet holding USDC and some SOL from recent USDC transfers. The public
// RPC throttles getTokenLargestAccounts, so this avoids it.
let holder: Address | undefined = process.env.SIMULATE_FROM ? address(process.env.SIMULATE_FROM) : undefined;
const recent = holder ? [] : await rpc.getSignaturesForAddress(mint, { limit: 40 }).send();
for (const { signature } of recent) {
  const tx = await rpc
    .getTransaction(signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 })
    .send()
    .catch(() => null);
  for (const balance of tx?.meta?.postTokenBalances ?? []) {
    if (balance.mint !== mint || !balance.owner) continue;
    if (BigInt(balance.uiTokenAmount.amount) < BigInt(quote.amountIn)) continue;
    const wallet = (await rpc.getAccountInfo(balance.owner, { encoding: "base64" }).send()).value;
    if (wallet?.owner === SYSTEM_PROGRAM && wallet.lamports > 10_000_000n) {
      holder = balance.owner;
      break;
    }
  }
  if (holder) break;
}
if (!holder) throw new Error("No USDC holder with SOL found in recent transfers. Set SIMULATE_FROM to one.");
const depositAddress = address(quote.depositAddress);
const [depositAta] = await findAssociatedTokenPda({ owner: depositAddress, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
console.log(`mint is a classic SPL token: ${(await chain.owner(mint)) === TOKEN_PROGRAM_ADDRESS}`);
console.log(`deposit token account exists: ${await chain.exists(depositAta)}`);
console.log(`token account rent: ${await chain.rentExemptMinimum(165)} lamports`);
const instructions = await buildDepositInstructions({
  source: usdc,
  signer: createNoopSigner(holder),
  depositAddress,
  amount: quote.amountIn,
});
const sim = await chain.simulate(instructions, holder);
// The token program on mainnet no longer logs instruction names, so count the
// top-level instructions that ran instead.
const ran = (sim.logs ?? []).filter((line) => line.endsWith(" invoke [1]")).map((line) => line.split(" ")[1]);
const ok = !sim.err && ran.length === instructions.length && ran.every((p, i) => p === instructions[i].programAddress);
console.log(`simulated from a real USDC holder: ${ok ? "ok" : `FAILED ${JSON.stringify(sim.err)}`}`);
console.log(`  ran: ${ran.join(", ")}`);

console.log("--- MON-86 verifier on the unpaid swap");
const store = createRequestStore();
store.issue(request);
const verify = createPaymentVerifier({
  store,
  recipient: SELLER,
  assetId: eth.assetId,
  amount: request.amount,
  baseRpcUrl: BASE_RPC,
});
const served = await verify("dry-run", { headers: { [PAYMENT_DEPOSIT_HEADER]: quote.depositAddress } } as unknown as IncomingMessage);
console.log(`served: ${served} (must be false)`);

console.log("--- Base RPC calls the verifier makes");
const call = async (method: string, params: unknown[]) => {
  const res = await fetch(BASE_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
};
const latest = BigInt(await call("eth_blockNumber", []));
// Most Base transactions are contract calls, so look back for a plain ETH transfer.
type BaseTx = { hash: string; to: string | null; value: string };
let tx: BaseTx | undefined;
for (let back = 5n; !tx && back < 25n; back++) {
  const block = await call("eth_getBlockByNumber", [`0x${(latest - back).toString(16)}`, true]);
  tx = (block.transactions as BaseTx[]).find((t) => t.to && BigInt(t.value) > 0n);
}
if (!tx) throw new Error("No ETH transfer found in the last 25 Base blocks");
const receipt = await call("eth_getTransactionReceipt", [tx.hash]);
const byHash = await call("eth_getTransactionByHash", [tx.hash]);
console.log(`receipt status ${receipt.status}, block ${BigInt(receipt.blockNumber)}, tx.to set ${!!byHash.to}, value ${BigInt(byHash.value)}`);
for (const age of [1n, 100n, 2000n]) {
  const at = `0x${(BigInt(receipt.blockNumber) - age).toString(16)}`;
  try {
    await call("eth_getBalance", [byHash.to, at]);
    console.log(`balance ${age} blocks back (${Number(age) * 2} s): ok`);
  } catch (error) {
    console.log(`balance ${age} blocks back (${Number(age) * 2} s): ${(error as Error).message}`);
  }
}
