// MON-82: call a paid endpoint, read the 402, and choose what to pay from. Reads
// public chain data only. It requests no quote and sends nothing.
//
// Usage: npm run spike:read402 -- <paid url> <solana address>

import { listSolanaHoldings } from "../src/client/holdings.ts";
import { pickSourceAsset } from "../src/client/pick-source.ts";
import { parsePaymentRequest } from "../src/payment-request.ts";
import { fetchTokens } from "../src/tokens.ts";

const [url, owner] = process.argv.slice(2);
if (!url || !owner) throw new Error("Usage: read-402 <paid url> <solana address>");
const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

const res = await fetch(url);
if (res.status !== 402) throw new Error(`Expected a 402, got ${res.status}`);
const request = parsePaymentRequest(await res.json());
console.log("payment request:", request);

const holdings = await listSolanaHoldings({ rpcUrl, owner });
console.log("holdings:", holdings);

const { source, skipped } = pickSourceAsset(holdings, await fetchTokens(), request);
for (const { reason } of skipped) console.log(`skipped: ${reason}`);
console.log(
  source
    ? `pay from: ${source.token.symbol} on ${source.token.blockchain} (${source.token.assetId}), worth about $${source.estimatedUsd.toFixed(2)}`
    : "pay from: nothing. No holding can cover this price.",
);
