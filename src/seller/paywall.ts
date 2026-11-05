import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAmount, isEvmAddress, PAYMENT_HEADER, type PaymentRequest } from "../payment-request.ts";
import { fetchTokens } from "../tokens.ts";

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export type PaywallOptions = {
  /** Token and chain the seller is paid in, as named by GET /v0/tokens. */
  symbol: string;
  chain: string;
  /** Price in the token's smallest unit. Must clear the route's minimum: see NOTES.md. */
  amount: string;
  /** Seller's address on `chain`. EVM chains only for now. */
  recipient: string;
  /** How long a request id stays payable. Defaults to 10 minutes. */
  ttlMs?: number;
  /** Called before a request is issued, so it can be stored. If it throws, nothing is issued. */
  onIssue?: (request: PaymentRequest) => void | Promise<void>;
  /** Decides whether a request id has been paid. With no verifier, nothing is ever served. */
  verify?: (requestId: string, req: IncomingMessage) => boolean | Promise<boolean>;
  fetch?: typeof fetch;
};

export type Paywall = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => Promise<void>;

/**
 * Builds middleware that prices one endpoint in one token on one chain. It has a
 * Connect-style signature and is tested on node:http. Bad configuration fails here,
 * at startup.
 */
export async function createPaywall(options: PaywallOptions): Promise<Paywall> {
  const { symbol, chain, amount, recipient, ttlMs = DEFAULT_TTL_MS, onIssue, verify } = options;

  if (!isAmount(amount)) {
    throw new Error(`amount must be a whole number in smallest units, got "${amount}"`);
  }
  if (!isEvmAddress(recipient)) throw new Error(`recipient is not an EVM address: "${recipient}"`);
  if (!(ttlMs > 0)) throw new Error(`ttlMs must be positive, got ${ttlMs}`);

  const tokens = await fetchTokens(options.fetch);
  const token = tokens.find((t) => t.symbol === symbol && t.blockchain === chain);
  if (!token) throw new Error(`${symbol} on ${chain} is not supported by NEAR Intents`);

  return async (req, res, next) => {
    let body: { error: string; payment?: PaymentRequest };
    try {
      const claimed = req.headers[PAYMENT_HEADER];
      if (typeof claimed === "string" && verify && (await verify(claimed, req))) {
        next();
        return;
      }

      const payment: PaymentRequest = {
        version: 1,
        requestId: randomUUID(),
        amount,
        assetId: token.assetId,
        chain,
        symbol,
        decimals: token.decimals,
        recipient,
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      };
      await onIssue?.(payment);
      body = { error: "payment_required", payment };
      res.statusCode = 402;
    } catch (error) {
      // Fail closed, and keep internal details out of the response.
      console.error("paywall error:", error);
      body = { error: "internal_error" };
      res.statusCode = 500;
    }
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(body));
  };
}
