// MON-85: poll a swap until it reaches a terminal status. Read-only. Use it to watch
// a real swap, as in MON-79 and MON-87.
//
// Usage: npm run spike:poll -- <depositAddress> [timeoutSeconds]

import { pollSwapStatus, SwapStatusTimeout } from "../src/client/poll-status.ts";

const [depositAddress, timeoutSeconds] = process.argv.slice(2);
if (!depositAddress) throw new Error("Usage: poll-status <depositAddress> [timeoutSeconds]");

try {
  const result = await pollSwapStatus({
    depositAddress,
    apiKey: process.env.ONECLICK_API_KEY || undefined,
    timeoutMs: timeoutSeconds ? Number(timeoutSeconds) * 1000 : undefined,
  });
  console.log(result);
} catch (error) {
  if (!(error instanceof SwapStatusTimeout)) throw error;
  console.error(error.message);
  process.exitCode = 2;
}
