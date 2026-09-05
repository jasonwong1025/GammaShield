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
  const [demoTriggering, setDemoTriggering] = useState(false);
  const [demoError, setDemoError] = useState<string | null>(null);
  // DEMO ONLY — a tick run from the button, held apart from `agent` so the
  // 15s poll below cannot overwrite it. On a serverless deployment that poll
  // reads a state file no worker ever wrote, so it always answers
  // "not-reporting" and would otherwise wipe a real result off the screen a
  // few seconds after the click.
  const [demoLatest, setDemoLatest] = useState<AgentStatus | null>(null);

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

  // DEMO ONLY — runs one manual assessment tick against the Base Sepolia
  // shadow book instead of waiting on the polling worker. Renders straight
  // from this request's own response rather than re-polling /api/agent-status
  // afterward: that endpoint reads a state file written by the worker script,
  // and on a serverless deployment (Vercel) a later request has no guarantee
  // of landing on the same instance or disk, so a second fetch here could
  // show stale or empty data even though this tick genuinely ran. Kept
  // independent of the polling effect above rather than sharing its
  // callback, since this only ever runs from a click, never inside an
  // effect. Delete alongside app/api/demo/agent-tick/route.ts after the
  // presentation.
  const triggerDemoTick = async () => {
    setDemoTriggering(true);
    setDemoError(null);
    try {
      const response = await fetch("/api/demo/agent-tick", { method: "POST" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error ?? `demo tick ${response.status}`);
      const results = Array.isArray(payload?.results) ? payload.results : [];
      const mine = results.find((entry: { account?: string }) => entry.account?.toLowerCase() === account.toLowerCase());
      if (!mine) {
        throw new Error(
          `the tick ran, but returned no result for ${account.slice(0, 6)}…${account.slice(-4)} — this page may be showing a different policy account than the agent found.`,
        );
      }
      setDemoLatest((previous) => ({
        dryRun: previous?.dryRun ?? false,
        command: previous?.command ?? "npm run agent:shadow",
        worker: "checking",
        latest: {
          outcome: mine.outcome,
          detail: mine.detail ?? null,
          score: mine.score ?? null,
          threshold: mine.threshold ?? null,
          checkedAt: new Date().toISOString(),
          userOpHash: mine.userOpHash ?? null,
          health: mine.health ?? null,
          decision: mine.decision ?? null,
        },
        recent: previous?.recent ?? null,
      }));
      setAgentError(false);
    } catch (error) {
      setDemoError(error instanceof Error ? error.message : "demo tick failed");
    } finally {
      setDemoTriggering(false);
    }
  };

  // The button's own result wins over the background poll: on a
  // serverless deployment the poll has no state file to read and would
  // otherwise erase a real tick from the panel seconds after the click.
  const status = demoLatest ?? agent;

  const score = riskState ? Number(riskState[0]) / 100 : null;
  const eligibleSince = riskState ? Number(riskState[1]) : 0;
  const observedAt = riskState ? Number(riskState[2]) : 0;
  const validUntil = riskState ? Number(riskState[3]) : 0;
  const threshold = mandate ? Number(mandate.riskThresholdBps) / 100 : status?.latest?.threshold ?? null;
  const persistenceSeconds = mandate ? Number(mandate.persistenceSeconds) : 0;
  const evidence = isRiskPending ? "checking on-chain evidence…" : riskError ? "unavailable — Base RPC read failed" : !observedAt ? "not observed yet" : `${score?.toFixed(2)} / 100${now != null && validUntil <= now ? " — expired" : ""}`;
  const persistenceEndsAt = eligibleSince + persistenceSeconds;
  const persistence = !observedAt || !eligibleSince ? "No qualifying on-chain risk observation yet." : now == null ? "Checking whether the risk observation is still valid…" : validUntil <= now ? "The last risk observation expired; the worker must refresh it." : now < persistenceEndsAt ? `Risk evidence is eligible; ${duration(persistenceEndsAt - now)} remains before a fill can be considered.` : "Risk persistence requirement is satisfied; a fresh eligible quote is still required.";

  // Sepolia is where the demo button lives. With a worker running (local
  // dev) the poll returns real status and the on-demand branch never
  // applies; without one (any serverless deployment) it keeps the panel
  // from alarming about a worker that was never meant to exist there.
  const onDemand = network === "sepolia";
  const monitoring = monitoringSummary(status, agentError, now, onDemand);
  return <section aria-label="Agent monitoring">
    <div className="agent-monitor" data-state={monitoring.state}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="eyebrow text-[11px] text-faint">Monitoring</p>
          <h3 className="mt-1 text-[15px] font-bold tracking-[-0.01em] text-fg">{monitoring.title}</h3>
        </div>
        <span className={`chip text-[11px] font-semibold ${monitoring.tone}`}>{monitoring.badge}</span>
      </div>
      <p className="mt-2 max-w-[62ch] text-[13px] leading-relaxed text-muted">{monitoring.detail}</p>
    </div>

    {/* Consequential enough to stay in view: one says the AI started this
        itself, the other that nothing was actually executed. */}
    {status?.latest?.decision?.aiInitiated && (
      <p className="note mt-2.5 text-[12px] leading-relaxed text-muted" style={{ borderLeftColor: "var(--blue)", background: "var(--blue-soft)" }}>
        The AI raised this exit itself, on a broken thesis — the one action it may start rather than only narrow. It still had to
        pass the signed policy, and it is always the whole position.
      </p>
    )}
    {status?.latest?.decision?.recommendationOnly && (
      <p className="note mt-2.5 text-[12px] leading-relaxed text-muted" style={{ borderLeftColor: "var(--warn)", background: "color-mix(in srgb, var(--warn) 8%, transparent)" }}>
        {network === "mainnet"
          ? "Base mainnet has no way to execute this. A Thetanuts option can be closed only bilaterally, the OptionBook exposes no maker orders to end users, and an RFQ mints a new option rather than buying this one back — so this is priced for you to act on, not executed."
          : "This deployment cannot execute the action, so it is a recommendation only."}
      </p>
    )}

    {monitoring.needsDeveloperSetup && (
      <div className="mt-2.5">
        <Disclosure label="Developer setup">
          <p className="mt-2.5 text-[12px] leading-relaxed text-faint">
            For a local demo, run <code className="font-mono text-fg">{agent?.command ?? (network === "mainnet" ? "npm run agent:thetanuts" : "npm run agent:shadow")}</code> alongside this app.
          </p>
        </Disclosure>
      </div>
    )}

    {/* DEMO ONLY — delete this block and app/api/demo/agent-tick/route.ts
        after the presentation. Runs one real assessment tick on demand
        instead of waiting for the polling worker; Sepolia only, and the
        route itself refuses outside development regardless. */}
    {network === "sepolia" && (
      <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          onClick={() => void triggerDemoTick()}
          disabled={demoTriggering}
          className="h-8 rounded-lg border border-edge px-3 text-[12px] font-semibold text-fg hover:bg-panel2 disabled:cursor-wait disabled:opacity-60"
        >
          {demoTriggering ? "Running agent check…" : "Run agent check now (demo)"}
        </button>
        {demoError && <span className="text-[12px] text-crit">{demoError}</span>}
      </div>
    )}

    <div className="mt-2.5">
      <Disclosure label={status?.latest?.decision ? "Why this, and not the others?" : "Show what it checks"}>
        <div className="mt-2.5">
          {status?.latest?.decision && <Assessment latest={status.latest} />}
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
function monitoringSummary(agent: AgentStatus | null, error: boolean, now: number | null, onDemand: boolean) {
  // `onDemand` means checks are run from the button rather than by a
  // background worker — the case on any serverless deployment, where
  // /api/agent-status reads a state file nothing ever writes. Reporting a
  // missing worker as "needs attention" there is alarming and wrong: there
  // is no worker to be unhealthy. It reads as ready-to-check instead, and
  // only a real assessment replaces it.
  const idle = !agent || agent.worker === "not-reporting" || agent.worker === "awaiting-first-check" ||
    agent.worker === "error" || agent.worker === "stale" || !agent.latest;
  if (onDemand && idle) {
    return { state: "waiting", title: "Ready to check", badge: "On demand", tone: "text-muted",
      detail: "Checks run when you ask for one here. Run a check to assess the live book against your signed limits.",
      needsDeveloperSetup: false };
  }
  if (error) return { state: "attention", title: "Monitoring status is unavailable", badge: "Needs attention", tone: "text-crit", detail: "The app cannot read the monitoring service. Nothing will be filled until it recovers.", needsDeveloperSetup: false };
  if (!agent || agent.worker === "not-reporting") return { state: "waiting", title: "Monitoring has not started", badge: "Not started", tone: "text-warn", detail: "Your policy is active, but no monitoring service has reported yet. It cannot act until the first check arrives.", needsDeveloperSetup: true };
  if (agent.worker === "awaiting-first-check") return { state: "waiting", title: "Waiting for the first check", badge: "Starting", tone: "text-warn", detail: "Monitoring has not recorded a market check for this policy yet. It cannot act yet.", needsDeveloperSetup: true };
  if (agent.worker === "error" || agent.worker === "stale") return { state: "attention", title: "Monitoring needs attention", badge: agent.worker === "stale" ? "Stale" : "Error", tone: "text-crit", detail: "The last monitoring check did not complete. Nothing will be filled until a fresh check succeeds.", needsDeveloperSetup: false };
  if (!agent.latest) return { state: "waiting", title: "Waiting for the first check", badge: "Starting", tone: "text-warn", detail: "The monitoring service has not recorded a market decision for this policy yet.", needsDeveloperSetup: false };
  const title = headline(agent.latest);
  return {
    state: "checking",
    title,
    badge: `Checked ${timeAgo(agent.latest.checkedAt, now)}`,
    tone: "text-calm",
    detail: agent.latest.decision?.explanation ?? decisionText(agent.latest),
    needsDeveloperSetup: false,
  };
}

function headline(latest: NonNullable<AgentStatus["latest"]>) {
  const action = latest.decision?.action;
  if (action === "HOLD") return "Holding — nothing needs doing";
  if (action === "CLOSE") return "Closing the position";
  if (action === "ROLL") return "Rolling the position";
  if (action === "HEDGE") return "Buying protection";
  return shortDecisionText(latest);
}

function Fact({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2">
      <span className="text-[12px] text-muted">{label}</span>
      <span className={`max-w-[46ch] text-right text-[12px] ${tone ?? "text-fg"}`}>{value}</span>
    </div>
  );
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
