// Shared wallet/approve/fill/RFQ plumbing for buying options — used by the
// single-option flow and the Base Sepolia shadow flow (TradePanel.tsx), and
// by the multi-leg strategy executor (StrategyBuilder.tsx), which walks these
// same steps once per leg.

import type { RfqStatus } from "@/lib/rfq";
import type { ShadowQuote } from "@/lib/shadow";
import type { TradePeriod } from "@/lib/tradePeriods";
import {
  BASE_CHAIN,
  BASE_SEPOLIA_CHAIN,
  getActiveProvider,
  switchToBase,
  switchToBaseSepolia,
  type Eip1193Provider,
} from "./WalletConnect";

export type TxPhase =
  | { step: "idle" }
  | { step: "connecting" | "preparing" | "approving" | "preflighting" | "filling" }
  | { step: "done"; hash: string }
  | { step: "error"; message: string };

export type RfqPhase =
  | { step: "idle" }
  | { step: "connecting" | "approving" | "requesting" }
  | { step: "auction"; status: RfqStatus | null; deadline: number }
  | { step: "accepting"; status: RfqStatus }
  | { step: "done"; hash: string; optionAddress: string | null }
  | { step: "error"; message: string };

export type ShadowTxPhase =
  | { step: "idle" }
  | { step: "connecting" | "preparing" | "approving" | "filling" }
  | { step: "done"; hash: string; quote: ShadowQuote }
  | { step: "error"; message: string };

export async function connectWallet() {
  const provider = getActiveProvider();
  if (!provider) throw new Error("No wallet detected — install MetaMask or Phantom.");
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  const from = accounts[0];
  if (!from) throw new Error("no account connected");
  await switchToBase(provider);
  if ((await provider.request({ method: "eth_chainId" })) !== BASE_CHAIN.chainId) {
    throw new Error("switch your wallet to Base mainnet to continue");
  }
  return { provider, from };
}

export async function connectShadowWallet() {
  const provider = getActiveProvider();
  if (!provider) throw new Error("No wallet detected — install MetaMask or Phantom.");
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  const from = accounts[0];
  if (!from) throw new Error("no account connected");
  await switchToBaseSepolia(provider);
  if ((await provider.request({ method: "eth_chainId" })) !== BASE_SEPOLIA_CHAIN.chainId) {
    throw new Error("switch your wallet to Base Sepolia to continue");
  }
  return { provider, from };
}

export async function sendTx(
  provider: Eip1193Provider,
  from: string,
  tx: { to: string; data: string },
): Promise<string> {
  const hash = (await provider.request({
    method: "eth_sendTransaction",
    params: [{ from, to: tx.to, data: tx.data }],
  })) as string;
  await waitForReceipt(provider, hash);
  return hash;
}

// Skip the approve popup when the token allowance already covers the pull —
// fewer wallet prompts, and sidesteps MetaMask's spending-cap alert flow.
export async function needsApproval(
  provider: Eip1193Provider,
  owner: string,
  approve: { to: string; data: string },
  spender: string,
): Promise<boolean> {
  try {
    const needed = BigInt("0x" + approve.data.slice(-64));
    const data =
      "0xdd62ed3e" + // allowance(address,address)
      owner.slice(2).toLowerCase().padStart(64, "0") +
      spender.slice(2).toLowerCase().padStart(64, "0");
    const res = (await provider.request({
      method: "eth_call",
      params: [{ to: approve.to, data }, "latest"],
    })) as string;
    return BigInt(res) < needed;
  } catch {
    return true; // can't verify — approve to be safe
  }
}

/**
 * Simulate the exact user-signed fill after its approval is confirmed. This
 * catches stale/filled orders and insufficient balance without broadcasting a
 * transaction. The wallet remains the RPC authority for the user's account.
 */
export async function preflightTx(
  provider: Eip1193Provider,
  from: string,
  tx: { to: string; data: string },
) {
  await provider.request({
    method: "eth_call",
    params: [{ from, to: tx.to, data: tx.data }, "pending"],
  });
}

export async function rfqApi<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch("/api/rfq", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `rfq ${res.status}`);
  return data as T;
}

export async function waitForReceipt(provider: Eip1193Provider, hash: string) {
  for (let i = 0; i < 60; i++) {
    const receipt = (await provider.request({
      method: "eth_getTransactionReceipt",
      params: [hash],
    })) as { status?: string } | null;
    if (receipt) {
      if (receipt.status === "0x0") throw new Error("transaction reverted");
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("timed out waiting for confirmation");
}

/** aBasWETH → WETH etc. — friendlier display, full symbol in the title attr. */
export function displayToken(symbol: string) {
  return symbol.replace(/^aBas/, "");
}

export function fmtDays(d: number) {
  return d < 1 ? `${Math.round(d * 24)}h` : `${Math.round(d)}d`;
}

export function periodLabel(p: TradePeriod) {
  return p === 7 ? "1 Week" : p === 14 ? "2 Weeks" : "4 Weeks";
}
