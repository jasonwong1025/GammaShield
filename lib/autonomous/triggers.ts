// The trigger layer: whether anything has changed enough to be worth a fresh
// assessment.
//
// The worker polls fast, and asking the model on every tick would be both
// wasteful and noisy. So a tick either clears a trigger and goes on to a full
// assessment, or it records the observation and stops.
//
// A trigger fails OPEN. When there is nothing to compare against — the first
// tick after a restart, or an unreadable history — this reports a trigger
// rather than staying quiet, because assessment is read-only and skipping one
// is the worse error.
//
// Pure. The previous observation is passed in.

import { isAccelerating } from "./trend";
import type { RiskTrend } from "./types";

/** The thresholds, all configurable per the spec. Defaults are chosen against
 *  this venue: BTC and ETH move a percent or two on an ordinary day, and the
 *  book's risk score is noisy at single points. */
export type AutonomousTriggers = {
  /** Points of risk change, either direction. */
  riskChangeThreshold: number;
  /** Fractional change in the book's average implied vol. */
  ivChangeThreshold: number;
  /** Fractional spot move. */
  priceMoveThreshold: number;
  /** Days to expiry at or under which every tick assesses. */
  criticalDaysToExpiry: number;
  /** Fractional change in position value against entry. */
  pnlChangeThreshold: number;
  /** Longest quiet period before assessing anyway, seconds. */
  maxQuietSeconds: number;
};

export const DEFAULT_TRIGGERS: AutonomousTriggers = {
  riskChangeThreshold: 5,
  ivChangeThreshold: 0.1,
  priceMoveThreshold: 0.02,
  criticalDaysToExpiry: 2,
  pnlChangeThreshold: 0.2,
  // An hour, which is also the observation cadence the on-chain history needs
  // to keep its 1h/6h/24h windows meaningful.
  maxQuietSeconds: 3600,
};

/** What one tick observed, kept so the next tick has something to compare. */
export type TriggerObservation = {
  at: number;
  bookRiskScore: number;
  positionRiskScore: number | null;
  spot: number;
  avgIv: number | null;
  regime: "dampening" | "amplifying" | "neutral";
  positionValueUsd: number | null;
};

export type TriggerVerdict = {
  triggered: boolean;
  /** Every reason that fired, most specific first. Empty when quiet. */
  reasons: string[];
};

/** Triggers the spec asked for that this venue cannot support, with why. */
export const UNSOURCEABLE_TRIGGERS = [
  {
    key: "liquidityDeterioration",
    reason:
      "only the current market-maker quote is available; no spread history is retained, so deterioration cannot be measured",
  },
  {
    key: "marketImpactIncrease",
    reason:
      "the market-impact model reports a size threshold rather than a scalar score, so there is no single number to compare against a previous tick",
  },
];

export function evaluateTriggers({
  previous,
  current,
  trend,
  daysToExpiry,
  triggers = DEFAULT_TRIGGERS,
}: {
  previous: TriggerObservation | null;
  current: TriggerObservation;
  trend: RiskTrend;
  /** Of the open position, or null when nothing is open. */
  daysToExpiry: number | null;
  triggers?: AutonomousTriggers;
}): TriggerVerdict {
  const reasons: string[] = [];

  // Nothing to compare against: assess, and say why rather than pretending a
  // threshold was crossed.
  if (!previous) return { triggered: true, reasons: ["first assessment since this worker started"] };

  if (daysToExpiry !== null && daysToExpiry <= triggers.criticalDaysToExpiry) {
    reasons.push(`expiry is ${daysToExpiry <= 0 ? "due" : `${daysToExpiry.toFixed(1)} days away`}, inside the critical window`);
  }

  const riskChange = Math.abs(current.bookRiskScore - previous.bookRiskScore);
  if (riskChange >= triggers.riskChangeThreshold) {
    reasons.push(`book risk moved ${riskChange.toFixed(1)} points`);
  }

  if (current.positionRiskScore !== null && previous.positionRiskScore !== null) {
    const change = Math.abs(current.positionRiskScore - previous.positionRiskScore);
    if (change >= triggers.riskChangeThreshold) reasons.push(`position risk moved ${change.toFixed(1)} points`);
  }

  const move = previous.spot > 0 ? Math.abs(current.spot - previous.spot) / previous.spot : 0;
  if (move >= triggers.priceMoveThreshold) reasons.push(`spot moved ${(move * 100).toFixed(2)}%`);

  if (current.avgIv !== null && previous.avgIv !== null && previous.avgIv > 0) {
    const ivChange = Math.abs(current.avgIv - previous.avgIv) / previous.avgIv;
    if (ivChange >= triggers.ivChangeThreshold) {
      reasons.push(`the book's average implied vol moved ${(ivChange * 100).toFixed(1)}%`);
    }
  }

  if (current.regime !== previous.regime) {
    reasons.push(`dealer gamma flipped from ${previous.regime} to ${current.regime}`);
  }

  if (
    current.positionValueUsd !== null &&
    previous.positionValueUsd !== null &&
    previous.positionValueUsd > 0
  ) {
    const change = Math.abs(current.positionValueUsd - previous.positionValueUsd) / previous.positionValueUsd;
    if (change >= triggers.pnlChangeThreshold) {
      reasons.push(`the position's value moved ${(change * 100).toFixed(1)}%`);
    }
  }

  if (isAccelerating(trend)) reasons.push("risk is accelerating");

  const quiet = current.at - previous.at;
  if (quiet >= triggers.maxQuietSeconds) {
    reasons.push(`nothing had been assessed for ${Math.floor(quiet / 60)} minutes`);
  }

  return { triggered: reasons.length > 0, reasons };
}
