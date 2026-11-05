# Build notes

Findings from testing the live 1Click API. Tested Nov 5, 2026, with no API key.

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

### Hooks for MON-81 and MON-86

`createPaywall` in `src/seller/paywall.ts` takes two optional functions. Neither has a real implementation yet.

- **`onIssue(request)`:** called before a request is issued, so MON-81 can store it. If it throws, the seller answers 500 and issues nothing.
- **`verify(requestId, req)`:** decides whether a request id has been paid. Return true to serve. If it throws, the seller answers 500 and serves nothing.

With no `verify`, nothing is ever served, so today every request gets a 402.

### Open: matching a payment to a request

A balance check alone cannot tell who paid. Two requests at the same price look identical, so one agent could claim another's payment. Settle this before building MON-86.

### What the client does

- **Holdings:** `listSolanaHoldings` reads SOL and SPL tokens. Solana is the only chain so far. It keeps 0.005 SOL back for fees, so that SOL is never offered as a source.
- **Choice:** `pickSourceAsset` picks the most valuable supported holding worth at least 1.05 times the price. It uses token list prices as a filter only. The quote decides the real cost (MON-83).
- **Not checked:** whether the wallet has enough SOL to send an SPL deposit. A wallet with USDC and no SOL is still chosen, and the deposit would then fail (MON-84).

## MON-85: polling swap status

`pollSwapStatus` in `src/client/poll-status.ts` polls until a terminal status and logs the elapsed time. Watch a swap with `npm run spike:poll -- <depositAddress>`.

- **Terminal:** `SUCCESS`, `REFUNDED`, `FAILED`, `INCOMPLETE_DEPOSIT`. Any other status keeps polling, including `KNOWN_DEPOSIT_TX` and statuses we do not recognise.
- **`INCOMPLETE_DEPOSIT`:** the payment has failed, but the spec says the refund comes by the deadline, so the money can arrive later.
- **Failed checks:** network errors, 429s, 5xx and bad JSON are retried with backoff. 400, 401, 403 and 404 stop at once.
- **Timeout:** throws `SwapStatusTimeout` after 10 minutes by default. The swap may still finish, so the caller must not pay again.
- **`SUCCESS` is not proof of payment.** The seller still checks its own address (MON-86).
- **Naming a swap:** use the deposit address. The `correlationId` in a status response changes on every call, so it cannot identify a swap. The status response did not echo the quote's id either.
- **Elapsed time:** pass `startedAt` as the time the deposit was sent. MON-84 and MON-88 should do this, or the time leaves out the deposit.

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

### Question for the team

**The demo agent cannot hold only Solana USDC (MON-84, MON-89).** The deposit is a Solana transaction, so the agent also needs SOL for the fee. It also needs SOL for token account rent if the deposit address has no USDC account yet. That rent is 2,039,280 lamports, about 0.002 SOL or $0.20, which is close to the price of the demo call. Either fund the agent with a little SOL and say so in the demo, or sponsor the fee. This comes from the transaction structure and has not been tested on-chain.

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
