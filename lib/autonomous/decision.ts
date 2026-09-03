// The deterministic decision engine: given one position and everything
// measured about it, which of HOLD / HEDGE / CLOSE / ROLL is right.
//
// Every candidate is evaluated and every rejection is recorded, so the answer
// is never "risk > 70, therefore close". The precedence below is fixed and
// inspectable; the AI's part comes afterwards, in policy.ts, and can only
// narrow what this produced — with one bounded exception for a thesis-driven
// close, which policy.ts enforces the shape of.
//
// Two rules from the spec are load-bearing and easy to violate by accident:
//
//   * Never close on a temporary drawdown. Drawdown does not appear in this
//     file at all. A bought option's loss is its premium, fixed at entry, so a
//     mark that has fallen is not new information about risk.
//   * Never roll just because expiry is near. Expiry proximity is a necessary
//     condition for a roll here, never a sufficient one: the position must
//     also still be risky on its own terms, and the view behind it must hold.
//
// What the two risk scores arm is deliberately different. The BOOK score arms
// a hedge, because opening cover is a bet about the market regime. The
// PER-CONTRACT score arms a close or a roll, because exiting or replacing is a
// judgement about one position. They are not interchangeable and the account
// contract signs a separate threshold for each.
//
// Pure.

import {
  ROLL_WINDOW_SECONDS,
  type ActionAvailability,
  type AgentAction,
  type AgentDecision,
  type DeterministicIntent,
  type OpenPosition,
} from "./policy";
import { describeTrend, effectiveTrend, isCooling } from "./trend";
import {
  REASON_TEXT,
  TREND_ACCELERATING,
  TREND_COOLING,
  type AutonomousAction,
  type AutonomousDecision,
  type DecisionAlternative,
  type PositionState,
  type ReasonCode,
  type RiskTrend,
  type ThesisVerdict,
  type TradingObjective,
  type Urgency,
} from "./types";

/** Score at or above which a position is treated as critical regardless of
 *  what its signed trigger says. Matches contractRisk's "extreme" band. */
export const CRITICAL_RISK = 85;

/** Fraction of the signed loss budget that counts as nearly spent. */
export const LOSS_BUDGET_WARN = 0.9;

/** A position the agent is managing, plus what it is FOR. The distinction
 *  matters: cover becomes spare when the risk it covers goes away, whereas a
 *  directional position falling out of favour with the market is not a reason
 *  to abandon the view behind it. */
export type ManagedPosition = PositionState & {
  role: "cover" | "directional";
};

export type DecisionInput = {
  position: ManagedPosition | null;
  /** Book-level market-structure score and its signed trigger. Arms a hedge. */
  bookRiskScore: number;
  bookThreshold: number;
  /** Whether the book score has held above its trigger long enough on-chain. */
  bookPersistenceMet: boolean;
  /** Per-contract score of the held position and its signed trigger. Arms a
   *  close or a roll. Null when nothing is open, or when the position could
   *  not be priced — which is not the same as zero risk. */
  positionRiskScore: number | null;
  positionThreshold: number;
  trend: RiskTrend;
  thesis: ThesisVerdict;
  objective: TradingObjective | null;
  /** Whether the recorded price target has been reached. */
  targetReached: boolean;
  availability: ActionAvailability[];
  /** Contracts the signed limits allow for one new fill. */
  maxContracts: number;
  /** Premium for the cover or replacement the agent would buy, USD. Null when
   *  no quote could be obtained — which blocks buying, rather than guessing. */
  quotedPremiumUsd: number | null;
  /** Signed loss budget and how much of it is already spent, USD. */
  lossBudgetUsd: number;
  spentPremiumUsd: number;
  /** Whether this deployment can execute at all, or only recommend. */
  executable: boolean;
  nowSec: number;
};

type Candidate = {
  action: AutonomousAction;
  eligible: boolean;
  /** Why not — or, when eligible, what makes it a live option. */
  reason: string;
  codes: ReasonCode[];
  estimatedRiskAfter: number | null;
  estimatedCostUsd: number | null;
};

/**
 * Evaluate every action, then pick by fixed precedence.
 *
 * Precedence, highest first:
 *   1. CLOSE  — the view is broken, the target is met, or risk is extreme.
 *   2. ROLL   — the view holds but this contract is the wrong one to hold it in.
 *   3. HEDGE  — nothing is open and the market regime warrants cover.
 *   4. HOLD   — the default, and the only answer when nothing else clears.
 *
 * Close outranks roll because an exit needs no forward view to be safe, and
 * roll outranks hedge because replacing existing exposure is cheaper than
 * layering new exposure on top of it.
 */
export function decide(input: DecisionInput): AutonomousDecision {
  const candidates = [evaluateClose(input), evaluateRoll(input), evaluateHedge(input), evaluateHold(input)];
  const chosen = candidates.find((candidate) => candidate.eligible) ?? candidates[candidates.length - 1]!;

  const alternatives: DecisionAlternative[] = candidates
    .filter((candidate) => candidate.action !== chosen.action)
    .map((candidate) => ({
      action: candidate.action,
      rejected: candidate.reason,
      estimatedRiskAfter: candidate.estimatedRiskAfter,
      estimatedCostUsd: candidate.estimatedCostUsd,
    }));

  const riskBefore = input.positionRiskScore ?? input.bookRiskScore;
  const codes = dedupe([...chosen.codes, ...contextCodes(input)]);

  return {
    action: chosen.action,
    reason: chosen.reason,
    urgency: urgencyOf(input),
    reasonCodes: codes,
    explanation: explain(input, chosen, codes),
    riskBefore: round1(riskBefore),
    estimatedRiskAfter: chosen.estimatedRiskAfter,
    estimatedCostUsd: chosen.estimatedCostUsd,
    alternatives,
    aiInitiated: false,
    recommendationOnly: !input.executable && chosen.action !== "HOLD",
  };
}

// --- Candidates ---

function evaluateClose(input: DecisionInput): Candidate {
  const base = { action: "CLOSE" as const, estimatedCostUsd: proceedsOf(input), estimatedRiskAfter: 0 };
  const gate = actionGate(input, "close");
  if (!input.position) {
    return { ...base, eligible: false, reason: REASON_TEXT.NOTHING_OPEN, codes: ["NOTHING_OPEN"], estimatedRiskAfter: null };
  }
  if (gate) return { ...base, eligible: false, reason: gate.reason, codes: gate.codes };

  if (!input.thesis.valid) {
    return { ...base, eligible: true, reason: `the view behind this position no longer holds: ${input.thesis.reason}`, codes: ["THESIS_INVALIDATED"] };
  }

  // Taking profit is the whole point of one objective and beside the point of
  // another, so the same fact leads to different actions.
  if (input.targetReached && input.objective === "PROFIT_FROM_OPTIONS") {
    return { ...base, eligible: true, reason: "the price target has been reached and the objective is to profit from the option", codes: ["PROFIT_TARGET_REACHED"] };
  }

  const score = input.positionRiskScore;
  if (score !== null && score >= CRITICAL_RISK && !isCooling(input.trend)) {
    return { ...base, eligible: true, reason: `per-contract risk is ${score.toFixed(0)} and not falling`, codes: ["RISK_CRITICAL"] };
  }

  // Cover exists to offset a risk. When that risk goes away the cover is an
  // expense, not protection. A directional position gets no such treatment:
  // a calmer market is not a reason to abandon the view.
  if (input.position.role === "cover" && input.bookRiskScore < input.bookThreshold) {
    return { ...base, eligible: true, reason: "book risk has fallen back under the trigger, so this cover is spare", codes: ["RISK_COOLING"] };
  }

  if (input.spentPremiumUsd >= input.lossBudgetUsd * LOSS_BUDGET_WARN && input.position.role === "cover") {
    return { ...base, eligible: true, reason: `${usd(input.spentPremiumUsd)} of the ${usd(input.lossBudgetUsd)} loss budget is spent, so cover is no longer affordable`, codes: ["LOSS_BUDGET_NEAR"] };
  }

  return {
    ...base,
    eligible: false,
    reason: input.targetReached
      ? "the target is met, but this objective prefers keeping the exposure"
      : `the view still holds and per-contract risk is ${score === null ? "unpriced" : score.toFixed(0)}`,
    codes: ["THESIS_HOLDS"],
  };
}

function evaluateRoll(input: DecisionInput): Candidate {
  const base = {
    action: "ROLL" as const,
    // The replacement's own risk is not scored here: it is a different
    // contract and would need its own quote and greeks to score honestly.
    estimatedRiskAfter: null,
    // Net of the exit, since proceedsOf reports money in as a negative cost.
    estimatedCostUsd: input.quotedPremiumUsd === null ? null : round2(input.quotedPremiumUsd + (proceedsOf(input) ?? 0)),
  };
  const gate = actionGate(input, "roll");
  if (!input.position) return { ...base, eligible: false, reason: REASON_TEXT.NOTHING_OPEN, codes: ["NOTHING_OPEN"] };
  if (gate) return { ...base, eligible: false, reason: gate.reason, codes: gate.codes };

  if (!input.thesis.valid) {
    return { ...base, eligible: false, reason: "there is no point carrying a broken view into a new contract", codes: ["THESIS_INVALIDATED"] };
  }

  const secondsLeft = input.position.expiryTs - input.nowSec;
  if (secondsLeft > ROLL_WINDOW_SECONDS) {
    return { ...base, eligible: false, reason: `expiry is ${(secondsLeft / 86_400).toFixed(1)} days away, outside the roll window`, codes: [] };
  }

  // Expiry proximity alone is explicitly NOT sufficient. The position has to
  // still be risky on its own terms, or letting it expire is the cheaper
  // answer and the agent takes it.
  const score = input.positionRiskScore;
  if (score === null) {
    return { ...base, eligible: false, reason: "this position could not be priced, so there is nothing to say a replacement would be better", codes: [] };
  }
  if (score < input.positionThreshold) {
    return {
      ...base,
      eligible: false,
      reason: `expiry is close but per-contract risk is only ${score.toFixed(0)}, under the ${input.positionThreshold.toFixed(0)} trigger — letting it expire costs nothing`,
      codes: [],
    };
  }

  if (input.quotedPremiumUsd === null) {
    return { ...base, eligible: false, reason: "no replacement contract could be quoted", codes: [] };
  }
  if (!(input.maxContracts > 0)) {
    return { ...base, eligible: false, reason: "the signed limits leave no size for a replacement", codes: [] };
  }

  return {
    ...base,
    eligible: true,
    reason: `expiry is ${(Math.max(secondsLeft, 0) / 3600).toFixed(0)}h away and per-contract risk is still ${score.toFixed(0)}`,
    codes: ["EXPIRY_NEAR", "ROLL_MORE_EFFICIENT"],
  };
}

function evaluateHedge(input: DecisionInput): Candidate {
  const base = {
    action: "HEDGE" as const,
    // Deliberately null. A bought put bounds this account's loss; it does not
    // move the book's market-structure score, and claiming a lower score after
    // hedging would be inventing an effect the book is far too large to feel.
    estimatedRiskAfter: null,
    estimatedCostUsd: input.quotedPremiumUsd === null ? null : round2(input.quotedPremiumUsd),
  };
  const gate = actionGate(input, "hedge");
  if (gate) return { ...base, eligible: false, reason: gate.reason, codes: gate.codes };

  if (input.position) {
    return { ...base, eligible: false, reason: REASON_TEXT.COVER_ALREADY_OPEN, codes: ["COVER_ALREADY_OPEN"] };
  }
  if (input.bookRiskScore < input.bookThreshold) {
    return {
      ...base,
      eligible: false,
      reason: `book risk is ${input.bookRiskScore.toFixed(0)}, under the ${input.bookThreshold.toFixed(0)} trigger`,
      codes: [],
    };
  }
  if (!input.bookPersistenceMet) {
    return { ...base, eligible: false, reason: REASON_TEXT.RISK_NOT_PERSISTENT, codes: ["RISK_NOT_PERSISTENT"] };
  }
  if (input.quotedPremiumUsd === null) {
    return { ...base, eligible: false, reason: "no cover could be quoted inside the signed limits", codes: [] };
  }
  if (!(input.maxContracts > 0)) {
    return { ...base, eligible: false, reason: "the signed limits leave no executable size", codes: [] };
  }
  const remaining = input.lossBudgetUsd - input.spentPremiumUsd;
  if (input.quotedPremiumUsd > remaining) {
    return {
      ...base,
      eligible: false,
      reason: `cover costs ${usd(input.quotedPremiumUsd)} and only ${usd(remaining)} of the loss budget is left`,
      codes: ["LOSS_BUDGET_NEAR"],
    };
  }

  return {
    ...base,
    eligible: true,
    reason: `book risk has held at ${input.bookRiskScore.toFixed(0)} above the ${input.bookThreshold.toFixed(0)} trigger, and cover costs ${usd(input.quotedPremiumUsd)}`,
    codes: ["HEDGE_COST_ACCEPTABLE"],
  };
}

function evaluateHold(input: DecisionInput): Candidate {
  const score = input.positionRiskScore;
  const parts: string[] = [];
  if (score !== null) parts.push(`per-contract risk is ${score.toFixed(0)}`);
  parts.push(`book risk is ${input.bookRiskScore.toFixed(0)}`);
  parts.push(describeTrend(input.trend));
  if (input.position) parts.push(input.thesis.valid ? "and the view still holds" : "though the view is in question");
  return {
    action: "HOLD",
    eligible: true,
    reason: parts.join(", "),
    codes: input.position ? ["THESIS_HOLDS"] : ["NOTHING_OPEN"],
    estimatedRiskAfter: score,
    estimatedCostUsd: 0,
  };
}

/**
 * Adapt a decision into the shape the policy guard consumes.
 *
 * The guard's job is to intersect an intended action with the toggles, the
 * deployment's abilities and the AI's opinion. It does not need the reason
 * codes or the alternatives, so it does not receive them — which keeps the
 * decision engine and the guard independently testable.
 */
export function intentOf(decision: AutonomousDecision, position: OpenPosition | null): DeterministicIntent {
  const action: AgentDecision =
    decision.action === "HOLD" ? "hold" : (decision.action.toLowerCase() as AgentAction);
  return { action, position, reason: capitalize(decision.reason) };
}

// --- Shared gates ---

/** Toggle and deployment checks, which apply identically to every action and
 *  must be reported with a reason rather than silently skipped. */
function actionGate(input: DecisionInput, action: AgentAction): { reason: string; codes: ReasonCode[] } | null {
  const entry = input.availability.find((value) => value.action === action);
  if (!entry) return { reason: REASON_TEXT.ACTION_UNAVAILABLE, codes: ["ACTION_UNAVAILABLE"] };
  if (!entry.available) return { reason: entry.reason ?? REASON_TEXT.ACTION_UNAVAILABLE, codes: ["ACTION_UNAVAILABLE"] };
  if (!entry.enabled) return { reason: REASON_TEXT.ACTION_DISABLED, codes: ["ACTION_DISABLED"] };
  return null;
}

/** Proceeds a full exit would return, USD. Positive money in, so it is
 *  reported as a negative cost. */
function proceedsOf(input: DecisionInput): number | null {
  if (!input.position || input.position.markUsd === null) return null;
  return -round2(input.position.markUsd * input.position.contracts);
}

function contextCodes(input: DecisionInput): ReasonCode[] {
  const codes: ReasonCode[] = [];
  const trend = effectiveTrend(input.trend);
  if (trend === null) codes.push("INSUFFICIENT_HISTORY");
  else if (trend >= TREND_ACCELERATING) codes.push("RISK_ACCELERATING");
  else if (trend <= TREND_COOLING) codes.push("RISK_COOLING");
  if (input.position && input.position.expiryTs - input.nowSec <= ROLL_WINDOW_SECONDS) codes.push("EXPIRY_NEAR");
  return codes;
}

/**
 * Urgency, from measured facts only.
 *
 * This is presentation. Nothing in the execution path reads it: the
 * persistence window and the spend cooldown are enforced by the account
 * contract, and an urgency computed partly from a model's view is not allowed
 * to shorten either of them.
 */
function urgencyOf(input: DecisionInput): Urgency {
  const score = input.positionRiskScore ?? input.bookRiskScore;
  // Acceleration lifts urgency by one band. `risk 70 and rising` is a more
  // pressing situation than `risk 70 and falling`, which is the whole reason
  // the trend is measured and stored on-chain.
  const accelerating = (effectiveTrend(input.trend) ?? 0) >= TREND_ACCELERATING;
  if (!input.thesis.valid) return "HIGH";
  if (score >= CRITICAL_RISK) return accelerating ? "CRITICAL" : "HIGH";
  if (score >= 67) return accelerating ? "HIGH" : "MEDIUM";
  return accelerating ? "MEDIUM" : "LOW";
}

// --- Explanation ---

/** Concise and user-facing, built from the chosen candidate's own reason and
 *  the measured context. No chain of thought, and nothing here that was not
 *  measured somewhere upstream. */
function explain(input: DecisionInput, chosen: Candidate, codes: ReasonCode[]): string {
  const lines = [capitalize(chosen.reason) + "."];

  if (codes.includes("INSUFFICIENT_HISTORY")) {
    lines.push(`Trend: ${describeTrend(input.trend)}.`);
  } else {
    lines.push(`Risk is ${describeTrend(input.trend)}.`);
  }

  if (chosen.action === "CLOSE" && chosen.estimatedCostUsd !== null) {
    lines.push(`Exiting returns about ${usd(Math.abs(chosen.estimatedCostUsd))} at the current market-maker bid.`);
  }
  if (chosen.action === "HEDGE" && chosen.estimatedCostUsd !== null) {
    lines.push(`Cover costs about ${usd(chosen.estimatedCostUsd)}, which is the most it can lose.`);
  }
  if (chosen.action === "ROLL" && chosen.estimatedCostUsd !== null) {
    lines.push(`The replacement nets about ${usd(chosen.estimatedCostUsd)} after the exit proceeds.`);
  }
  if (!input.executable && chosen.action !== "HOLD") {
    lines.push("This deployment cannot execute it, so it is a recommendation only.");
  }
  return lines.join(" ");
}

const dedupe = <T,>(values: T[]): T[] => [...new Set(values)];
const round1 = (value: number) => Math.round(value * 10) / 10;
const round2 = (value: number) => Math.round(value * 100) / 100;
const capitalize = (value: string) => (value ? value[0]!.toUpperCase() + value.slice(1) : value);
const usd = (value: number) => `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
