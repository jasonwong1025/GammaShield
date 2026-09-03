// Pure thesis logic: what a recorded view means, and whether it still holds.
//
// Split from ./thesis.ts, which is the STORE. That file touches the filesystem
// and recovers signatures, so it is server-only; these rules have to run in the
// browser (to preview a view before signing), on the server (to decide), and
// in the self-check. Keeping them apart is what lets all three share one
// implementation instead of three that can disagree.

import { THESIS_BREAK_MOVE, TRADING_OBJECTIVES, type ThesisDirection, type ThesisVerdict, type TradingObjective, type TradingThesis } from "./types";

const DIRECTIONS: ThesisDirection[] = ["BULLISH", "BEARISH", "NEUTRAL"];

/** One thesis, flattened for a wallet prompt. Lives here, in the pure module,
 *  so the browser that signs and the server that verifies build the same
 *  string from the same code — a duplicated format would drift silently and
 *  every signature would start failing for no visible reason. */
export const describeThesis = (thesis: TradingThesis | null): string =>
  thesis === null
    ? "none"
    : [
        thesis.direction,
        thesis.objective,
        `target=${thesis.targetPrice ?? "none"}`,
        `reference=${thesis.referenceSpot ?? "none"}`,
        `horizon=${thesis.horizonEndsAt ?? "open"}`,
      ].join(" ");

/** The exact message an owner signs to store a thesis record. */
export function thesisMessage(
  account: string,
  network: string,
  record: { standing: TradingThesis | null; positions: Record<string, TradingThesis>; updatedAt: number },
): string {
  const positions = Object.keys(record.positions)
    .sort()
    .map((id) => `  ${id}: ${describeThesis(record.positions[id]!)}`);
  return [
    "GammaShield agent thesis",
    `account: ${account.toLowerCase()}`,
    `network: ${network}`,
    `standing: ${describeThesis(record.standing)}`,
    `positions:${positions.length ? `\n${positions.join("\n")}` : " none"}`,
    `updatedAt: ${record.updatedAt}`,
  ].join("\n");
}


/**
 * Whether the recorded view still holds, judged only on things that can be
 * measured: spot moving hard against the direction, the horizon elapsing, or
 * the target being reached.
 *
 * This is the DETERMINISTIC half. The AI may also judge a thesis broken for
 * reasons no rule here covers, and policy.ts lets it initiate a close on that
 * basis — but only a close, and only inside the signed limits.
 */
export function evaluateThesis(thesis: TradingThesis | null, spot: number, nowSec: number): ThesisVerdict {
  if (!thesis) return { valid: true, reason: "no thesis was recorded for this position, so nothing can invalidate it" };

  if (thesis.horizonEndsAt !== null && nowSec >= thesis.horizonEndsAt) {
    return { valid: false, reason: "the time horizon the view was given has elapsed" };
  }

  if (thesis.referenceSpot !== null && thesis.referenceSpot > 0) {
    const move = (spot - thesis.referenceSpot) / thesis.referenceSpot;
    const against = thesis.direction === "BULLISH" ? -move : thesis.direction === "BEARISH" ? move : Math.abs(move);
    if (against >= THESIS_BREAK_MOVE) {
      return {
        valid: false,
        reason:
          thesis.direction === "NEUTRAL"
            ? `spot has moved ${pct(Math.abs(move))} from the ${usd(thesis.referenceSpot)} reference, against a neutral view`
            : `spot has moved ${pct(against)} against the ${thesis.direction.toLowerCase()} view taken at ${usd(thesis.referenceSpot)}`,
      };
    }
  }

  if (thesis.targetPrice !== null && thesis.targetPrice > 0) {
    const reached = thesis.direction === "BEARISH" ? spot <= thesis.targetPrice : spot >= thesis.targetPrice;
    if (reached && thesis.direction !== "NEUTRAL") {
      // Reaching a target does not break a view — it completes it. Whether
      // that means closing depends on the objective, which decision.ts reads.
      return { valid: true, reason: `the ${usd(thesis.targetPrice)} target has been reached` };
    }
  }

  return { valid: true, reason: "spot is still inside the range the view allows for" };
}

/** Whether the recorded target has been hit, which PROFIT_FROM_OPTIONS acts on. */
export function targetReached(thesis: TradingThesis | null, spot: number): boolean {
  if (!thesis?.targetPrice || thesis.targetPrice <= 0 || thesis.direction === "NEUTRAL") return false;
  return thesis.direction === "BEARISH" ? spot <= thesis.targetPrice : spot >= thesis.targetPrice;
}


export function isThesis(value: unknown): value is TradingThesis {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const thesis = value as TradingThesis;
  return (
    DIRECTIONS.includes(thesis.direction) &&
    TRADING_OBJECTIVES.includes(thesis.objective as TradingObjective) &&
    isOptionalPositive(thesis.targetPrice) &&
    isOptionalPositive(thesis.referenceSpot) &&
    isOptionalPositive(thesis.horizonEndsAt) &&
    (thesis.note === null || typeof thesis.note === "string")
  );
}


const isOptionalPositive = (value: unknown): boolean =>
  value === null || (typeof value === "number" && Number.isFinite(value) && value > 0);

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const usd = (value: number) => `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
