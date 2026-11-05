# Pay Anything, Anywhere

The checkout layer for agents. Any API charges in the token it wants, and the paying agent uses whatever it holds.

A seller adds middleware that answers with an HTTP 402 and a payment request priced in its own token. A client library lets an agent pay from whatever it holds. NEAR Intents does the cross-chain swap with an exact-output quote and delivers straight to the seller's address. The seller checks its own balance, then serves.

Built for NEAR HACKATHON, Nov 1–14, 2026. Tracks: Unstoppable DeFi, Agent Economy.

**Status:** early. The seller's 402 and the client's choice of source asset work. Payment verification, the swap and the deposit are not built yet. See [NOTES.md](NOTES.md) for what has been tested so far.

## Run the quote spike

Needs Node 23.6 or newer. It sends no funds.

```bash
npm run spike:quote
```

You should see an `amountOut` marked `exact` for each requested amount.

## Try the 402

```bash
SELLER_ADDRESS=0xYourBaseAddress npm run spike:paywall
curl -i http://localhost:4020/paid
```

You should see `402 Payment Required` and a JSON payment request.

## Run the tests

```bash
npm install
npm test
npm run typecheck
```
