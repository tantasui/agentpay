export const ONECLICK_API = "https://1click.chaindefuser.com";

export type Token = {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  contractAddress?: string;
};

export async function fetchTokens(fetchFn: typeof fetch = fetch): Promise<Token[]> {
  const res = await fetchFn(`${ONECLICK_API}/v0/tokens`);
  if (!res.ok) throw new Error(`GET /v0/tokens returned ${res.status}`);
  return (await res.json()) as Token[];
}
