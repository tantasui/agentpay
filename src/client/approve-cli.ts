import { createInterface } from "node:readline/promises";
import { formatApproval, type ApprovalSummary } from "./deposit.ts";

/** Shows the payment in a terminal and approves it only if the human types "yes". */
export async function askInTerminal(
  summary: ApprovalSummary,
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = {
    input: process.stdin,
    output: process.stdout,
  },
): Promise<boolean> {
  const rl = createInterface({ input: io.input, output: io.output, terminal: false });
  try {
    io.output.write(`\n${formatApproval(summary)}\n`);
    const answer = await rl.question("Type yes to approve this payment: ");
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}
