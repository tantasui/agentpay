# Build notes

Findings from testing the live 1Click API. Tested Nov 5, 2026, with no API key.

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
4. **Dry quotes have no deadline (MON-78, demo step 3).** They also have no deposit address. Show the payer the deadline the client requested, or get it from a committed quote.
5. **The max-amount guard should check `amountIn` (MON-83).** `maxAmountIn` is not returned. `amountIn` includes the slippage buffer, and the API documents that any excess is refunded to `refundTo`.

### Question for the team

**The demo agent cannot hold only Solana USDC (MON-84, MON-89).** The deposit is a Solana transaction, so the agent also needs SOL for the fee. It also needs SOL for token account rent if the deposit address has no USDC account yet. Either fund the agent with a little SOL and say so in the demo, or sponsor the fee. This comes from the transaction structure and has not been tested on-chain.

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
