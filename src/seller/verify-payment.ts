import type { IncomingMessage } from "node:http";
import { PAYMENT_DEPOSIT_HEADER, type PaymentRequest } from "../payment-request.ts";
import { ONECLICK_API } from "../tokens.ts";
import type { RequestStore } from "./request-store.ts";

export type VerifierOptions = {
  store: RequestStore;
  recipient: string;
  assetId: string;
  amount: string;
  /** Base JSON-RPC endpoint. Balance checks read the block before delivery, so it must keep recent state. */
  baseRpcUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
};

type StatusResponse = {
  status?: string;
  quoteResponse?: { quoteRequest?: Record<string, unknown> };
  swapDetails?: { amountOut?: string | null; destinationChainTxHashes?: Array<{ hash: string }> };
};

/**
 * Builds the paywall's `verify` hook (MON-86). The seller never trusts what the payer
 * reports. It asks 1Click about the deposit address itself, checks that the swap paid
 * this seller the price for this request, then checks Base for the funds.
 *
 * Returns false when the payment does not check out. Throws when 1Click or Base
 * cannot be reached, so the paywall answers 500 and the client can retry.
 */
export function createPaymentVerifier(options: VerifierOptions) {
  const { store, recipient, assetId, amount, baseRpcUrl, apiKey } = options;
  const { fetch: fetchFn = fetch, log = console.log } = options;
  const price = BigInt(amount);
  const seller = recipient.toLowerCase();

  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetchFn(baseRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`Base RPC returned ${res.status} for ${method}`);
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`Base RPC ${method} failed: ${body.error.message}`);
    return body.result as T;
  }

  /** How much of the price this transaction delivered to the seller, as far as Base shows. */
  async function delivered(hash: string): Promise<{ wei: bigint } | { problem: string }> {
    const receipt = await rpc<{ status: string; blockNumber: string } | null>("eth_getTransactionReceipt", [hash]);
    if (!receipt) return { problem: `delivery ${hash} is not on Base yet` };
    if (receipt.status !== "0x1") return { problem: `delivery ${hash} failed on Base` };

    const tx = await rpc<{ to: string | null; value: string }>("eth_getTransactionByHash", [hash]);
    if (tx.to?.toLowerCase() === seller && BigInt(tx.value) >= price) return { wei: BigInt(tx.value) };

    // Delivered inside a contract call: compare the seller's balance around that block.
    const block = BigInt(receipt.blockNumber);
    const [after, before] = await Promise.all([
      rpc<string>("eth_getBalance", [recipient, `0x${block.toString(16)}`]),
      rpc<string>("eth_getBalance", [recipient, `0x${(block - 1n).toString(16)}`]),
    ]);
    return { wei: BigInt(after) - BigInt(before) };
  }

  /** Returns why the payment does not check out, or null if it does. */
  async function check(request: PaymentRequest, depositAddress: string): Promise<string | null> {
    const headers: Record<string, string> = apiKey ? { "X-API-Key": apiKey } : {};
    const query = new URLSearchParams({ depositAddress });
    const res = await fetchFn(`${ONECLICK_API}/v0/status?${query}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return "1Click does not know this deposit address";
    if (!res.ok) throw new Error(`GET /v0/status returned ${res.status}`);
    const status = (await res.json()) as StatusResponse;

    if (status.status !== "SUCCESS") return `swap status is ${status.status}`;
    const q = status.quoteResponse?.quoteRequest ?? {};
    if (String(q.recipient).toLowerCase() !== seller) return "swap pays a different recipient";
    if (q.destinationAsset !== assetId) return "swap pays a different asset";
    if (q.swapType !== "EXACT_OUTPUT") return "swap is not exact-output";
    if (q.amount !== amount) return `swap is for ${q.amount}, not ${amount}`;
    if (Date.parse(String(q.deadline)) !== Date.parse(request.expiresAt)) {
      return "swap was quoted for a different request";
    }
    const amountOut = status.swapDetails?.amountOut;
    if (amountOut && BigInt(amountOut) < price) return `swap delivered ${amountOut}, less than ${amount}`;

    const hashes = status.swapDetails?.destinationChainTxHashes ?? [];
    if (hashes.length === 0) return "1Click reports no delivery transaction";
    let problem = "";
    for (const { hash } of hashes) {
      const result = await delivered(hash);
      if ("wei" in result && result.wei >= price) return null;
      problem = "problem" in result ? result.problem : `Base shows ${result.wei} wei arriving, not ${amount}`;
    }
    return problem;
  }

  return async (requestId: string, req: IncomingMessage): Promise<boolean> => {
    const depositAddress = req.headers[PAYMENT_DEPOSIT_HEADER];
    if (typeof depositAddress !== "string" || !depositAddress) {
      log(`payment for ${requestId} refused: no ${PAYMENT_DEPOSIT_HEADER} header`);
      return false;
    }
    const claim = store.claim(requestId, depositAddress);
    if (!claim.ok) {
      log(`payment for ${requestId} refused: ${claim.reason}`);
      return false;
    }
    try {
      const problem = await check(claim.request, depositAddress);
      if (problem) {
        store.release(requestId);
        log(`payment for ${requestId} refused: ${problem}`);
        return false;
      }
      store.confirm(requestId);
      log(`payment for ${requestId} verified on Base`);
      return true;
    } catch (error) {
      store.release(requestId);
      throw error;
    }
  };
}
