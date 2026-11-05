// MON-78: can the seller receive the exact priced amount?
//
// Asks 1Click for EXACT_OUTPUT quotes, Solana USDC to Base ETH, and checks that
// amountOut equals the price. By default `dry` is true, so no deposit address
// exists and no funds can move.
//
// Dry quotes do not return a deadline. --commit requests a real quote to read it.
// This script never sends a deposit and never prints the deposit address.
//
// Usage: npm run spike:quote -- [--commit] [amountOutWei ...]

const API = "https://1click.chaindefuser.com";

// Example addresses from the 1Click OpenAPI spec. Never deposit against a quote
// made with these: the funds would go to whoever controls them.
const RECIPIENT = process.env.SPIKE_RECIPIENT || "0x2527D02599Ba641c19FEa793cD0F167589a0f10D";
const REFUND_TO = process.env.SPIKE_REFUND_TO || "13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK";

// About $0.26, $0.48 and $2.39 of ETH at the time of writing. The route's minimum
// output moved between 0.000104 and 0.000106 ETH during testing.
const DEFAULT_AMOUNTS = ["110000000000000", "200000000000000", "1000000000000000"];

type Token = { assetId: string; symbol: string; blockchain: string; decimals: number };

const headers: Record<string, string> = { "Content-Type": "application/json" };
if (process.env.ONECLICK_API_KEY) headers["X-API-Key"] = process.env.ONECLICK_API_KEY;

async function findAsset(symbol: string, blockchain: string): Promise<Token> {
  const res = await fetch(`${API}/v0/tokens`);
  if (!res.ok) throw new Error(`GET /v0/tokens returned ${res.status}`);
  const tokens = (await res.json()) as Token[];
  const token = tokens.find((t) => t.symbol === symbol && t.blockchain === blockchain);
  if (!token) throw new Error(`${symbol} on ${blockchain} is not supported`);
  return token;
}

const origin = await findAsset("USDC", "sol");
const destination = await findAsset("ETH", "base");
console.log(`origin      ${origin.assetId}`);
console.log(`destination ${destination.assetId}`);
console.log(`auth        ${process.env.ONECLICK_API_KEY ? "X-API-Key" : "none"}\n`);

const args = process.argv.slice(2);
const commit = args.includes("--commit");
const requested = args.filter((a) => a !== "--commit");
const amounts = requested.length ? requested : DEFAULT_AMOUNTS;
console.log(`mode        ${commit ? "commit (dry: false, no deposit is sent)" : "dry"}\n`);
let failed = false;

for (const amount of amounts) {
  const deadline = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const res = await fetch(`${API}/v0/quote`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      dry: !commit,
      swapType: "EXACT_OUTPUT",
      slippageTolerance: 100,
      originAsset: origin.assetId,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: destination.assetId,
      amount,
      refundTo: REFUND_TO,
      refundType: "ORIGIN_CHAIN",
      recipient: RECIPIENT,
      recipientType: "DESTINATION_CHAIN",
      deadline,
    }),
  });
  const body = await res.json();

  if (!res.ok) {
    failed = true;
    console.log(`requested ${amount} wei: HTTP ${res.status} ${body.message}\n`);
    continue;
  }

  const q = body.quote;
  const exact = q.amountOut === amount;
  if (!exact) failed = true;

  console.log(`requested ${amount} wei`);
  console.log(`  amountOut      ${q.amountOut} (${exact ? "exact" : `GAP ${BigInt(q.amountOut) - BigInt(amount)} wei`})`);
  console.log(`  minAmountOut   ${q.minAmountOut ?? "not returned"}`);
  console.log(`  amountIn       ${q.amountIn} (${q.amountInFormatted} USDC)`);
  console.log(`  minAmountIn    ${q.minAmountIn ?? "not returned"}`);
  console.log(`  maxAmountIn    ${q.maxAmountIn ?? "not returned"}`);
  console.log(`  usd in / out   ${q.amountInUsd} / ${q.amountOutUsd} (display only)`);
  console.log(`  timeEstimate   ${q.timeEstimate ?? "not returned"} s`);
  console.log(`  deadline sent  ${deadline}`);
  console.log(`  deadline back  ${q.deadline ?? "not returned"}`);
  console.log(`  inactive at    ${q.timeWhenInactive ?? "not returned"}`);
  console.log(`  depositAddress ${q.depositAddress ? "issued (hidden, do not use)" : "not returned"}`);
  console.log(`  correlationId  ${body.correlationId}\n`);
}

process.exit(failed ? 1 : 0);
