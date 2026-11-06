import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import type { SolanaChain } from "./deposit.ts";

/** The real SolanaChain, over JSON-RPC. Confirms by polling, so no websocket is needed. */
export function createSolanaChain(rpcUrl: string): SolanaChain & {
  simulate(instructions: Instruction[], feePayer: Address): Promise<{ err: unknown; logs: string[] | null }>;
} {
  const rpc = createSolanaRpc(rpcUrl);

  async function message(instructions: Instruction[], signer: TransactionSigner) {
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const tx = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    return { tx, lastValidBlockHeight: blockhash.lastValidBlockHeight };
  }

  return {
    async lamports(owner) {
      return (await rpc.getBalance(owner, { commitment: "confirmed" }).send()).value;
    },
    async exists(account) {
      return (await rpc.getAccountInfo(account, { encoding: "base64" }).send()).value !== null;
    },
    async owner(account) {
      return (await rpc.getAccountInfo(account, { encoding: "base64" }).send()).value?.owner ?? null;
    },
    async rentExemptMinimum(bytes) {
      return await rpc.getMinimumBalanceForRentExemption(BigInt(bytes)).send();
    },

    async send(instructions, signer) {
      const { tx, lastValidBlockHeight } = await message(instructions, signer);
      const signed = await signTransactionMessageWithSigners(tx);
      const signature = getSignatureFromTransaction(signed);
      await rpc
        .sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed" })
        .send();

      while (true) {
        const { value } = await rpc.getSignatureStatuses([signature]).send();
        const status = value[0];
        if (status?.err) throw new Error(`Deposit ${signature} failed: ${JSON.stringify(status.err)}`);
        if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
          return signature;
        }
        const height = await rpc.getBlockHeight({ commitment: "confirmed" }).send();
        if (height > lastValidBlockHeight) {
          throw new Error(`Deposit ${signature} was not confirmed before its blockhash expired. Check it before paying again.`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    },

    /** Runs the deposit against mainnet state without signatures. Nothing is sent. */
    async simulate(instructions, feePayer) {
      const { tx } = await message(instructions, createNoopSigner(feePayer));
      const wire = getBase64EncodedWireTransaction(compileTransaction(tx));
      const { value } = await rpc
        .simulateTransaction(wire, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true })
        .send();
      return { err: value.err, logs: value.logs };
    },
  };
}
