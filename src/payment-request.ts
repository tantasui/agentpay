// The body of a 402, shared by the seller and the client. The client treats it as
// untrusted: a seller can send anything.

export type PaymentRequest = {
  version: 1;
  requestId: string;
  /** Exact amount the seller must receive, in the asset's smallest unit. */
  amount: string;
  /** 1Click asset id from GET /v0/tokens. */
  assetId: string;
  chain: string;
  symbol: string;
  decimals: number;
  recipient: string;
  /** ISO timestamp. The seller refuses this request id after it. */
  expiresAt: string;
};

/** The client sends this header, set to the request id, when it retries after paying. */
export const PAYMENT_HEADER = "x-payment-request-id";

export const isAmount = (value: unknown): value is string =>
  typeof value === "string" && /^[1-9]\d*$/.test(value);

export const isEvmAddress = (value: unknown): value is string =>
  typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export function parsePaymentRequest(body: unknown): PaymentRequest {
  const payment = (body as { payment?: unknown } | null)?.payment;
  if (typeof payment !== "object" || payment === null) {
    throw new Error("Response does not contain a payment request");
  }
  const p = payment as Record<string, unknown>;

  const fail = (field: string): never => {
    throw new Error(`Invalid payment request: bad ${field}`);
  };
  if (p.version !== 1) fail("version");
  if (!isText(p.requestId)) fail("requestId");
  if (!isAmount(p.amount)) fail("amount");
  if (!isText(p.assetId)) fail("assetId");
  if (!isText(p.chain)) fail("chain");
  if (!isText(p.symbol)) fail("symbol");
  if (!Number.isInteger(p.decimals) || (p.decimals as number) < 0) fail("decimals");
  if (!isEvmAddress(p.recipient)) fail("recipient");

  const expiresAt = isText(p.expiresAt) ? Date.parse(p.expiresAt) : NaN;
  if (Number.isNaN(expiresAt)) fail("expiresAt");
  if (expiresAt <= Date.now()) throw new Error(`Payment request expired at ${p.expiresAt}`);

  return p as PaymentRequest;
}
