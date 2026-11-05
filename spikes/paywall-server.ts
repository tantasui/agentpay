// MON-80: a throwaway server for trying the paywall with curl. The real demo
// seller is MON-89.
//
// Usage: SELLER_ADDRESS=0x... npm run spike:paywall
//        curl -i http://localhost:4020/paid

import { createServer } from "node:http";
import { createPaywall } from "../src/seller/paywall.ts";

const recipient = process.env.SELLER_ADDRESS;
if (!recipient) throw new Error("Set SELLER_ADDRESS to the seller's Base address");

const paywall = await createPaywall({
  symbol: "ETH",
  chain: "base",
  amount: "200000000000000", // 0.0002 ETH
  recipient,
});

const port = Number(process.env.PORT ?? 4020);
createServer((req, res) => {
  void paywall(req, res, () => res.end("served\n"));
}).listen(port, () => console.log(`http://localhost:${port}/paid costs 0.0002 ETH, paid to ${recipient}`));
