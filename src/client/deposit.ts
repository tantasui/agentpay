import { address, type Address, type Instruction, type TransactionSigner } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import type { PaymentRequest } from "../payment-request.ts";
import { ONECLICK_API, type Token } from "../tokens.ts";
import { formatUnits } from "../units.ts";
import type { Quote } from "./quote.ts";

// One signature. Kept generous, since priority fees are not set.
const FEE_LAMPORTS = 5_000n;
const TOKEN_ACCOUNT_BYTES = 165;
// The deposit has to confirm before refunds begin.
const MIN_TIME_BEFORE_REFUND_MS = 30_000;

/** The chain operations a deposit needs. createSolanaChain in solana-chain.ts is the real one. */
export type SolanaChain = {
  lamports(owner: Address): Promise<bigint>;
  exists(account: Address): Promise<boolean>;
  owner(account: Address): Promise<Address | null>;
  rentExemptMinimum(bytes: number): Promise<bigint>;
  /** Signs, sends and waits for confirmation. Returns the signature. */
  send(instructions: Instruction[], signer: TransactionSigner): Promise<string>;
};

export type ApprovalSummary = {
  pay: string;
  refundTo: string;
  sellerGets: string;
  recipient: string;
  timeEstimateSeconds?: number;
  refundsBeginAt: string;
  refundFee?: string;
  depositAddress: string;
};

export function formatApproval(s: ApprovalSummary): string {
  return [
    `Pay ${s.pay} from ${s.refundTo}`,
    `Seller receives exactly ${s.sellerGets} at ${s.recipient}`,
    `Expected to complete about ${s.timeEstimateSeconds ?? "?"} s after the deposit confirms`,
    `If it does not, refunds begin at ${s.refundsBeginAt}` +
      (s.refundFee ? ` and 1Click keeps about ${s.refundFee}` : ""),
    `Deposit address: ${s.depositAddress}`,
  ].join("\n");
}

export type DepositOptions = {
  quote: Quote;
  source: Token;
  request: PaymentRequest;
  signer: TransactionSigner;
  chain: SolanaChain;
  /** Returns true only if a human or a spending policy approves this payment. */
  approve: (summary: ApprovalSummary) => Promise<boolean>;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
};

export async function buildDepositInstructions(options: {
  source: Token;
  signer: TransactionSigner;
  depositAddress: Address;
  amount: string;
}): Promise<Instruction[]> {
  const { source, signer, depositAddress } = options;
  const amount = BigInt(options.amount);
  if (!source.contractAddress) {
    return [getTransferSolInstruction({ source: signer, destination: depositAddress, amount })];
  }
  const mint = address(source.contractAddress);
  const tokenProgram = TOKEN_PROGRAM_ADDRESS;
  const [from] = await findAssociatedTokenPda({ owner: signer.address, mint, tokenProgram });
  const [to] = await findAssociatedTokenPda({ owner: depositAddress, mint, tokenProgram });
  return [
    getCreateAssociatedTokenIdempotentInstruction({ payer: signer, ata: to, owner: depositAddress, mint }),
    getTransferCheckedInstruction({
      source: from,
      mint,
      destination: to,
      authority: signer,
      amount,
      decimals: source.decimals,
    }),
  ];
}

/**
 * Asks for approval, then sends the deposit for a quote (MON-84). Nothing is sent
 * without approval. Checks that the payer has the SOL for fees and rent before
 * asking, so nobody approves a payment that cannot be sent.
 *
 * Pass the returned sentAt to pollSwapStatus as startedAt.
 */
export async function approveAndDeposit(options: DepositOptions): Promise<{ signature: string; sentAt: number }> {
  const { quote, source, request, signer, chain, approve } = options;
  const { fetch: fetchFn = fetch, now = Date.now, log = console.log } = options;
  const depositAddress = address(quote.depositAddress);
  const sol = (lamports: bigint) => `${formatUnits(lamports.toString(), 9)} SOL`;
  const show = (amount: string) => `${formatUnits(amount, source.decimals)} ${source.symbol}`;

  let needed = FEE_LAMPORTS;
  if (source.contractAddress) {
    const mint = address(source.contractAddress);
    if ((await chain.owner(mint)) !== TOKEN_PROGRAM_ADDRESS) {
      throw new Error(`${source.symbol} is not supported: only classic SPL tokens can be deposited`);
    }
    const [to] = await findAssociatedTokenPda({ owner: depositAddress, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    if (!(await chain.exists(to))) needed += await chain.rentExemptMinimum(TOKEN_ACCOUNT_BYTES);
  } else {
    needed += BigInt(quote.amountIn);
  }
  const held = await chain.lamports(signer.address);
  if (held < needed) {
    const what = source.contractAddress ? "fees and rent" : "the payment and fees";
    throw new Error(`Payer needs ${sol(needed)} for ${what}, holds ${sol(held)}. Nothing was sent.`);
  }

  const approved = await approve({
    pay: show(quote.amountIn),
    refundTo: signer.address,
    sellerGets: `${formatUnits(request.amount, request.decimals)} ${request.symbol} on ${request.chain}`,
    recipient: request.recipient,
    timeEstimateSeconds: quote.timeEstimateSeconds,
    refundsBeginAt: quote.refundsBeginAt,
    refundFee: quote.refundFee ? show(quote.refundFee) : undefined,
    depositAddress,
  });
  if (!approved) throw new Error("Payment declined. Nothing was sent.");

  if (Date.parse(quote.refundsBeginAt) - now() < MIN_TIME_BEFORE_REFUND_MS) {
    throw new Error("Approved too close to the refund time. Nothing was sent: get a new quote.");
  }

  const instructions = await buildDepositInstructions({ source, signer, depositAddress, amount: quote.amountIn });
  const sentAt = now();
  const signature = await chain.send(instructions, signer);
  log(`deposit sent: ${signature}`);

  // Optional, but it speeds up processing.
  try {
    const res = await fetchFn(`${ONECLICK_API}/v0/deposit/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ txHash: signature, depositAddress }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (error) {
    log(`could not notify 1Click of the deposit, it will still be found: ${(error as Error).message}`);
  }

  return { signature, sentAt };
}
