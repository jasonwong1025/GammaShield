import "server-only";

import { ethers } from "ethers";
import { withRpcRetry } from "@/lib/rpcRetry";

// Public/free RPC plans commonly permit only ten blocks per eth_getLogs call.
const LOG_RANGE = 10;

// A worker that fell behind (an outage, a restart against a new RPC) can be
// thousands of blocks short of the chain tip. Scanning the whole gap in one
// tick means firing that many eth_getLogs chunks back-to-back with no
// pacing, which trips any per-second throughput cap regardless of how
// generous the per-call retry budget is — the burst itself is the problem,
// not a single flaky call. So a scan closes at most this many blocks per
// call, and paces the chunk calls within it; the worker's next tick resumes
// from wherever this one left off, and the gap closes over several ticks
// instead of one guaranteed-to-fail marathon.
const MAX_BLOCKS_PER_SCAN = 2_000;
const CHUNK_DELAY_MS = 200;

export type DiscoveryResult = { accounts: string[]; scannedToBlock: number };

/**
 * Never throws. A chunk that exhausts its retry budget stops the scan where
 * it is and returns everything found so far — a caller that also assesses
 * already-known accounts (which don't depend on discovery at all) should
 * still get to do that even when discovering *new* accounts is temporarily
 * blocked. `scannedToBlock` only ever reports what was actually scanned, so
 * the caller never loses progress it didn't really make.
 */
export async function discoverPolicyAccounts(factory: ethers.Contract, fromBlock: number, toBlock: number): Promise<DiscoveryResult> {
  if (fromBlock > toBlock) return { accounts: [], scannedToBlock: fromBlock - 1 };
  const cappedTo = Math.min(toBlock, fromBlock + MAX_BLOCKS_PER_SCAN - 1);
  const accounts: string[] = [];
  let scannedToBlock = fromBlock - 1;
  for (let start = fromBlock; start <= cappedTo; start += LOG_RANGE) {
    if (start > fromBlock) await sleep(CHUNK_DELAY_MS);
    const end = Math.min(start + LOG_RANGE - 1, cappedTo);
    let events: Array<{ args?: { account?: string } }>;
    try {
      events = await withRpcRetry(() => factory.queryFilter(factory.filters.AccountCreated(), start, end)) as Array<{ args?: { account?: string } }>;
    } catch {
      return { accounts, scannedToBlock };
    }
    for (const event of events) if (event.args?.account) accounts.push(ethers.getAddress(event.args.account));
    scannedToBlock = end;
  }
  return { accounts, scannedToBlock };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
