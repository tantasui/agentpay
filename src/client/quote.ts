import { isAmount, type PaymentRequest } from "../payment-request.ts";
import { ONECLICK_API, type Token } from "../tokens.ts";
import { formatUnits } from "../units.ts";

// Time to approve, deposit and confirm on Solana before refunds begin.
const MIN_TIME_TO_PAY_MS = 60_000;

export type Quote = {
  depositAddress: string;
  depositMemo?: string;
  /** What the payer sends, in the source token's smallest units. Includes the slippage buffer. */
  amountIn: string;
  minAmountIn?: string;
  amountOut: string;
  /** Kept by 1Click if the swap fails and is refunded, in the source token's smallest units. */
  refundFee?: string;
  timeEstimateSeconds?: number;
  /** Refunds begin here if the swap has not completed. Equal to the request's expiresAt. */
  refundsBeginAt: string;
  /** After this the deposit address goes inactive and funds sent to it may be lost. */
  addressInactiveAt?: string;
};

export type QuoteOptions = {
  request: PaymentRequest;
  /** The token chosen by pickSourceAsset. */
  source: Token;
  /** Payer's address on the source chain. Refunds go here. */
  refundTo: string;
  /** The most the payer will send, in the source token's smallest units. */
  maxAmountIn: string;
  /** What the payer holds of the source token, if known. */
  balance?: string;
  apiKey?: string;
  fetch?: typeof fetch;
  now?: () => number;
};

/**
 * Gets a committed exact-output quote for a payment request, and rejects it if it
 * costs more than the payer allows (MON-83). The quote's deadline is the request's
 * expiresAt. The seller checks that, which ties the payment to this request.
 */
export async function requestQuote(options: QuoteOptions): Promise<Quote> {
  const { request, source, refundTo, maxAmountIn, balance, apiKey } = options;
  const { fetch: fetchFn = fetch, now = Date.now } = options;

  if (!isAmount(maxAmountIn)) throw new Error(`maxAmountIn must be a whole number in smallest units`);
  const left = Date.parse(request.expiresAt) - now();
  if (left < MIN_TIME_TO_PAY_MS) {
    throw new Error(`Payment request expires in ${Math.round(left / 1000)} s, too soon to pay`);
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;
  const res = await fetchFn(`${ONECLICK_API}/v0/quote`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      dry: false,
      swapType: "EXACT_OUTPUT",
      slippageTolerance: 100,
      originAsset: source.assetId,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: request.assetId,
      amount: request.amount,
      recipient: request.recipient,
      recipientType: "DESTINATION_CHAIN",
      refundTo,
      refundType: "ORIGIN_CHAIN",
      deadline: request.expiresAt,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Quote refused: HTTP ${res.status}: ${body.message ?? "no reason given"}`);

  const q = body.quote ?? {};
  if (q.amountOut !== request.amount) {
    throw new Error(`Quote would deliver ${q.amountOut}, not ${request.amount}`);
  }
  if (typeof q.depositAddress !== "string" || !q.depositAddress) {
    throw new Error("Quote has no deposit address");
  }
  if (!isAmount(q.amountIn)) throw new Error(`Quote has an invalid amountIn: ${q.amountIn}`);

  const show = (amount: string) => `${formatUnits(amount, source.decimals)} ${source.symbol}`;
  if (BigInt(q.amountIn) > BigInt(maxAmountIn)) {
    throw new Error(`Quote costs ${show(q.amountIn)}, more than the maximum of ${show(maxAmountIn)}`);
  }
  if (balance !== undefined && BigInt(q.amountIn) > BigInt(balance)) {
    throw new Error(`Quote costs ${show(q.amountIn)}, but the payer holds ${show(balance)}`);
  }

  return {
    depositAddress: q.depositAddress,
    depositMemo: q.depositMemo ?? undefined,
    amountIn: q.amountIn,
    minAmountIn: q.minAmountIn,
    amountOut: q.amountOut,
    refundFee: q.refundFee,
    timeEstimateSeconds: q.timeEstimate,
    refundsBeginAt: request.expiresAt,
    addressInactiveAt: q.deadline,
  };
}
