// Shared shapes for the autonomous position-management layer.
//
// This layer answers one question on a loop: given a position that already
// exists, is holding it still the best of the four things we could do? It
// consumes lib/engine.ts (book structure) and lib/contractRisk.ts (per-contract
// risk) and never recomputes either.
//
// Two shapes here are deliberately narrower than they look:
//
//   1. Every RiskTrend window is `number | null`. Null means the retained
//      history does not reach back that far. It is never 0, because a flat
//      trend and an unknown trend are different facts and a reader acts on
//      them differently.
//   2. There is no `confidence` on a decision. A model's self-reported
//      confidence is not calibrated, nothing downstream gates on it, and
//      printing one would imply a measurement we did not make.

import type { OptionsAsset } from "../assets";

// --- What the user wanted ---

export type TradingObjective = "ACQUIRE_CRYPTO" | "PROFIT_FROM_OPTIONS" | "HEDGE_EXISTING_POSITION";

export const TRADING_OBJECTIVES: TradingObjective[] = [
  "ACQUIRE_CRYPTO",
  "PROFIT_FROM_OPTIONS",
  "HEDGE_EXISTING_POSITION",
];

export const OBJECTIVE_LABEL: Record<TradingObjective, string> = {
  ACQUIRE_CRYPTO: "Acquire crypto",
  PROFIT_FROM_OPTIONS: "Profit from options",
  HEDGE_EXISTING_POSITION: "Hedge an existing position",
};

export const OBJECTIVE_DESCRIPTION: Record<TradingObjective, string> = {
  ACQUIRE_CRYPTO: "Prefer keeping directional exposure. Roll rather than close when the view still holds.",
  PROFIT_FROM_OPTIONS: "Take profit when the target is reached. Closing a winner is the point.",
  HEDGE_EXISTING_POSITION: "Protection is the job. Keep cover on while the risk it covers is live.",
};

export type ThesisDirection = "BULLISH" | "BEARISH" | "NEUTRAL";

/**
 * Why a position was opened. Nothing on-chain records this, so it is captured
 * from the user and stored off-chain; a position opened before this feature,
 * or outside GammaShield, simply has none.
 *
 * `targetPrice` and `horizonEndsAt` are the only fields a deterministic rule
 * can test. `note` is the user's own words, kept for the explanation and never
 * parsed into a number.
 */
export type TradingThesis = {
  direction: ThesisDirection;
  objective: TradingObjective;
  /** Where the user expects spot to go. Null when they did not say. */
  targetPrice: number | null;
  /** When the view expires, unix seconds. Null when open-ended. */
  horizonEndsAt: number | null;
  /** Spot when the thesis was recorded — the reference an invalidation
   *  measures against. Without it, "spot moved against the view" is unanchored. */
  referenceSpot: number | null;
  note: string | null;
};

/** How far spot must move against a thesis before the view is treated as
 *  broken. Chosen to sit outside ordinary daily noise for BTC and ETH, so a
 *  single volatile session does not invalidate a two-week view. */
export const THESIS_BREAK_MOVE = 0.1;

export type ThesisVerdict = {
  valid: boolean;
  /** Plain-language reason, always present — including when still valid. */
  reason: string;
};

// --- What the position is ---

export type PositionState = {
  /** Stable identifier: the shadow receipt id, or the indexer's position id. */
  id: string;
  asset: OptionsAsset;
  isCall: boolean;
  strike: number;
  expiryTs: number;
  contracts: number;
  /** Premium paid per contract at entry, USD. Null when unknown — a position
   *  the agent did not open may have no recorded entry. */
  entryPremiumUsd: number | null;
  /** Best current MM bid per contract, USD. This is the exit value, and on
   *  Base mainnet it is quotable but not takeable. */
  markUsd: number | null;
  /** Best current MM ask per contract, USD — the replacement cost. */
  askUsd: number | null;
  pnlUsd: number | null;
};

// --- How risk is moving ---

export type RiskTrend = {
  /** Change in score over the window, in points. Null when history is short. */
  oneHour: number | null;
  sixHours: number | null;
  twentyFourHours: number | null;
  /** Span the retained samples actually cover, seconds. */
  historySeconds: number;
  samples: number;
};

/** Points of increase over six hours that counts as acceleration. */
export const TREND_ACCELERATING = 10;
/** Points of decrease over six hours that counts as cooling. */
export const TREND_COOLING = -10;

// --- What we decided ---

export type AutonomousAction = "HOLD" | "HEDGE" | "CLOSE" | "ROLL";
export type Urgency = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/**
 * Reason codes this system can actually source. Codes the spec asked for that
 * this venue cannot support are listed in UNSOURCEABLE_REASON_CODES with the
 * reason, rather than emitted as guesses.
 */
export const REASON_CODES = [
  "THESIS_INVALIDATED",
  "THESIS_HOLDS",
  "RISK_CRITICAL",
  "RISK_ACCELERATING",
  "RISK_COOLING",
  "RISK_NOT_PERSISTENT",
  "EXPIRY_NEAR",
  "LIQUIDITY_POOR",
  "BOOK_GAMMA_HOT",
  "PROFIT_TARGET_REACHED",
  "LOSS_BUDGET_NEAR",
  "ROLL_MORE_EFFICIENT",
  "HEDGE_COST_ACCEPTABLE",
  "NOTHING_OPEN",
  "COVER_ALREADY_OPEN",
  "ACTION_UNAVAILABLE",
  "ACTION_DISABLED",
  "INSUFFICIENT_HISTORY",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/**
 * The spec's remaining codes, and why each one cannot be emitted here. Every
 * entry traces to a datum the Thetanuts API does not publish for a position a
 * user already holds — greeks and IV ride on LISTED ORDERS only.
 */
export const UNSOURCEABLE_REASON_CODES: { code: string; reason: string }[] = [
  { code: "HIGH_IV", reason: "no implied vol is published for a held position, only for listed orders" },
  { code: "HIGH_TIME_DECAY", reason: "theta is published for listed orders only, and decay cannot be modelled without an IV" },
  { code: "DELTA_EXPOSURE_HIGH", reason: "no per-position greeks are published" },
  { code: "EXPECTED_REWARD_TOO_LOW", reason: "loss probability needs an IV this venue does not publish for a position" },
  { code: "LIQUIDITY_DETERIORATION", reason: "only the current quote is retained, so a spread trend cannot be measured" },
];

export const REASON_TEXT: Record<ReasonCode, string> = {
  THESIS_INVALIDATED: "the original view no longer holds",
  THESIS_HOLDS: "the original view still holds",
  RISK_CRITICAL: "risk on this position is extreme",
  RISK_ACCELERATING: "risk is rising quickly",
  RISK_COOLING: "risk is falling back",
  RISK_NOT_PERSISTENT: "risk has not stayed elevated long enough",
  EXPIRY_NEAR: "expiry is close",
  LIQUIDITY_POOR: "getting out of this contract is expensive",
  BOOK_GAMMA_HOT: "dealer gamma is amplifying moves in the wider book",
  PROFIT_TARGET_REACHED: "the price target has been reached",
  LOSS_BUDGET_NEAR: "the signed loss budget is nearly spent",
  ROLL_MORE_EFFICIENT: "replacing this contract costs less than the risk it removes",
  HEDGE_COST_ACCEPTABLE: "cover is affordable inside the signed limits",
  NOTHING_OPEN: "no position is open",
  COVER_ALREADY_OPEN: "cover is already in place",
  ACTION_UNAVAILABLE: "this deployment cannot execute that action",
  ACTION_DISABLED: "the action is switched off",
  INSUFFICIENT_HISTORY: "not enough observation history to judge the trend",
};

export type DecisionAlternative = {
  action: AutonomousAction;
  /** Why this action was not chosen. Always present. */
  rejected: string;
  estimatedRiskAfter: number | null;
  estimatedCostUsd: number | null;
};

export type AutonomousDecision = {
  action: AutonomousAction;
  /** The chosen candidate's own reason, unformatted — what the action was
   *  selected FOR. `explanation` wraps this with the measured context. */
  reason: string;
  urgency: Urgency;
  reasonCodes: ReasonCode[];
  /** Concise, user-facing, built from the reason codes and measured numbers. */
  explanation: string;
  riskBefore: number;
  estimatedRiskAfter: number | null;
  estimatedCostUsd: number | null;
  alternatives: DecisionAlternative[];
  /** True when the AI, not the deterministic gate, initiated this action.
   *  Only ever set on a CLOSE — see lib/autonomous/policy.ts. */
  aiInitiated: boolean;
  /** Set when execution is not possible here and the user must act. */
  recommendationOnly: boolean;
};

// --- Presentation ---

export type PositionHealth = "HEALTHY" | "WATCH" | "WARNING" | "CRITICAL";

/** Purely a presentation state. Nothing in the execution path reads it: the
 *  rate limits that matter are enforced by the account contract, and an
 *  AI-scored urgency is not allowed to shorten them. */
export function positionHealthOf(riskScore: number, trend: RiskTrend): PositionHealth {
  const rising = (trend.sixHours ?? 0) >= TREND_ACCELERATING;
  if (riskScore >= 85) return "CRITICAL";
  if (riskScore >= 67) return rising ? "CRITICAL" : "WARNING";
  if (riskScore >= 34) return rising ? "WARNING" : "WATCH";
  return rising ? "WATCH" : "HEALTHY";
}

export const HEALTH_LABEL: Record<PositionHealth, string> = {
  HEALTHY: "Healthy",
  WATCH: "Watch",
  WARNING: "Warning",
  CRITICAL: "Critical",
};
