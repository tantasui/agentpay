import { ONECLICK_API } from "../tokens.ts";

// INCOMPLETE_DEPOSIT ends the payment, but the money can still be on its way back:
// the spec says a short deposit is refunded by the deadline.
const TERMINAL = new Set(["SUCCESS", "REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"]);

// Retrying cannot fix these. Anything else, such as a 429 or a 5xx, is retried.
const FATAL_STATUS_CODES = new Set([400, 401, 403, 404]);

const MAX_BACKOFF_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;

export type SwapDetails = {
  amountIn?: string | null;
  amountOut?: string | null;
  depositedAmount?: string | null;
  refundedAmount?: string | null;
  refundReason?: string | null;
  refundFee?: string | null;
  originChainTxHashes?: Array<{ hash: string; explorerUrl: string }>;
  destinationChainTxHashes?: Array<{ hash: string; explorerUrl: string }>;
};

export type SwapResult = {
  status: string;
  elapsedMs: number;
  /** Identifies the swap. The API's correlationId changes on every response. */
  depositAddress: string;
  details: SwapDetails;
};

export type PollOptions = {
  depositAddress: string;
  /** Required if the quote returned one. */
  depositMemo?: string;
  apiKey?: string;
  /** When the deposit was sent, so elapsed time covers the whole swap. Defaults to now. */
  startedAt?: number;
  intervalMs?: number;
  /** How long to keep checking. Defaults to 10 minutes. */
  timeoutMs?: number;
  log?: (line: string) => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/** We stopped checking. This says nothing about the swap, which may still finish. */
export class SwapStatusTimeout extends Error {
  readonly lastStatus: string | null;
  readonly elapsedMs: number;

  constructor(lastStatus: string | null, elapsedMs: number) {
    super(
      `No terminal status after ${seconds(elapsedMs)} (last status: ${lastStatus ?? "unknown"}). ` +
        "The swap may still complete. Do not pay again: check the status again first.",
    );
    this.name = "SwapStatusTimeout";
    this.lastStatus = lastStatus;
    this.elapsedMs = elapsedMs;
  }
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * Polls until the swap reaches a terminal status and logs the elapsed time.
 *
 * SUCCESS is what 1Click reports, not proof of payment. The seller still checks
 * its own address before serving (MON-86).
 */
export async function pollSwapStatus(options: PollOptions): Promise<SwapResult> {
  const {
    depositAddress,
    depositMemo,
    apiKey,
    intervalMs = 2_000,
    timeoutMs = 10 * 60 * 1000,
    log = console.log,
    fetch: fetchFn = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
  } = options;

  const pollStart = now();
  const startedAt = options.startedAt ?? pollStart;
  const giveUpAt = pollStart + timeoutMs;
  const elapsed = () => now() - startedAt;

  const query = new URLSearchParams({ depositAddress });
  if (depositMemo) query.set("depositMemo", depositMemo);
  const url = `${ONECLICK_API}/v0/status?${query}`;
  const headers: Record<string, string> = apiKey ? { "X-API-Key": apiKey } : {};

  let lastStatus: string | null = null;
  let delay = intervalMs;

  while (true) {
    let body: { status?: unknown; swapDetails?: SwapDetails } | null = null;
    try {
      const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (FATAL_STATUS_CODES.has(res.status)) {
        log(`swap ${depositAddress} status check failed with HTTP ${res.status} after ${seconds(elapsed())}`);
        throw new FatalStatusError(`GET /v0/status returned ${res.status}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.json();
      if (typeof body?.status !== "string") throw new Error("response has no status");
      delay = intervalMs;
    } catch (error) {
      if (error instanceof FatalStatusError) throw error;
      // A failed check says nothing about the swap, so keep going until the timeout.
      log(`status check failed, will retry: ${(error as Error).message}`);
      body = null;
      delay = Math.min(delay * 2, MAX_BACKOFF_MS);
    }

    if (body) {
      const status = body.status as string;
      if (status !== lastStatus) log(`swap ${depositAddress} ${status} after ${seconds(elapsed())}`);
      lastStatus = status;

      if (TERMINAL.has(status)) {
        return {
          status,
          elapsedMs: elapsed(),
          depositAddress,
          details: body.swapDetails ?? {},
        };
      }
    }

    const remaining = giveUpAt - now();
    if (remaining <= 0) {
      log(`swap ${depositAddress} gave up after ${seconds(elapsed())}, last status ${lastStatus ?? "unknown"}`);
      throw new SwapStatusTimeout(lastStatus, elapsed());
    }
    await sleep(Math.min(delay, remaining));
  }
}

class FatalStatusError extends Error {}
