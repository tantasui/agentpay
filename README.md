# Pay Anything, Anywhere

The checkout layer for agents. Any API charges in the token it wants, and the paying agent uses whatever it holds.

A seller adds middleware that answers with an HTTP 402 and a payment request priced in its own token. A client library lets an agent pay from whatever it holds. NEAR Intents does the cross-chain swap with an exact-output quote and delivers straight to the seller's address. The seller checks its own balance, then serves.

Built for NEAR HACKATHON, Nov 1–14, 2026. Tracks: Unstoppable DeFi, Agent Economy.

**Status:** early. The seller middleware and client library are not built yet. See [NOTES.md](NOTES.md) for what has been tested so far.

## Run the quote spike

Needs Node 23.6 or newer. It sends no funds.

```bash
npm run spike:quote
```

You should see an `amountOut` marked `exact` for each requested amount.
