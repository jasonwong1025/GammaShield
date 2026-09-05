"use client";

import { useEffect, useState } from "react";
import { useReadContract } from "wagmi";
import { mandateAccountAbi } from "@/lib/generated/contracts";
import type { ExecutionNetwork } from "@/lib/explorer";
import { ExplorerLink } from "./ExplorerLink";
import { Disclosure } from "./Disclosure";
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
    {/* The verdict, and nothing else by default. Everything the agent weighed
        to reach it is real and stays available, but a visit is normally only
        asking "is it fine?" — so the workings wait to be asked for. */}
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="text-[15px] font-bold tracking-[-0.01em] text-fg">{headline(agent, agentError)}</h3>
      <span className={`text-[12px] ${needsAttention ? "font-semibold text-crit" : "text-faint"}`}>{workerText(agent, agentError, now)}</span>
    </div>

    {agent?.latest && (
      <p className="mt-1 text-[13px] leading-relaxed text-muted">
        {agent.latest.decision?.explanation ?? decisionText(agent.latest)}
      </p>
    )}

    {/* Consequential enough to stay in view: one says the AI started this
        itself, the other that nothing was actually executed. */}
    {agent?.latest?.decision?.aiInitiated && (
      <p className="note mt-2.5 text-[12px] leading-relaxed text-muted" style={{ borderLeftColor: "var(--blue)", background: "var(--blue-soft)" }}>
        The AI raised this exit itself, on a broken thesis — the one action it may start rather than only narrow. It still had to
        pass the signed policy, and it is always the whole position.
      </p>
    )}
    {agent?.latest?.decision?.recommendationOnly && (
      <p className="note mt-2.5 text-[12px] leading-relaxed text-muted" style={{ borderLeftColor: "var(--warn)", background: "color-mix(in srgb, var(--warn) 8%, transparent)" }}>
        {network === "mainnet"
          ? "Base mainnet has no way to execute this. A Thetanuts option can be closed only bilaterally, the OptionBook exposes no maker orders to end users, and an RFQ mints a new option rather than buying this one back — so this is priced for you to act on, not executed."
          : "This deployment cannot execute the action, so it is a recommendation only."}
      </p>
    )}

    {(agent?.worker === "error" || agent?.worker === "stale" || agentError) && <p className="note mt-2.5 text-[12px] text-crit" style={{ borderLeftColor: "var(--crit)" }}>The worker check is failing — see its terminal. Nothing will be filled until it recovers.</p>}
    {agent?.worker === "not-reporting" || agent?.worker === "awaiting-first-check" ? <p className="note mt-2.5 text-[12px] leading-relaxed text-faint" style={{ borderLeftColor: "var(--edge-2)" }}>Run <code className="font-mono text-fg">{agent?.command ?? (network === "mainnet" ? "npm run agent:thetanuts" : "npm run agent:shadow")}</code> alongside this app to start it checking.</p> : null}

    <div className="mt-2.5">
      <Disclosure label={agent?.latest?.decision ? "Why this, and not the others?" : "Show what it checks"}>
        <div className="mt-2.5">
          {agent?.latest?.decision && <Assessment latest={agent.latest} />}
          <div className="rowlist mt-2.5">
            <Fact label="Execution mode" value={!agent ? "Checking…" : agent.dryRun ? "Dry run — it cannot spend funds" : network === "mainnet" ? "Broadcast enabled" : "Shadow execution — test funds only"} />
            {/* Distinct from the risk in the assessment: that is what the
                worker just read, this is what the account has attested
                on-chain, and only the attested one can arm a fill. */}
            <Fact label="Risk attested on-chain" value={`${evidence}${threshold != null ? `, trigger ${threshold.toFixed(0)}` : ""}`} />
            <Fact label="Persistence" value={persistence} />
            {agent?.recent && (
              <Fact
                label="Last transaction"
                tone={agent.recent.status === "confirmed" ? "text-calm" : "text-crit"}
                value={<>{agent.recent.status === "confirmed" ? "Confirmed" : "Reverted"}{agent.recent.transactionHash && <>. <ExplorerLink network={network} resource="tx" value={agent.recent.transactionHash} className="underline">View transaction</ExplorerLink></>}</>}
              />
            )}
          </div>
          <p className="mt-2.5 text-[12px] leading-relaxed text-faint">
            Checks the live book every 10–15 seconds, within your signed limits and switched-on actions.{" "}
            {network === "mainnet" ? "Only Auto-Hedge runs on Base mainnet." : "All three actions run on Base Sepolia."}
          </p>
        </div>
      </Disclosure>
    </div>
  </section>;
}

/** The verdict as a sentence, so a hold reads as a decision rather than as
 *  nothing having happened. */
function headline(agent: AgentStatus | null, error: boolean) {
  if (error || agent?.worker === "error" || agent?.worker === "stale") return "Checks have stopped";
  if (!agent?.latest) return "Waiting for the first check";
  const action = agent.latest.decision?.action;
  if (action === "HOLD") return "Holding — nothing needs doing";
  if (action === "CLOSE") return "Closing the position";
  if (action === "ROLL") return "Rolling the position";
  if (action === "HEDGE") return "Buying protection";
  return shortDecisionText(agent.latest);
}

function Fact({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2">
      <span className="text-[12px] text-muted">{label}</span>
      <span className={`max-w-[46ch] text-right text-[12px] ${tone ?? "text-fg"}`}>{value}</span>
    </div>
  );
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
function Assessment({ latest }: { latest: NonNullable<AgentStatus["latest"]> }) {
  const decision = latest.decision!;
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        {latest.health && <span className={`text-[12px] font-semibold ${HEALTH_TONE[latest.health] ?? "text-fg"}`}>{sentenceCase(latest.health)}</span>}
        {decision.urgency && <span className="text-[12px] text-faint">{decision.urgency.toLowerCase()} urgency</span>}
        {decision.riskBefore != null && <span className="num text-[12px] text-faint">risk {decision.riskBefore.toFixed(1)} / 100</span>}
      </div>

      {decision.alternatives.length > 0 && (
        <div className="mt-2">
          <p className="text-[12px] font-semibold text-fg">Considered and not taken</p>
          <div className="rowlist mt-0.5">
            {decision.alternatives.map((alternative) => (
              <div key={alternative.action} className="flex items-baseline gap-3 py-1.5">
                <span className="w-[46px] shrink-0 text-[12px] font-semibold text-muted">{alternative.action}</span>
                <span className="text-[12px] leading-relaxed text-faint">
                  {alternative.rejected}
                  {alternative.estimatedCostUsd != null && alternative.estimatedCostUsd !== 0 && (
                    <span className="num">
                      {" "}({alternative.estimatedCostUsd < 0 ? "returns" : "costs"} ${Math.abs(alternative.estimatedCostUsd).toLocaleString("en-US", { maximumFractionDigits: 2 })})
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {decision.reasonCodes.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {decision.reasonCodes.map((code) => (
            <span key={code} className="rounded bg-panel2 px-1.5 py-0.5 font-mono text-[11px] text-faint">{code}</span>
          ))}
        </div>
      )}
    </div>
  );
}

const OUTCOME_LABEL: Record<string, string> = {
  "risk-below-threshold": "Waiting: live risk is below the signed threshold.",
  "risk-persistence-pending": "Waiting: qualifying risk has not persisted long enough.",
  "risk-observation-submitted": "Risk evidence submitted; awaiting confirmation.",
  "risk-observation-simulated": "Dry-run: risk evidence validated, not broadcast.",
  "risk-reset-submitted": "Risk reset submitted; awaiting confirmation.",
  "risk-reset-simulated": "Dry-run: risk reset validated, not broadcast.",
  "quote-unavailable": "Waiting: no fresh listed order satisfies the policy.",
  "gas-unfunded": "Waiting: the account needs more ETH for gas.",
  "pending-user-operation": "Waiting for the prior transaction's receipt.",
  "fill-submitted": "Auto-Hedge: fill submitted; awaiting confirmation.",
  "close-submitted": "Auto-Close: exit submitted; awaiting confirmation.",
  "roll-submitted": "Auto-Roll: close-and-replace submitted; awaiting confirmation.",
  "holding": "Holding — no action cleared every gate.",
  "recommendation": "Recommendation only — cannot be executed here.",
  "fill-simulated": "Dry-run: a fresh quote passed every check; no fill broadcast.",
};

/** Used when there's no Assessment box below to carry the explanation. */
function decisionText(latest: NonNullable<AgentStatus["latest"]>) {
  const label = OUTCOME_LABEL[latest.outcome] ?? latest.outcome;
  return latest.detail ? `${label} ${latest.detail}` : label;
}

/** Used when the Assessment box already explains the outcome below. */
function shortDecisionText(latest: NonNullable<AgentStatus["latest"]>) {
  return OUTCOME_LABEL[latest.outcome] ?? latest.outcome;
}

function sentenceCase(value: string) {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

function duration(seconds: number) {
  return seconds < 60 ? `${Math.max(0, seconds)} seconds` : `${Math.ceil(seconds / 60)} minutes`;
}

function timeAgo(value: string, now: number | null) {
  if (now == null) return "just now";
  const seconds = Math.max(0, now - Math.floor(Date.parse(value) / 1_000));
  return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`;
}
