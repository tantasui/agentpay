export type Holding = {
  chain: string;
  /** Token contract or mint. Null for the chain's native asset. */
  contract: string | null;
  /** Spendable amount in smallest units. */
  amount: string;
};

const TOKEN_PROGRAMS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
];

// Kept back for the deposit: a transaction fee, plus about 0.00204 SOL of rent if
// the deposit address needs a token account.
const SOL_FEE_RESERVE_LAMPORTS = 5_000_000n;

type TokenAccounts = {
  value: Array<{
    account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string } } } } };
  }>;
};

export async function listSolanaHoldings(options: {
  rpcUrl: string;
  owner: string;
  fetch?: typeof fetch;
}): Promise<Holding[]> {
  const { rpcUrl, owner, fetch: fetchFn = fetch } = options;

  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetchFn(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`Solana RPC returned ${res.status} for ${method}`);
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error || body.result === undefined) {
      throw new Error(`Solana RPC ${method} failed: ${body.error?.message ?? "no result"}`);
    }
    return body.result;
  }

  const holdings: Holding[] = [];

  const { value: lamports } = await rpc<{ value: number }>("getBalance", [owner]);
  const spendable = BigInt(lamports) - SOL_FEE_RESERVE_LAMPORTS;
  if (spendable > 0n) holdings.push({ chain: "sol", contract: null, amount: spendable.toString() });

  for (const programId of TOKEN_PROGRAMS) {
    const accounts = await rpc<TokenAccounts>("getTokenAccountsByOwner", [
      owner,
      { programId },
      { encoding: "jsonParsed" },
    ]);
    for (const { account } of accounts.value) {
      const { mint, tokenAmount } = account.data.parsed.info;
      if (tokenAmount.amount !== "0") {
        holdings.push({ chain: "sol", contract: mint, amount: tokenAmount.amount });
      }
    }
  }

  return holdings;
}
