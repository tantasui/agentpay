import type { Token } from "../src/tokens.ts";

export const SELLER = "0x2527D02599Ba641c19FEa793cD0F167589a0f10D";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export const TOKENS: Token[] = [
  { assetId: "nep141:base.omft.near", decimals: 18, blockchain: "base", symbol: "ETH", price: 2400 },
  {
    assetId: "nep141:sol-usdc.omft.near",
    decimals: 6,
    blockchain: "sol",
    symbol: "USDC",
    price: 1,
    contractAddress: USDC_MINT,
  },
  { assetId: "nep141:sol.omft.near", decimals: 9, blockchain: "sol", symbol: "SOL", price: 100 },
];

export const tokensFetch = (async () => Response.json(TOKENS)) as typeof fetch;
