# Build notes

Findings from testing the live 1Click API, Solana and Base. Tested Nov 5 and 6, 2026, with no API key.

**Connection timeouts:** connecting to 1Click takes 240 to 390 ms from here. Node gives up on each connection attempt after 250 ms by default, so `fetch` fails with `ETIMEDOUT` while curl works. Every npm script passes `--network-family-autoselection-attempt-timeout=2000`. Do the same when running anything with `node` directly.

## MON-80 and MON-82: the 402 and the source asset

An unpaid request gets this response:

```json
{
  "error": "payment_required",
  "payment": {
    "version": 1,
    "requestId": "8437a8f4-68eb-400d-9da4-016064139eeb",
    "amount": "200000000000000",
    "assetId": "nep141:base.omft.near",
    "chain": "base",
    "symbol": "ETH",
    "decimals": 18,
    "recipient": "0x2527D02599Ba641c19FEa793cD0F167589a0f10D",
    "expiresAt": "2026-11-05T14:02:16.435Z"
  }
}
```

After paying, the client retries with the request id in the `x-payment-request-id` header.

After paying, the client retries with two headers: `x-payment-request-id` and `x-payment-deposit-address`, the 1Click deposit address it paid into.

### What the client does

- **Holdings:** `listSolanaHoldings` reads SOL and SPL tokens. Solana is the only chain so far. It keeps 0.005 SOL back for fees, so that SOL is never offered as a source.
- **Choice:** `pickSourceAsset` picks the most valuable supported holding worth at least 1.05 times the price. It uses token list prices as a filter only. The quote decides the real cost (MON-83).

## MON-81, MON-83, MON-84, MON-86: from 402 to a verified payment

### How a payment is matched to a request

A balance check alone cannot tell who paid, so the seller ties each payment to one request:

1. **The client sets the quote's `deadline` to the request's `expiresAt`.** That is also the right deadline: refunds begin when the seller stops accepting the request.
2. **The seller keeps `expiresAt` unique** across requests, to the millisecond.
3. **The seller asks 1Click about the deposit address itself.** The status response echoes the original quote request. The seller requires `SUCCESS`, its own address as recipient, its asset, `EXACT_OUTPUT`, the exact price, and a `deadline` equal to this request's `expiresAt`.
4. **The seller checks Base.** The delivery transaction must have succeeded and paid at least the price. A direct transfer is checked by its value. A delivery inside a contract call is checked by the seller's balance change in that block.
5. **Each request id and each deposit address is used once.** Two retries arriving together cannot both be served.

Someone who copies another payer's deposit address fails step 3, because that quote's deadline matches the other payer's request.

`sessionId` would have been cleaner, but the status response does not echo it.

### The pieces

- **MON-81, `src/seller/request-store.ts`:** issued requests, in memory. A request id is served once. Expired ids are refused after a 5-minute grace period, so a swap that completes just before expiry can still be served. A restart forgets everything, so old ids are refused.
- **MON-83, `src/client/quote.ts`:** `requestQuote` gets a committed exact-output quote. It rejects a quote whose `amountIn` exceeds the payer's maximum or balance, or that would not deliver the exact price. It refuses requests with less than a minute left.
- **MON-84, `src/client/deposit.ts`:** `approveAndDeposit` checks the payer has the SOL for fees and token account rent before asking, then asks for approval, then sends. Nothing is sent without approval. `askInTerminal` approves only when a human types `yes`. It returns `sentAt` for `pollSwapStatus`. The key comes from `SOLANA_PRIVATE_KEY`. Only SOL and classic SPL tokens are supported.
- **MON-86, `src/seller/verify-payment.ts`:** `createPaymentVerifier` builds the paywall's `verify` hook from the steps above. It returns false when a payment does not check out, and throws when 1Click or Base cannot be reached, so the client gets a 500 and can retry.

### Decided by default, open to change

- **The agent holds a little SOL.** The client refuses clearly, before approval, if it cannot pay fees and rent. It does not sponsor fees.

### Tested live, without moving funds

`npm run spike:dryrun` runs each step against mainnet:

- **Quote:** a $0.10 maximum is rejected, and a real quote is accepted.
- **Deposit:** the real transaction, simulated from a real USDC holder's address, creates the deposit address's token account and transfers the USDC.
- **Verifier:** it refuses an unpaid swap with `swap status is PENDING_DEPOSIT`.
- **Base RPC:** receipts, transactions, and balances from 2,000 blocks back (over an hour) all work on the public endpoint.

### Not tested until a real swap (MON-79)

- **How 1Click delivers ETH on Base.** The verifier handles a direct transfer and a contract-call delivery, but which one happens is unknown.
- **The echoed quote request on a completed swap.** It was checked on pending swaps only.
- **Sending and confirming a real deposit.** Only the simulation has run.

### Known limits

- **1Click is trusted** to say which swap paid which recipient. The funds themselves are checked on Base.
- **Contract-call deliveries are checked by balance change,** so other ETH arriving in the same block also counts.
- **A verified payment is used up before the response is sent.** If the seller's handler then fails, the payer is not served.

## MON-85: polling swap status

`pollSwapStatus` in `src/client/poll-status.ts` polls until a terminal status and logs the elapsed time. Watch a swap with `npm run spike:poll -- <depositAddress>`.

- **Terminal:** `SUCCESS`, `REFUNDED`, `FAILED`, `INCOMPLETE_DEPOSIT`. Any other status keeps polling, including `KNOWN_DEPOSIT_TX` and statuses we do not recognise.
- **`INCOMPLETE_DEPOSIT`:** the payment has failed, but the spec says the refund comes by the deadline, so the money can arrive later.
- **Failed checks:** network errors, 429s, 5xx and bad JSON are retried with backoff. 400, 401, 403 and 404 stop at once.
- **Timeout:** throws `SwapStatusTimeout` after 10 minutes by default. The swap may still finish, so the caller must not pay again.
- **`SUCCESS` is not proof of payment.** The seller still checks its own address (MON-86).
- **Naming a swap:** use the deposit address. The `correlationId` in a status response changes on every call, so it cannot identify a swap. The status response did not echo the quote's id either.
- **Elapsed time:** pass `startedAt` as the time the deposit was sent. `approveAndDeposit` returns it as `sentAt`.

Tested live: a pending swap stays pending and times out, and an unknown address stops with a 404. Status works with no API key. **No real swap has reached a terminal status yet.** Those paths are tested with fake responses only, so check them on the first real swap (MON-79).

## MON-78: exact-output quote, Solana USDC to Base ETH

**Result: `amountOut` equalled the requested amount, to the wei, on every quote the API accepted.** That covers 0.00011, 0.00012, 0.0002 and 0.001 ETH. A committed quote also matched. Reproduce with `npm run spike:quote`.

| Amount out (ETH) | Quote type | amountIn (USDC) | minAmountIn (USDC) | timeEstimate |
|---|---|---|---|---|
| 0.00011 | dry | 0.267719 | 0.265041 | 24 s |
| 0.0002 | dry | 0.485673 | 0.480816 | 24 s |
| 0.0002 | committed | 0.485583 | 0.480727 | 24 s |
| 0.001 | dry | 2.42262 | 2.398393 | 24 s |

`timeEstimate` is the API's estimate, not a measurement. MON-79 and MON-90 measure the real time.

No swap has been run. These results show what the API quotes, not what a seller receives.

### What this changes for the build

1. **There is a minimum price (MON-80, MON-89).** Below about 0.000106 ETH (about $0.25), the quote fails with `Amount is too low for bridge, try at least <wei>`. The minimum moved from 0.000104 to 0.000106 ETH within minutes. Price the demo endpoint well above it: 0.0002 ETH worked. The client should show this error clearly.
2. **Two different deadlines (MON-85, MON-87).** Every committed quote returned a deadline exactly 72 hours after the one requested, for requests of 2 minutes, 10 minutes, 1 hour and 24 hours. The OpenAPI spec defines them differently:
   - The `deadline` in the request is when refunds begin if the swap has not completed.
   - The `deadline` in the response is when the deposit address goes inactive and "funds may be lost".
3. **The expired-quote demo is untested (MON-87, demo step 7).** Whether a refund arrives soon after the requested deadline is unknown. Testing it needs a small real deposit, confirmed by a human. Do this early, because a 72-hour wait would not fit the demo.
4. **A refund costs about $0.25 (MON-84, MON-87, demo step 7).** The status response shows `refundFee: 251578`, which the spec defines as the fee for refunding in the origin asset, so 0.25 USDC. It was the same on quotes of $0.48, $2.40 and $24. On a $0.48 payment the payer would get back about $0.23. This is what the API reports: no real refund has been run. Show this cost before approval, and say "refunded minus the fee" in the demo. A higher price makes the fee a smaller share.
5. **Dry quotes have no deadline (MON-78, demo step 3).** They also have no deposit address. Show the payer the deadline the client requested, or get it from a committed quote.
6. **The max-amount guard should check `amountIn` (MON-83).** `maxAmountIn` is not returned. `amountIn` includes the slippage buffer, and the API documents that any excess is refunded to `refundTo`.

### The demo agent needs some SOL (MON-84, MON-89)

The deposit is a Solana transaction, so the agent needs SOL for the fee. It also pays rent to create the deposit address's USDC account: 1,488,440 lamports, about 0.0015 SOL, as of Nov 6. The 2,039,280 lamports noted on Nov 5 was an older account's balance, not the current rent. The client checks this before asking for approval. Say in the demo that the agent holds a little SOL for fees.

## MON-76: near-intents skill compared with the API

The copy installed on this machine dates from June and is behind upstream. These points were checked against upstream `near/agent-skills` and the live OpenAPI spec. Trust the spec where they disagree.

| Topic | Skill says | OpenAPI spec or live API |
|---|---|---|
| Auth (MON-77) | `Authorization: Bearer` | `X-API-Key` recommended, JWT marked legacy |
| Required fields | `deadline`, `slippageTolerance`, `depositType`, `refundType` and `recipientType` optional | All required in the spec |
| Deadline | About 10 minutes | Set by the request, response adds 72 hours (see above) |
| `maxAmountIn` | Returned for `EXACT_OUTPUT` | Not in the spec, not returned |
| `deadline` on dry quotes | Listed in the response | Not returned |
| `recipient` | No restriction noted | `0x…dEaD` was rejected with `recipient is not valid` |

Other things to know:

- **Statuses:** `KNOWN_DEPOSIT_TX` is a non-terminal status. It is in upstream and the spec, but not in the June copy.
- **Fee:** without a key, upstream says 0.25%. The June copy says 0.1%. Neither was measured.
- **Auth with a key:** not tested. MON-77 covers it. Quotes, including committed ones, worked with no key.
