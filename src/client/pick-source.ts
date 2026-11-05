import type { PaymentRequest } from "../payment-request.ts";
import type { Token } from "../tokens.ts";
import type { Holding } from "./holdings.ts";

// A holding must be worth this multiple of the price to be considered. Quotes for
// this route cost 1.3% to 1.9% over the price, including the 1% slippage buffer.
// This is only a filter: the quote decides the real cost.
const COVER_MULTIPLE = 1.05;

export type SourceChoice = {
  source: { holding: Holding; token: Token; estimatedUsd: number } | null;
  skipped: Array<{ holding: Holding; reason: string }>;
};

const toUsd = (amount: string, token: Token) =>
  (Number(amount) / 10 ** token.decimals) * token.price;

const findToken = (tokens: Token[], { chain, contract }: Holding) =>
  tokens.find(
    (t) => t.blockchain === chain && (t.contractAddress ?? null) === contract,
  );

/**
 * Chooses which holding to pay from: the most valuable one NEAR Intents supports
 * that can cover the price. Decimals come from the token list, because the
 * seller's values are untrusted.
 */
export function pickSourceAsset(
  holdings: Holding[],
  tokens: Token[],
  request: PaymentRequest,
): SourceChoice {
  const target = tokens.find((t) => t.assetId === request.assetId);
  if (!target) throw new Error(`Seller's asset ${request.assetId} is not supported by NEAR Intents`);

  const requiredUsd = toUsd(request.amount, target) * COVER_MULTIPLE;
  const choice: SourceChoice = { source: null, skipped: [] };

  for (const holding of holdings) {
    const token = findToken(tokens, holding);
    if (!token) {
      const name = holding.contract ?? "native asset";
      choice.skipped.push({
        holding,
        reason: `${name} on ${holding.chain} is not supported by NEAR Intents`,
      });
      continue;
    }
    if (token.assetId === target.assetId) {
      choice.skipped.push({
        holding,
        reason: `${token.symbol} on ${token.blockchain} is already the seller's asset, so there is nothing to swap`,
      });
      continue;
    }
    const estimatedUsd = toUsd(holding.amount, token);
    if (estimatedUsd < requiredUsd) {
      choice.skipped.push({
        holding,
        reason: `${token.symbol} on ${token.blockchain} is worth about $${estimatedUsd.toFixed(2)}, needs about $${requiredUsd.toFixed(2)}`,
      });
      continue;
    }
    if (!choice.source || estimatedUsd > choice.source.estimatedUsd) {
      choice.source = { holding, token, estimatedUsd };
    }
  }

  return choice;
}
