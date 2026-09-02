"use client";

import { useEffect, useState } from "react";
import { useReadContract } from "wagmi";
import { mandateAccountAbi } from "@/lib/generated/contracts";
import type { ExecutionNetwork } from "@/lib/explorer";
import { ExplorerLink } from "./ExplorerLink";
import type { Address, Hex } from "viem";

type AgentStatus = {
  dryRun: boolean;
  command: string;
  worker: "not-reporting" | "error" | "stale" | "checking" | "awaiting-first-check";
  latest: { outcome: string; detail: string | null; score: number | null; threshold: number | null; checkedAt: string; userOpHash: string | null } | null;
  recent: { status: "confirmed" | "reverted"; transactionHash: string | null } | null;
};

export function AgentMonitoringPanel({ account, mandateHash, network }: { account: Address; mandateHash: Hex; network: ExecutionNetwork }) {
  const chainId = network === "mainnet" ? 8453 : 84532;
  const { data: riskState, error: riskError, isPending: isRiskPending } = useReadContract({ address: account, abi: mandateAccountAbi, functionName: "riskStates", args: [mandateHash], chainId });
  const { data: mandate } = useReadContract({ address: account, abi: mandateAccountAbi, functionName: "getMandate", args: [mandateHash], chainId });
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [agentError, setAgentError] = useState(false);
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      setNow(Math.floor(Date.now() / 1_000));
      try {
        const response = await fetch(`/api/agent-status?network=${network}&account=${account}`, { cache: "no-store" });
        if (!response.ok) throw new Error("agent status unavailable");
        const value = await response.json() as AgentStatus;
        if (!cancelled) {
          setAgent(value);
          setAgentError(false);
        }
      } catch {
        if (!cancelled) setAgentError(true);
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [account, network]);

  const score = riskState ? Number(riskState[0]) / 100 : null;
  const eligibleSince = riskState ? Number(riskState[1]) : 0;
  const observedAt = riskState ? Number(riskState[2]) : 0;
  const validUntil = riskState ? Number(riskState[3]) : 0;
  const threshold = mandate ? Number(mandate.riskThresholdBps) / 100 : agent?.latest?.threshold ?? null;
  const persistenceSeconds = mandate ? Number(mandate.persistenceSeconds) : 0;
  const evidence = isRiskPending ? "checking on-chain evidence…" : riskError ? "unavailable — Base RPC read failed" : !observedAt ? "not observed yet" : `${score?.toFixed(2)} / 100${now != null && validUntil <= now ? " — expired" : ""}`;
  const persistenceEndsAt = eligibleSince + persistenceSeconds;
  const persistence = !observedAt || !eligibleSince ? "No qualifying on-chain risk observation yet." : now == null ? "Checking whether the risk observation is still valid…" : validUntil <= now ? "The last risk observation expired; the worker must refresh it." : now < persistenceEndsAt ? `Risk evidence is eligible; ${duration(persistenceEndsAt - now)} remains before a fill can be considered.` : "Risk persistence requirement is satisfied; a fresh eligible quote is still required.";

  return <section className="mt-4 border-t border-edge pt-4" aria-label="Agent monitoring">
    <p className="text-[10px] font-semibold uppercase tracking-wide text-blue">Step 4 · Agent monitoring</p>
    <h3 className="mt-1 text-[14px] font-bold text-fg">{agent?.worker === "error" || agent?.worker === "stale" || agentError ? "Agent needs attention" : "Policy is active"}</h3>
    <p className="mt-1 text-[12px] text-muted">The external {network === "mainnet" ? "Thetanuts" : "shadow"} worker checks the live book and risk every 10–15 seconds. It can only submit after funding, the signed threshold and persistence period, and a fresh eligible quote.</p>
    <div className="mt-3 grid gap-2 rounded-lg border border-edge bg-panel2 p-3 text-[11px] sm:grid-cols-[150px_1fr]">
      <span className="text-faint">Worker</span><span className="text-fg">{workerText(agent, agentError, now)}</span>
      <span className="text-faint">Execution mode</span><span className="text-fg">{!agent ? "Checking worker mode…" : agent.dryRun ? "Dry run — validates only; it cannot spend funds." : network === "mainnet" ? "Broadcast enabled — a qualifying fill may use policy funds." : "Shadow execution — Base Sepolia test funds only."}</span>
      <span className="text-faint">Latest decision</span><span className="text-fg">{agent?.latest ? decisionText(agent.latest) : "Waiting for the first worker check."}</span>
      <span className="text-faint">Risk evidence</span><span className="text-fg">{evidence}{threshold != null ? ` · threshold ${threshold.toFixed(2)} / 100` : ""}</span>
      <span className="text-faint">Persistence</span><span className="text-fg">{persistence}</span>
      {agent?.recent && <><span className="text-faint">Latest UserOperation</span><span className={agent.recent.status === "confirmed" ? "text-calm" : "text-crit"}>{agent.recent.status === "confirmed" ? "Confirmed" : "Reverted"}{agent.recent.transactionHash && <>. <ExplorerLink network={network} resource="tx" value={agent.recent.transactionHash} className="underline">View transaction</ExplorerLink></>}</span></>}
    </div>
    {agent?.worker === "not-reporting" || agent?.worker === "awaiting-first-check" ? <p className="mt-2 rounded-lg border border-blue/25 bg-bluesoft/30 p-3 text-[11px] text-faint">No worker report has reached this app yet. Run <code className="font-mono text-fg">{agent?.command ?? (network === "mainnet" ? "npm run agent:thetanuts" : "npm run agent:shadow")}</code> on the same machine as the local app, then this panel will update after its first check.</p> : null}
    {(agent?.worker === "error" || agent?.worker === "stale" || agentError) && <p className="mt-2 rounded-lg border border-crit/30 bg-crit/10 p-3 text-[11px] text-crit">The worker has not completed a recent check. Inspect its terminal for the RPC or upstream error; it will not submit a fill while a check is failing.</p>}
    <p className="mt-2 rounded-lg border border-blue/25 bg-bluesoft/30 p-3 text-[11px] text-faint">On-chain risk evidence: {evidence} · <ExplorerLink network={network} resource="address" value={account} className="underline">policy account</ExplorerLink> pause or revocation takes effect before every fill.</p>
  </section>;
}

function workerText(agent: AgentStatus | null, error: boolean, now: number | null) {
  if (error) return "Status could not be read from this app.";
  if (!agent || agent.worker === "not-reporting") return "No report yet.";
  if (agent.worker === "awaiting-first-check") return "Started; awaiting first check.";
  if (agent.worker === "error") return "Last worker check failed.";
  if (agent.worker === "stale") return "Last worker report is stale.";
  return agent.latest ? `Checked ${timeAgo(agent.latest.checkedAt, now)}.` : "Checking.";
}

function decisionText(latest: NonNullable<AgentStatus["latest"]>) {
  const labels: Record<string, string> = {
    "risk-below-threshold": "Waiting: live risk is below the signed threshold.",
    "risk-persistence-pending": "Waiting: qualifying risk has not persisted long enough.",
    "risk-observation-submitted": "Risk evidence UserOperation submitted; awaiting confirmation.",
    "risk-observation-simulated": "Dry-run: risk evidence passed validation but was not broadcast.",
    "risk-reset-submitted": "Risk reset UserOperation submitted; awaiting confirmation.",
    "risk-reset-simulated": "Dry-run: risk reset passed validation but was not broadcast.",
    "quote-unavailable": "Waiting: no fresh listed order satisfies the signed policy.",
    "gas-unfunded": "Waiting: the policy account needs more native ETH for UserOperation gas.",
    "pending-user-operation": "Waiting for the prior UserOperation receipt.",
    "fill-submitted": "Fill UserOperation submitted; awaiting confirmation.",
    "fill-simulated": "Dry-run: a fresh quote passed every policy check; no fill was broadcast.",
  };
  return `${labels[latest.outcome] ?? latest.outcome}${latest.detail ? ` ${latest.detail}` : ""}`;
}

function duration(seconds: number) {
  return seconds < 60 ? `${Math.max(0, seconds)} seconds` : `${Math.ceil(seconds / 60)} minutes`;
}

function timeAgo(value: string, now: number | null) {
  if (now == null) return "just now";
  const seconds = Math.max(0, now - Math.floor(Date.parse(value) / 1_000));
  return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`;
}
