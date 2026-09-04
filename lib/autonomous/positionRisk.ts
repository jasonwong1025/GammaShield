// Per-contract risk for a position the user already HOLDS.
//
// This is lib/contractRisk.ts applied to a different subject. Scoring a
// contract you are considering buying is easy: the book publishes greeks and an
// implied vol alongside the order. Scoring one you already own is not, because
// Thetanuts attaches greeks and IV to LISTED ORDERS and to nothing else. There
// is no per-position greeks feed, and no open interest anywhere on the venue.
//
// So the implied-vol inputs are passed as null and contractRisk.ts drops what
// it cannot compute, renormalizing the surviving weights. That is its existing
// rule, not a special case invented here, and it is why this file adds no math:
// it assembles honest inputs and lets the scorer do the dropping.
//
// What that costs, concretely, for a held position:
//
//   Premium     kept, on time value alone — loss probability needs an IV
//   IV          dropped entirely
//   Time decay  dropped entirely — theta is order-side, and modelling decay
//               without an IV would be inventing the number
//   Liquidity   kept, from the real two-sided market-maker quote
//   Market      kept, from lib/engine.ts
//   Expiry      kept
//
// Four of six components survive, and the weights renormalize from
// 20/15/10/20/25/10 to roughly 27/27/33/13. The alternative considered and
// rejected was deriving an IV from the mark with Black-Scholes: it would fill
// all six slots, but the number would be modelled and would then be feeding a
// signed on-chain trigger. Worse, a sub-score that appears only when a
// matching order happens to be listed would make the total jump for reasons
// unrelated to risk, and each jump can reset the persistence clock.
//
// Pure. Every input is supplied by the caller.

import { computeContractRisk, type ContractRisk } from "../contractRisk";
import type { OptionsAsset } from "../assets";
import type { PositionState } from "./types";

export type PositionRiskInput = {
  position: PositionState;
  spot: number;
  nowSec: number;
  /** Book-level market-structure score from lib/engine.ts, 0-100. */
  marketScore: number | null;
  /** Collateral resting on this contract, USD. Null when not published. */
  contractDepthUsd: number | null;
};

/** The sub-scores that cannot exist for a held position, with the reason.
 *  Surfaced so the UI can state the gap rather than imply six components. */
export const HELD_POSITION_DROPS = [
  { key: "iv", label: "Implied volatility", reason: "this venue publishes implied vol for listed orders only, never for a position you hold" },
  { key: "timeDecay", label: "Time decay", reason: "theta is published for listed orders only, and modelling decay without an implied vol would be inventing it" },
] as const;

/**
 * CALIBRATION NOTE — measured against the live Base book on 2026-09-03.
 *
 * With no implied vol, the premium component keeps only its fragility part:
 * time value as a share of the mark. While a position is out of the money its
 * intrinsic value is zero, so fragility pins at 100 — verified live at exactly
 * 100.0 for a 5%-OTM put on both BTC and ETH. It starts to vary only once the
 * position is in the money and intrinsic value takes over from time value.
 *
 * The arithmetic is right: all-time-value IS maximum fragility for a buyer.
 * But a protective put is usually out of the money, so in practice this
 * component reads as a constant for most of a position's life, and roughly a
 * quarter of the score carries no information while that is true. It is named
 * here, as `DAILY_DECAY_CAP` is in contractRisk.ts, so nobody mistakes the
 * number for a live signal. Recovering its other half — loss probability —
 * needs a per-position implied vol, which this venue does not publish.
 */
export const PREMIUM_PINS_WHILE_OTM = true;

/**
 * Score a held position. Returns null when even the surviving components have
 * no inputs — an unpriceable position is reported as unscored, never as zero
 * risk, because those mean opposite things to someone deciding whether to exit.
 */
export function computePositionRisk(input: PositionRiskInput): ContractRisk | null {
  const { position, spot, nowSec, marketScore, contractDepthUsd } = input;
  if (!(spot > 0) || !(position.contracts > 0)) return null;

  // The exit value is what a held position is worth, so the mark drives the
  // premium component. Entry premium is history; it does not describe risk now.
  const premiumUsd = position.markUsd ?? position.entryPremiumUsd;
  if (premiumUsd === null || !(premiumUsd > 0)) return null;

  const risk = computeContractRisk({
    asset: position.asset as OptionsAsset,
    spot,
    nowSec,
    expiryTs: position.expiryTs,
    legs: [
      {
        isCall: position.isCall,
        // The user bought this position, and holds the long side of it.
        action: "buy",
        strike: position.strike,
        qty: position.contracts,
        premiumUsd,
        // Null by design, not by omission. See the header.
        iv: null,
        thetaUsd: null,
        vegaUsd: null,
        deltaPerContract: null,
      },
    ],
    marketScore,
    // Realized-vol history exists for the asset, but with no IV to rank
    // against it the vol component has nothing to compare, so it is not
    // supplied. Passing it would leave a component half-built.
    baselineVol: null,
    ivPercentile: null,
    liquidity: {
      // The market maker quotes both sides for a held position, so the exit
      // cost here is measured rather than modelled — the one component that
      // is better sourced for a position than for a browse-only order row.
      bidUsd: position.markUsd,
      askUsd: position.askUsd,
      // Black-Scholes fair value needs an IV; without one there is no
      // one-sided fallback reference to offer.
      fairUsd: null,
      contractDepthUsd,
      tradeSizeUsd: premiumUsd * position.contracts,
    },
  });
  if (!risk) return null;

  // Restate WHY these two dropped. contractRisk reports "no realized-vol
  // history available for this asset", which is what a missing baseline means
  // for a listed order — but here the history exists and we withheld the
  // implied vol on purpose, because the venue publishes none for a held
  // position. Leaving the generic reason on screen would blame the wrong
  // thing, and these reasons are the panel's honesty surface.
  return {
    ...risk,
    dropped: risk.dropped.map((entry) => {
      const held = HELD_POSITION_DROPS.find((drop) => drop.key === entry.key);
      return held ? { ...entry, reason: held.reason } : entry;
    }),
  };
}

/** Basis points, for the on-chain attestation. Clamped to the uint16 range the
 *  account validates, and floored so a rounding step can never push a position
 *  over its signed trigger. */
export function positionRiskBps(risk: ContractRisk | null): number {
  if (!risk) return 0;
  return Math.min(10_000, Math.max(0, Math.floor(risk.score * 100)));
}
