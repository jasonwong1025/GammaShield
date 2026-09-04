"use client";

// AI strategy suggestion for one position you already hold.
//
// The verdict comes from lib/autonomous/decision.ts — the same engine the
// autonomous agent runs every cycle — so this panel and the agent can never
// tell you different things about the same position. The AI's contribution is
// the prose only; it is handed the finished verdict and cannot change it.
//
// Three things this panel is deliberately strict about:
//
//   1. It shows what is RIGHT, then separately whether it can be DONE. On Base
//      mainnet there is no way to sell an option you hold — close is bilateral,
//      the OptionBook takes no maker orders from users, and RFQ mints a new
//      option — so a sell verdict is priced at the market maker's live bid and
//      labelled as something you must act on yourself.
//   2. It names the two risk components this venue cannot supply for a held
//      position, rather than implying a six-part score.
//   3. Saving writes your VIEW, never the verdict. The verdict has to be
//      re-derived from live risk each cycle; storing it would let a stale
//      reading stand in for the risk gate.

import { useCallback, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import type { Address } from "viem";
import type { AutonomousDecision, ThesisDirection, TradingObjective, TradingThesis } from "@/lib/autonomous/types";
import { OBJECTIVE_LABEL, TRADING_OBJECTIVES } from "@/lib/autonomous/types";
import { thesisMessage } from "@/lib/autonomous/thesisRules";
import type { ExecutionNetwork } from "@/lib/explorer";
import { fmtUsd, riskColor } from "@/lib/format";
import { walletActionError } from "@/lib/walletChain";

type RiskComponentView = { key: string; label: string; score: number; weight: number };

type Strategy = {
  decision: AutonomousDecision;
  narrative: { text: string; model: string } | null;
  canExecute: boolean;
  blocker: string | null;
  exitValueUsd: number | null;
  risk: { score: number; level: string; components: RiskComponentView[]; dropped: { key: string; label: string; reason: string }[] } | null;
  heldPositionDrops: { key: string; label: string; reason: string }[];
  trend: { described: string };
  thesis: TradingThesis | null;
  thesisSource: "standing" | "position" | null;
  spot: number;
  bookRiskScore: number;
};

export type StrategyPosition = {
  id: string;
  asset: "BTC" | "ETH";
  isCall: boolean;
  strike: number;
  expiryTs: number;
  contracts: number;
  custody: "wallet" | "policy";
};

const VERDICT_COPY: Record<AutonomousDecision["action"], { label: string; blurb: string }> = {
  HOLD: { label: "Hold", blurb: "Keep it as it is" },
  HEDGE: { label: "Hedge", blurb: "Buy cover alongside it" },
  CLOSE: { label: "Sell", blurb: "Exit the position" },
  ROLL: { label: "Roll", blurb: "Replace it with a later contract" },
};

const URGENCY_TONE: Record<AutonomousDecision["urgency"], string> = {
  LOW: "text-calm",
  MEDIUM: "text-fg",
  HIGH: "text-warn",
  CRITICAL: "text-crit",
};

export function PositionStrategyPanel({
  position,
  network,
  policyAccount,
}: {
  position: StrategyPosition;
  network: ExecutionNetwork;
  /** The policy account holding the recorded view, when one is deployed. */
  policyAccount?: Address | null;
}) {
  const [strategy, setStrategy] = useState<Strategy | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [direction, setDirection] = useState<ThesisDirection>("NEUTRAL");
  const [objective, setObjective] = useState<TradingObjective>("PROFIT_FROM_OPTIONS");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const { signMessageAsync } = useSignMessage();
  const { address } = useAccount();

  const suggest = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/position-strategy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          network,
          positionId: position.id,
          asset: position.asset,
          isCall: position.isCall,
          strike: position.strike,
          expiryTs: position.expiryTs,
          contracts: position.contracts,
          custody: position.custody,
          policyAccount: policyAccount ?? undefined,
          walletAddress: address ?? undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `strategy ${response.status}`);
      setStrategy(data as Strategy);
      if (data.thesis) {
        setDirection(data.thesis.direction);
        setObjective(data.thesis.objective);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "suggestion failed");
    } finally {
      setLoading(false);
    }
  }, [address, network, policyAccount, position]);

  // Saves the VIEW behind this position, not the verdict. The agent re-derives
  // the verdict from live risk; what it cannot derive is why you opened it.
  const saveView = useCallback(async () => {
    if (!policyAccount || !strategy) return;
    setSaving(true);
    setError(null);
    try {
      const current = await fetch(`/api/agent-thesis?network=${network}&account=${policyAccount}`, { cache: "no-store" });
      const existing = current.ok ? await current.json() : { thesis: null, positionTheses: {} };
      const view: TradingThesis = {
        direction,
        objective,
        targetPrice: null,
        horizonEndsAt: position.expiryTs,
        referenceSpot: strategy.spot,
        note: null,
      };
      const record = {
        standing: (existing.thesis ?? null) as TradingThesis | null,
        positions: { ...((existing.positionTheses ?? {}) as Record<string, TradingThesis>), [position.id]: view },
        updatedAt: Math.floor(Date.now() / 1000),
      };
      const signature = await signMessageAsync({ message: thesisMessage(policyAccount, network, record) });
      const response = await fetch("/api/agent-thesis", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ network, account: policyAccount, ...record, signature }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `thesis ${response.status}`);
      setSaved(true);
    } catch (caught) {
      setError(`The view was not saved: ${walletActionError(caught, "the agent still uses the stored view.")}`);
    } finally {
      setSaving(false);
    }
  }, [direction, network, objective, policyAccount, position.expiryTs, position.id, signMessageAsync, strategy]);

  if (!strategy) {
    return (
      <div className="flex flex-col gap-2 text-[12px] font-sans">
        <p className="text-muted">
          Ask the agent&apos;s own decision engine what to do with this position — hold, hedge, sell or roll — with the reason each
          alternative lost.
        </p>
        <div>
          <button
            onClick={() => void suggest()}
            disabled={loading}
            className="h-8 rounded-lg bg-blue px-3 text-[11px] font-semibold text-white disabled:cursor-wait disabled:opacity-60"
          >
            {loading ? "Reading the book…" : "Suggest a strategy"}
          </button>
        </div>
        {error && <p className="text-[11px] text-crit">{error}</p>}
      </div>
    );
  }

  const { decision } = strategy;
  const copy = VERDICT_COPY[decision.action];
  // When the position itself could not be priced there is no per-contract
  // score, and the engine falls back to the book. Saying which is which
  // matters: they are different questions on different scales.
  const scored = strategy.risk !== null;
  const score = strategy.risk?.score ?? decision.riskBefore;

  return (
    <div className="flex flex-col gap-3 text-[12px] font-sans">
      {/* Verdict */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-panel3 px-2 py-1 text-[13px] font-bold text-fg">{copy.label}</span>
        <span className="text-muted">{copy.blurb}</span>
        <span className={`text-[11px] font-semibold ${URGENCY_TONE[decision.urgency]}`}>{decision.urgency} urgency</span>
        <span className="num text-[11px]" style={{ color: riskColor(score) }} title={scored ? "Per-contract risk for this position" : "This position could not be priced, so this is the book-level score"}>
          {scored ? "position" : "book"} risk {score.toFixed(0)} / 100
        </span>
      </div>

      {/* The AI's only contribution, clearly attributed. */}
      {strategy.narrative ? (
        <div className="rounded-lg border border-blue/30 bg-blue/5 p-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-blue">AI read</p>
          <p className="mt-1 leading-relaxed text-muted">{strategy.narrative.text}</p>
          <p className="mt-1 text-[10px] text-faint">
            Narration only, by {strategy.narrative.model}. The action above comes from the deterministic engine; the model cannot
            change it.
          </p>
        </div>
      ) : (
        <p className="leading-relaxed text-muted">{decision.explanation}</p>
      )}

      {/* Can it actually be done here? */}
      {decision.action !== "HOLD" && (
        <div
          className={`rounded-lg border p-2.5 leading-relaxed ${
            strategy.canExecute ? "border-calm/30 bg-calm/5 text-muted" : "border-warn/30 bg-warn/10 text-muted"
          }`}
        >
          {strategy.canExecute ? (
            <>
              <span className="font-semibold text-fg">The agent can do this</span> on its next cycle, if you have the matching
              action switched on in the AI Agent tab.
            </>
          ) : (
            <>
              <span className="font-semibold text-fg">You have to act on this yourself.</span> {strategy.blocker}
              {strategy.exitValueUsd !== null && (
                <>
                  {" "}
                  A market maker currently bids about{" "}
                  <span className="num font-semibold text-fg">{fmtUsd(strategy.exitValueUsd, false, 6)}</span> for the whole
                  position, so the exit is priced even though it cannot be taken here.
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* Why the other three lost — a hold has to read as a judgement. */}
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-faint">Not chosen, and why</p>
        <ul className="mt-1 grid gap-1">
          {decision.alternatives.map((alternative) => (
            <li key={alternative.action} className="flex gap-2 leading-relaxed">
              <span className="w-[46px] shrink-0 font-semibold text-fg">{VERDICT_COPY[alternative.action].label}</span>
              <span className="text-faint">{alternative.rejected}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* What the score is built from, and what it could not be built from. */}
      {!scored && (
        <p className="text-[10px] leading-relaxed text-faint">
          This position could not be priced, so it has no per-contract score and the reading rests on book structure alone.
        </p>
      )}

      {strategy.risk && (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-faint">Scored on</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {strategy.risk.components.map((component) => (
              <span key={component.key} className="rounded bg-panel2 px-1.5 py-0.5 text-[10px] text-muted">
                {component.label} <span className="num" style={{ color: riskColor(component.score) }}>{component.score.toFixed(0)}</span>
              </span>
            ))}
          </div>
          {strategy.heldPositionDrops.length > 0 && (
            <p className="mt-1.5 text-[10px] leading-relaxed text-faint">
              Not scored: {strategy.heldPositionDrops.map((drop) => drop.label).join(" and ")} — {strategy.heldPositionDrops[0]!.reason}.
            </p>
          )}
          <p className="mt-1 text-[10px] text-faint">Risk trend: {strategy.trend.described}.</p>
        </div>
      )}

      {/* The view, which is the one thing worth persisting. */}
      <div className="rounded-lg border border-edge bg-panel2 p-2.5">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-faint">The view behind this position</p>
        {strategy.thesis ? (
          <p className="mt-1 leading-relaxed text-muted">
            {strategy.thesis.direction.toLowerCase()} · {OBJECTIVE_LABEL[strategy.thesis.objective]}
            <span className="text-faint">
              {" "}
              ({strategy.thesisSource === "position" ? "set for this position" : "the standing view"})
            </span>
          </p>
        ) : (
          <p className="mt-1 leading-relaxed text-faint">
            None recorded, so nothing about your intent could be weighed — only risk. {policyAccount
              ? "Set one below and the agent will use it."
              : "Deploy a policy account in the AI Agent tab to record one."}
          </p>
        )}

        {policyAccount ? (
          <>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select
                value={direction}
                onChange={(event) => { setDirection(event.target.value as ThesisDirection); setSaved(false); }}
                className="h-7 rounded-md border border-edge bg-panel px-2 text-[11px] font-semibold text-fg"
              >
                <option value="BULLISH">Bullish</option>
                <option value="BEARISH">Bearish</option>
                <option value="NEUTRAL">Neutral</option>
              </select>
              <select
                value={objective}
                onChange={(event) => { setObjective(event.target.value as TradingObjective); setSaved(false); }}
                className="h-7 rounded-md border border-edge bg-panel px-2 text-[11px] font-semibold text-fg"
              >
                {TRADING_OBJECTIVES.map((value) => (
                  <option key={value} value={value}>{OBJECTIVE_LABEL[value]}</option>
                ))}
              </select>
              <button
                onClick={() => void saveView()}
                disabled={saving}
                className="h-7 rounded-lg bg-blue px-2.5 text-[11px] font-semibold text-white disabled:cursor-wait disabled:opacity-60"
              >
                {saving ? "Confirm in wallet…" : "Save as this position's view"}
              </button>
              {saved && <span className="text-[11px] text-calm">Saved.</span>}
            </div>
            <p className="mt-1.5 text-[10px] leading-relaxed text-faint">
              This saves the view, not the verdict. The agent re-derives what to do from live risk on every cycle, so a reading
              taken now can never stand in for the risk gate later.
            </p>
          </>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <button onClick={() => void suggest()} disabled={loading} className="text-[11px] text-blue hover:underline disabled:opacity-60">
          {loading ? "Re-reading…" : "Re-run"}
        </button>
        {error && <span className="text-[11px] text-crit">{error}</span>}
      </div>
    </div>
  );
}
