import type { PaymentRequest } from "../payment-request.ts";

// A swap that completes just before expiry still needs time for the client to retry.
const DEFAULT_GRACE_MS = 5 * 60 * 1000;

export type Claim = { ok: true; request: PaymentRequest } | { ok: false; reason: string };

type Entry = { request: PaymentRequest; state: "issued" | "verifying" | "served"; depositAddress?: string };

/**
 * Tracks issued payment requests so each is paid for and served once (MON-81).
 * In memory only: a restart forgets issued requests, so their ids are refused.
 *
 * Everything here is synchronous, so a claim cannot interleave with another.
 */
export function createRequestStore(options: { now?: () => number; graceMs?: number } = {}) {
  const { now = Date.now, graceMs = DEFAULT_GRACE_MS } = options;
  const entries = new Map<string, Entry>();
  // Deposit addresses that have paid, or are being checked. Never pruned.
  const usedDeposits = new Set<string>();

  const expired = (request: PaymentRequest) => now() > Date.parse(request.expiresAt) + graceMs;

  function prune() {
    for (const [id, entry] of entries) {
      if (entry.state !== "verifying" && expired(entry.request)) entries.delete(id);
    }
  }

  return {
    issue(request: PaymentRequest): void {
      prune();
      if (entries.has(request.requestId)) throw new Error(`${request.requestId} already issued`);
      entries.set(request.requestId, { request, state: "issued" });
    },

    /** Reserves a request and deposit address while the payment is checked. */
    claim(requestId: string, depositAddress: string): Claim {
      const entry = entries.get(requestId);
      if (!entry) return { ok: false, reason: `request ${requestId} is unknown` };
      if (entry.state === "served") return { ok: false, reason: `request ${requestId} was already served` };
      if (entry.state === "verifying") {
        return { ok: false, reason: `request ${requestId} is being verified` };
      }
      if (expired(entry.request)) return { ok: false, reason: `request ${requestId} has expired` };
      if (usedDeposits.has(depositAddress)) {
        return { ok: false, reason: `deposit address ${depositAddress} was already used` };
      }
      entry.state = "verifying";
      entry.depositAddress = depositAddress;
      usedDeposits.add(depositAddress);
      return { ok: true, request: entry.request };
    },

    /** The payment checked out: the request is served and can never be used again. */
    confirm(requestId: string): void {
      const entry = entries.get(requestId);
      if (entry?.state === "verifying") entry.state = "served";
    },

    /** The payment did not check out: free the request and deposit address. */
    release(requestId: string): void {
      const entry = entries.get(requestId);
      if (entry?.state !== "verifying") return;
      if (entry.depositAddress) usedDeposits.delete(entry.depositAddress);
      entry.state = "issued";
      entry.depositAddress = undefined;
    },

    size: () => entries.size,
  };
}

export type RequestStore = ReturnType<typeof createRequestStore>;
