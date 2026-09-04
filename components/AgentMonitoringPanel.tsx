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
  latest: {
    outcome: string;
    detail: string | null;
    score: number | null;
    threshold: number | null;
    checkedAt: string;
    userOpHash: string | null;
    health?: string | null;
    decision?: {
      action: string | null;
      urgency: string | null;
      reasonCodes: string[];
      explanation: string | null;
      riskBefore: number | null;
      estimatedCostUsd: number | null;
      alternatives: { action: string; rejected: string; estimatedRiskAfter: number | null; estimatedCostUsd: number | null }[];
      aiInitiated: boolean;
      recommendationOnly: boolean;
    } | null;
  } | null;
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

  const needsAttention = agent?.worker === "error" || agent?.worker === "stale" || agentError;
  return <section aria-label="Agent monitoring">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="flex items-center gap-2">
        {!needsAttention && <span className="live-dot inline-block size-2 rounded-full bg-calm" />}
        <h3 className="text-[16px] font-bold tracking-[-0.01em] text-fg">{needsAttention ? "Agent needs attention" : "Policy is active"}</h3>
      </div>
      {needsAttention && <span className="rounded-full bg-crit/10 px-2.5 py-1 text-[10px] font-semibold text-crit">Action needed</span>}
    </div>
    <p className="mt-1 max-w-[68ch] text-[12px] leading-relaxed text-muted">
      The external {network === "mainnet" ? "Thetanuts" : "shadow"} worker checks the live book and risk every 10–15 seconds. It can only act after funding, the signed threshold and persistence period, and a fresh eligible quote — and only through the actions you switched on. {network === "mainnet" ? "On Base mainnet that is Auto-Hedge alone." : "On Base Sepolia all three actions are available."}
    </p>
    <div className="readout mt-3 grid gap-2 p-3 text-[11px] sm:grid-cols-[150px_1fr]">
      <span className="text-faint">Worker</span><span className="text-fg">{workerText(agent, agentError, now)}</span>
      <span className="text-faint">Execution mode</span><span className="text-fg">{!agent ? "Checking worker mode…" : agent.dryRun ? "Dry run — validates only; it cannot spend funds." : network === "mainnet" ? "Broadcast enabled — a qualifying fill may use policy funds." : "Shadow execution — Base Sepolia test funds only."}</span>
      <span className="text-faint">Latest decision</span><span className="text-fg">{agent?.latest ? decisionText(agent.latest) : "Waiting for the first worker check."}</span>
      <span className="text-faint">Risk evidence</span><span className="text-fg">{evidence}{threshold != null ? ` · threshold ${threshold.toFixed(2)} / 100` : ""}</span>
      <span className="text-faint">Persistence</span><span className="text-fg">{persistence}</span>
      {agent?.recent && <><span className="text-faint">Latest UserOperation</span><span className={agent.recent.status === "confirmed" ? "text-calm" : "text-crit"}>{agent.recent.status === "confirmed" ? "Confirmed" : "Reverted"}{agent.recent.transactionHash && <>. <ExplorerLink network={network} resource="tx" value={agent.recent.transactionHash} className="underline">View transaction</ExplorerLink></>}</span></>}
    </div>

    {agent?.latest?.decision && <Assessment latest={agent.latest} network={network} />}
    {agent?.worker === "not-reporting" || agent?.worker === "awaiting-first-check" ? <p className="mt-2 rounded-lg border border-blue/25 bg-bluesoft/30 p-3 text-[11px] text-faint">No worker report has reached this app yet. Run <code className="font-mono text-fg">{agent?.command ?? (network === "mainnet" ? "npm run agent:thetanuts" : "npm run agent:shadow")}</code> on the same machine as the local app, then this panel will update after its first check.</p> : null}
    {(agent?.worker === "error" || agent?.worker === "stale" || agentError) && <p className="mt-2 rounded-lg border border-crit/30 bg-crit/10 p-3 text-[11px] text-crit">The worker has not completed a recent check. Inspect its terminal for the RPC or upstream error; it will not submit a fill while a check is failing.</p>}
    <p className="mt-2 rounded-lg border border-blue/25 bg-bluesoft/30 p-3 text-[11px] text-faint">On-chain risk evidence: {evidence} · <ExplorerLink network={network} resource="address" value={account} className="underline">policy account</ExplorerLink> pause or revocation takes effect before every fill.</p>
  </section>;
}

function workerText(agent: AgentStatus | null, error: boolean, now: number | null) {
  if (error) return "Status could not be read from this app.";
  if (!agent || agent.worker === "not-reporting") return "No report yet.";
  if (agent.worker === "awaiting-first-check") return "No worker decision recorded yet.";
  if (agent.worker === "error") return "Last worker check failed.";
  if (agent.worker === "stale") return "Last worker report is stale.";
  return agent.latest ? `Checked ${timeAgo(agent.latest.checkedAt, now)}.` : "Checking.";
}

const HEALTH_TONE: Record<string, string> = {
  HEALTHY: "text-calm",
  WATCH: "text-fg",
  WARNING: "text-warn",
  CRITICAL: "text-crit",
};

/**
 * What the agent actually weighed. This is the honesty surface for the
 * decision engine, in the same spirit as the dropped sub-scores on the
 * contract-risk panel: it shows the three actions that were NOT taken and why,
 * so a hold is legible as a judgement rather than as inactivity.
 */
function Assessment({ latest, network }: { latest: NonNullable<AgentStatus["latest"]>; network: ExecutionNetwork }) {
  const decision = latest.decision!;
  return (
    <div className="mt-3 rounded-lg border border-edge bg-panel2 p-3 text-[11px]">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-faint">Assessment</p>
        {decision.action && <span className="rounded bg-panel px-1.5 py-0.5 text-[10px] font-semibold text-fg">{decision.action}</span>}
        {decision.urgency && <span className="rounded bg-panel px-1.5 py-0.5 text-[10px] text-muted">{decision.urgency} urgency</span>}
        {latest.health && (
          <span className={`rounded bg-panel px-1.5 py-0.5 text-[10px] font-semibold ${HEALTH_TONE[latest.health] ?? "text-fg"}`}>
            {latest.health}
          </span>
        )}
        {decision.riskBefore != null && <span className="num text-[10px] text-faint">risk {decision.riskBefore.toFixed(1)} / 100</span>}
      </div>

      {decision.explanation && <p className="mt-2 leading-relaxed text-muted">{decision.explanation}</p>}

      {decision.aiInitiated && (
        <p className="mt-2 rounded border border-blue/30 bg-blue/5 p-2 leading-relaxed text-muted">
          The AI raised this exit itself, on a broken thesis — the one action it may start rather than only narrow. It still had to
          pass the signed policy, and it is always the whole position.
        </p>
      )}

      {decision.recommendationOnly && (
        <p className="mt-2 rounded border border-warn/30 bg-warn/10 p-2 leading-relaxed text-muted">
          {network === "mainnet"
            ? "Base mainnet has no way to execute this. A Thetanuts option can be closed only bilaterally, the OptionBook exposes no maker orders to end users, and an RFQ mints a new option rather than buying this one back — so this is priced for you to act on, not executed."
            : "This deployment cannot execute the action, so it is a recommendation only."}
        </p>
      )}

      {decision.reasonCodes.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {decision.reasonCodes.map((code) => (
            <span key={code} className="rounded bg-panel px-1.5 py-0.5 font-mono text-[10px] text-faint">{code}</span>
          ))}
        </div>
      )}

      {decision.alternatives.length > 0 && (
        <div className="mt-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-faint">Not taken, and why</p>
          <ul className="mt-1 grid gap-1">
            {decision.alternatives.map((alternative) => (
              <li key={alternative.action} className="flex gap-2 leading-relaxed">
                <span className="w-[52px] shrink-0 font-semibold text-fg">{alternative.action}</span>
                <span className="text-faint">
                  {alternative.rejected}
                  {alternative.estimatedCostUsd != null && alternative.estimatedCostUsd !== 0 && (
                    <span className="num">
                      {" "}({alternative.estimatedCostUsd < 0 ? "returns" : "costs"} ${Math.abs(alternative.estimatedCostUsd).toLocaleString("en-US", { maximumFractionDigits: 2 })})
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
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
    "fill-submitted": "Auto-Hedge: fill UserOperation submitted; awaiting confirmation.",
    "close-submitted": "Auto-Close: exit UserOperation submitted; awaiting confirmation.",
    "roll-submitted": "Auto-Roll: close-and-replace UserOperation submitted; awaiting confirmation.",
    "holding": "Holding — no action cleared every gate this cycle.",
    "recommendation": "Recommendation only: this exit cannot be executed here.",
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
