import "server-only";

import { ethers } from "ethers";
import { withRpcRetry } from "@/lib/rpcRetry";

// Public/free RPC plans commonly permit only ten blocks per eth_getLogs call.
const LOG_RANGE = 10;

export async function discoverPolicyAccounts(factory: ethers.Contract, fromBlock: number, toBlock: number) {
  if (fromBlock > toBlock) return [];
  const accounts: string[] = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_RANGE) {
    const events = await withRpcRetry(() =>
      factory.queryFilter(factory.filters.AccountCreated(), start, Math.min(start + LOG_RANGE - 1, toBlock))
    ) as Array<{ args?: { account?: string } }>;
    for (const event of events) if (event.args?.account) accounts.push(ethers.getAddress(event.args.account));
  }
  return accounts;
}
