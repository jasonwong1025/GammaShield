// Risk trend, derived from the observation samples the policy account stores.
//
// The account is the only durable home for this history: nothing off-chain
// outlives a worker restart, and a trend computed from numbers the agent could
// have replaced at will would not be evidence of anything. So the agent signs
// observations, the account keeps a bounded ring of them, and the rate of
// change is computed here — never asserted by the agent.
//
// Pure. Samples are passed in.

import { type RiskTrend, TREND_ACCELERATING, TREND_COOLING } from "./types";

/** One retained observation, as the account returns it. */
export type RiskSample = {
  observedAt: number;
  bookScoreBps: number;
  positionScoreBps: number;
};

export type TrendSubject = "book" | "position";

const WINDOWS = { oneHour: 3600, sixHours: 6 * 3600, twentyFourHours: 24 * 3600 } as const;

/**
 * How much slack to allow when deciding whether the history reaches back far
 * enough. The agent observes hourly, so the oldest sample is rarely exactly on
 * a window boundary; without slack the 1h delta would read as unknown almost
 * always. A tenth of the window is generous enough to be useful and tight
 * enough that a "24h change" is never really a 12h change.
 */
const WINDOW_SLACK = 0.1;

const scoreOf = (sample: RiskSample, subject: TrendSubject) =>
  (subject === "book" ? sample.bookScoreBps : sample.positionScoreBps) / 100;

/**
 * Change in score over each window, in points.
 *
 * A window whose history does not reach back far enough returns **null**, not
 * 0. That distinction matters: 0 says "risk is flat", null says "we cannot
 * tell yet", and a caller that conflates them will report a calm position
 * during its first hours of monitoring.
 */
export function riskTrendFrom(samples: RiskSample[], subject: TrendSubject, nowSec: number): RiskTrend {
  const ordered = [...samples].sort((a, b) => a.observedAt - b.observedAt);
  if (ordered.length === 0) {
    return { oneHour: null, sixHours: null, twentyFourHours: null, historySeconds: 0, samples: 0 };
  }

  const newest = ordered[ordered.length - 1]!;
  const oldest = ordered[0]!;
  const current = scoreOf(newest, subject);
  const historySeconds = Math.max(0, newest.observedAt - oldest.observedAt);

  const deltaOver = (windowSeconds: number): number | null => {
    // One sample cannot describe a change, however old it is.
    if (ordered.length < 2) return null;
    if (historySeconds < windowSeconds * (1 - WINDOW_SLACK)) return null;
    const target = nowSec - windowSeconds;
    // The sample nearest the window's start, so a slightly irregular
    // observation cadence does not distort the comparison.
    let nearest = ordered[0]!;
    for (const sample of ordered) {
      if (Math.abs(sample.observedAt - target) < Math.abs(nearest.observedAt - target)) nearest = sample;
    }
    if (nearest.observedAt >= newest.observedAt) return null;
    return round1(current - scoreOf(nearest, subject));
  };

  return {
    oneHour: deltaOver(WINDOWS.oneHour),
    sixHours: deltaOver(WINDOWS.sixHours),
    twentyFourHours: deltaOver(WINDOWS.twentyFourHours),
    historySeconds,
    samples: ordered.length,
  };
}

/** The longest window the history can actually describe, for the UI to label. */
export function trendCoverage(trend: RiskTrend): "none" | "1h" | "6h" | "24h" {
  if (trend.twentyFourHours !== null) return "24h";
  if (trend.sixHours !== null) return "6h";
  if (trend.oneHour !== null) return "1h";
  return "none";
}

/** The trend the decision layer acts on: the longest measured window, so a
 *  single hour's wobble does not read as a regime change. */
export function effectiveTrend(trend: RiskTrend): number | null {
  return trend.sixHours ?? trend.oneHour ?? null;
}

export const isAccelerating = (trend: RiskTrend): boolean => (effectiveTrend(trend) ?? 0) >= TREND_ACCELERATING;
export const isCooling = (trend: RiskTrend): boolean => (effectiveTrend(trend) ?? 0) <= TREND_COOLING;

/** Human summary, or an explicit statement that history is too short. */
export function describeTrend(trend: RiskTrend): string {
  const value = effectiveTrend(trend);
  if (value === null) {
    const hours = Math.floor(trend.historySeconds / 3600);
    return trend.samples === 0
      ? "no observations recorded yet"
      : `only ${hours > 0 ? `${hours}h` : "minutes"} of history across ${trend.samples} observation${trend.samples === 1 ? "" : "s"} — too short to read a trend`;
  }
  const window = trend.sixHours !== null ? "6h" : "1h";
  if (value > 0) return `up ${value.toFixed(1)} points over ${window}`;
  if (value < 0) return `down ${Math.abs(value).toFixed(1)} points over ${window}`;
  return `flat over ${window}`;
}

const round1 = (value: number) => Math.round(value * 10) / 10;
