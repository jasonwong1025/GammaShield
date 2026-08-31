"use client";

import { useReadContract } from "wagmi";
import { mandateAccountAbi } from "@/lib/generated/contracts";
import type { ExecutionNetwork } from "@/lib/explorer";
import { ExplorerLink } from "./ExplorerLink";
import type { Address, Hex } from "viem";

export function AgentMonitoringPanel({ account, mandateHash, network }: { account: Address; mandateHash: Hex; network: ExecutionNetwork }) {
  const { data: riskState, error, isPending } = useReadContract({
    address: account,
    abi: mandateAccountAbi,
    functionName: "riskStates",
    args: [mandateHash],
    chainId: network === "mainnet" ? 8453 : 84532,
  });
  const evidence = isPending
    ? "checking…"
    : error
      ? "unavailable — Base RPC read failed"
      : riskState?.[1]
        ? `${Number(riskState[1]) / 100} / 100`
        : "not observed yet";

  return <section className="mt-4 border-t border-edge pt-4" aria-label="Agent monitoring">
    <p className="text-[10px] font-semibold uppercase tracking-wide text-blue">Step 4 · Agent monitoring</p>
    <h3 className="mt-1 text-[14px] font-bold text-fg">Policy is active</h3>
    <p className="mt-1 text-[12px] text-muted">The external {network === "mainnet" ? "Thetanuts" : "shadow"} worker checks the live book and risk every 10–15 seconds. It can only submit after funding, the signed threshold and persistence period, and a fresh eligible quote.</p>
    <p className="mt-2 rounded-lg border border-blue/25 bg-bluesoft/30 p-3 text-[11px] text-faint">On-chain risk evidence: {evidence} · <ExplorerLink network={network} resource="address" value={account} className="underline">policy account</ExplorerLink> pause or revocation takes effect before every fill.</p>
  </section>;
}
