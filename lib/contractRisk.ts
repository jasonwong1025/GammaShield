// GammaShield contract risk v1 — per-contract risk for ONE option or ONE
// multi-leg structure. This is a different question from lib/engine.ts, which
// scores the whole book's market structure; that book-level score enters here
// as the "Market" component and nothing more.
//
//   Overall = Premium 20% + IV 15% + TimeDecay 10%
//           + Liquidity 20% + Market 25% + Expiry 10%
//
// Two rules run through every component:
//
//  1. Nothing is invented. A sub-score whose input the live book doesn't carry
//     is DROPPED and the remaining weights renormalize — never defaulted to a
//     midpoint, never quietly modelled as if measured. Each surviving part
//     reports where its number came from, and everything dropped is listed
//     with a reason so the UI can say so out loud.
//  2. Short exposure inverts the components that are directional. Rich vol and
//     fast decay are hazards for a buyer and income for a seller. Exit cost,
//     dealer-gamma structure and expiry proximity are hazards for both, so
//     those never flip. Loss probability needs no flip — it is computed from
//     the signed payoff and is already direction-aware.
//
// No I/O in this file. Historical vol arrives pre-fetched from
// lib/realizedVol.ts; the book quote arrives from lib/snapshot.ts.

import type { Asset } from "./assets";
import { bsOptionPrice, normCdf } from "./modelBook";

// --- Shapes ---

export type RiskAction = "buy" | "sell";
export type RiskLevel = "low" | "medium" | "high" | "extreme";
export type RiskDirection = "long" | "short";

export type RiskLeg = {
  isCall: boolean;
  action: RiskAction;
  strike: number;
  /** Contracts, denominated in units of the underlying. */
  qty: number;
  /** Premium per contract, USD. */
  premiumUsd: number;
  iv: number | null;
  /** Per contract, per day, USD. Verified against the live book, not assumed. */
  thetaUsd: number | null;
  /** Per contract, per 1 vol point, USD. Verified against the live book. */
  vegaUsd: number | null;
  deltaPerContract: number | null;
};

export type LiquidityQuote = {
  /** Best live bid on this exact contract, USD per contract. */
  bidUsd: number | null;
  /** Best live ask on this exact contract, USD per contract. */
  askUsd: number | null;
  /** Black-Scholes value at the quoted IV — the one-sided fallback reference. */
  fairUsd: number | null;
  /** Collateral resting on this contract, USD. */
  contractDepthUsd: number | null;
  /** Size the user actually wants to do, USD. Null on a browse-only view. */
  tradeSizeUsd: number | null;
};

export type ContractRiskInput = {
  asset: Asset;
  spot: number;
  nowSec: number;
  expiryTs: number;
  legs: RiskLeg[];
  /** Book-level market-structure score from lib/engine.ts, 0–100. */
  marketScore: number | null;
  /** Trailing 30d realized vol, annualized (lib/realizedVol.ts). */
  baselineVol: number | null;
  /** Where this IV sits in the 1y realized-vol distribution, 0–1. */
  ivPercentile: number | null;
  liquidity: LiquidityQuote;
};

export type RiskPart = {
  key: string;
  label: string;
  score: number;
  /** Weight actually applied after renormalizing over available parts. */
  weight: number;
  /** Where the number came from, for the UI to show verbatim. */
  detail: string;
};

export type RiskDrop = { key: string; label: string; reason: string };

export type RiskComponent = {
  key: string;
  label: string;
  score: number;
  level: RiskLevel;
  weight: number;
  parts: RiskPart[];
  dropped: RiskDrop[];
  /** True when short exposure inverted this component. */
  mirrored: boolean;
};

export type ContractRisk = {
  score: number;
  level: RiskLevel;
  direction: RiskDirection;
  components: RiskComponent[];
  dropped: RiskDrop[];
  daysToExpiry: number;
  expiryMultiplier: number;
  /** Probability this position finishes below break-even, 0–1. */
  lossProbability: number | null;
  net: {
    premiumUsd: number;
    intrinsicUsd: number;
    extrinsicUsd: number;
    thetaUsd: number;
    vegaUsd: number;
    iv: number | null;
  };
};

// --- Primitives ---

const clamp = (v: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));

/** Near-dated contracts carry their IV and decay risk hotter. */
export function expiryMultiplier(days: number): number {
  if (days <= 3) return 1.5;
  if (days <= 7) return 1.3;
  if (days <= 14) return 1.15;
  if (days <= 30) return 1.0;
  return 0.9;
}

/**
 * Daily decay that reads as maximum risk: losing 5% of premium per day.
 *
 * CALIBRATION NOTE — measured against the live Base book on 2026-09-03, this
 * cap saturates. |theta|/premium came in at p10 0.15, p50 0.54 per day, and
 * all 146 scored contracts sat at or above 0.05, so the sub-score is a
 * constant 100 for every long. That is not a defect in the arithmetic: the
 * book's median contract expires in ~2 days, where losing half the premium in
 * a day is simply true. The cap is named here so recalibrating it to this
 * venue's tenor mix is a one-line change.
 */
export const DAILY_DECAY_CAP = 0.05;

export function levelOf(score: number): RiskLevel {
  if (score >= 85) return "extreme";
  if (score >= 67) return "high";
  if (score >= 34) return "medium";
  return "low";
}

type Candidate = {
  key: string;
  label: string;
  weight: number;
  score: number | null;
  detail: string;
  /** Why this part is missing. Required whenever score is null. */
  reason?: string;
};

/**
 * Weighted blend over whatever is actually available, renormalizing the
 * surviving weights back to 1. A null score means nothing survived — the
 * caller drops the whole component and reports why, rather than inventing a
 * number. The drop list is returned either way so the reason survives.
 */
function blend(candidates: Candidate[]): { score: number | null; parts: RiskPart[]; dropped: RiskDrop[] } {
  const live = candidates.filter((c) => c.score !== null && Number.isFinite(c.score));
  const dropped = candidates
    .filter((c) => c.score === null || !Number.isFinite(c.score))
    .map((c) => ({ key: c.key, label: c.label, reason: c.reason ?? "not available on this book" }));
  const total = live.reduce((s, c) => s + c.weight, 0);
  if (!live.length || total <= 0) return { score: null, parts: [], dropped };

  const parts = live.map((c) => ({
    key: c.key,
    label: c.label,
    score: clamp(c.score!),
    weight: c.weight / total,
    detail: c.detail,
  }));
  const score = parts.reduce((s, p) => s + p.score * p.weight, 0);
  return { score, parts, dropped };
}

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

// --- Payoff and loss probability ---

function legSign(leg: RiskLeg): number {
  return leg.action === "buy" ? 1 : -1;
}

function intrinsicOf(leg: RiskLeg, price: number): number {
  return Math.max(leg.isCall ? price - leg.strike : leg.strike - price, 0);
}

/** Structure payoff at expiry, signed by leg direction and scaled by size. */
export function payoffAtExpiry(legs: RiskLeg[], price: number): number {
  return legs.reduce((s, leg) => s + legSign(leg) * leg.qty * intrinsicOf(leg, price), 0);
}

/**
 * Probability the position finishes below break-even, under a risk-neutral
 * lognormal with ZERO drift — consistent with lib/modelBook.ts, which also
 * omits the rate term. Single legs use the closed form; structures integrate
 * the same distribution numerically because a spread has no single break-even.
 */
function lossProbability(
  legs: RiskLeg[],
  spot: number,
  iv: number,
  years: number,
  netPremiumUsd: number,
): number | null {
  if (!(iv > 0) || !(years > 0) || !(spot > 0)) return null;

  if (legs.length === 1) {
    const leg = legs[0];
    const breakEven = leg.isCall ? leg.strike + leg.premiumUsd : leg.strike - leg.premiumUsd;
    if (!(breakEven > 0)) return leg.action === "buy" ? (leg.isCall ? 0 : 1) : leg.isCall ? 1 : 0;
    const d2 = (Math.log(spot / breakEven) - 0.5 * iv * iv * years) / (iv * Math.sqrt(years));
    const longLoses = leg.isCall ? normCdf(-d2) : normCdf(d2);
    return leg.action === "buy" ? longLoses : 1 - longLoses;
  }

  // Trapezoid over the terminal log-price density, ±8 sigma.
  const sd = iv * Math.sqrt(years);
  const mu = Math.log(spot) - 0.5 * sd * sd;
  const steps = 2000;
  const lo = mu - 8 * sd;
  const hi = mu + 8 * sd;
  const dx = (hi - lo) / steps;
  let mass = 0;
  let losing = 0;
  for (let i = 0; i <= steps; i++) {
    const x = lo + i * dx;
    const density = Math.exp(-0.5 * ((x - mu) / sd) ** 2);
    const w = i === 0 || i === steps ? 0.5 : 1;
    mass += density * w;
    if (payoffAtExpiry(legs, Math.exp(x)) < netPremiumUsd) losing += density * w;
  }
  return mass > 0 ? losing / mass : null;
}

// --- The model ---

export function computeContractRisk(input: ContractRiskInput): ContractRisk | null {
  const { legs, spot, nowSec, expiryTs } = input;
  if (!legs.length || !(spot > 0)) return null;

  const secondsOut = expiryTs - nowSec;
  const daysToExpiry = secondsOut / 86400;
  const years = secondsOut / (365 * 86400);
  const multiplier = expiryMultiplier(daysToExpiry);

  // --- Net structure ---
  const netPremiumUsd = legs.reduce((s, l) => s + legSign(l) * l.qty * l.premiumUsd, 0);
  const netIntrinsicUsd = legs.reduce((s, l) => s + legSign(l) * l.qty * intrinsicOf(l, spot), 0);
  const netExtrinsicUsd = netPremiumUsd - netIntrinsicUsd;
  const netThetaUsd = legs.reduce((s, l) => s + legSign(l) * l.qty * (l.thetaUsd ?? 0), 0);
  const netVegaUsd = legs.reduce((s, l) => s + legSign(l) * l.qty * (l.vegaUsd ?? 0), 0);
  const hasTheta = legs.every((l) => l.thetaUsd !== null);
  const hasVega = legs.every((l) => l.vegaUsd !== null);

  const ivLegs = legs.filter((l) => l.iv !== null && l.iv > 0);
  const ivWeight = ivLegs.reduce((s, l) => s + Math.abs(l.qty), 0);
  const netIv = ivWeight > 0
    ? ivLegs.reduce((s, l) => s + l.iv! * Math.abs(l.qty), 0) / ivWeight
    : null;

  // A net debit is a long structure; a net credit is a short one.
  const direction: RiskDirection = netPremiumUsd >= 0 ? "long" : "short";
  const isShort = direction === "short";
  const grossPremium = Math.abs(netPremiumUsd);
  const mirror = (v: number) => (isShort ? 100 - v : v);

  const pLoss = netIv !== null ? lossProbability(legs, spot, netIv, years, netPremiumUsd) : null;

  const components: RiskComponent[] = [];
  const droppedComponents: RiskDrop[] = [];

  const push = (
    key: string,
    label: string,
    weight: number,
    result: ReturnType<typeof blend>,
    opts: { multiplier?: number; mirrored?: boolean; reason?: string } = {},
  ) => {
    if (result.score === null) {
      // Name what was actually missing — "no inputs available" tells a reader
      // nothing they can act on.
      const why = [...new Set(result.dropped.map((d) => d.reason))].join("; ");
      droppedComponents.push({ key, label, reason: opts.reason ?? why ?? "no inputs available" });
      return;
    }
    const scaled = clamp(result.score * (opts.multiplier ?? 1));
    const score = opts.mirrored ? clamp(100 - scaled) : scaled;
    components.push({
      key,
      label,
      score,
      level: levelOf(score),
      weight,
      parts: result.parts,
      dropped: result.dropped,
      mirrored: Boolean(opts.mirrored),
    });
  };

  // --- Premium: will this position recover what it cost? ---
  // Loss probability is already direction-aware (signed payoff), so only
  // fragility flips: all-time-value is the buyer's hazard and the seller's
  // whole business model.
  const fragility = grossPremium > 0 ? clamp((netExtrinsicUsd / netPremiumUsd) * 100) : null;
  push(
    "premium",
    "Premium",
    0.2,
    blend([
      {
        key: "lossProb",
        label: "Loss probability",
        weight: 0.7,
        score: pLoss === null ? null : pLoss * 100,
        detail:
          pLoss === null
            ? ""
            : `${pct(pLoss)} chance of finishing past break-even against you, at ${netIv !== null ? pct(netIv) : "—"} IV`,
        reason: "the book carries no IV for this contract",
      },
      {
        key: "fragility",
        label: "Fragility",
        weight: 0.3,
        score: fragility === null ? null : mirror(fragility),
        detail:
          fragility === null
            ? ""
            : `${pct(netExtrinsicUsd / netPremiumUsd)} of the premium is time value${isShort ? " — collected, not paid" : ""}`,
        reason: "no premium quoted",
      },
    ]),
  );

  // --- IV: is the vol you are paying for rich, and how hard does it bite? ---
  const relativeIv =
    netIv !== null && input.baselineVol !== null && input.baselineVol > 0
      ? clamp(50 + 100 * (netIv / input.baselineVol - 1))
      : null;
  const vegaShockUsd = Math.abs(netVegaUsd) * 5;
  push(
    "iv",
    "Implied volatility",
    0.15,
    blend([
      {
        key: "relativeIv",
        label: "Relative IV",
        weight: 0.45,
        score: relativeIv === null ? null : mirror(relativeIv),
        detail:
          relativeIv === null || netIv === null
            ? ""
            : `${pct(netIv)} IV vs ${pct(input.baselineVol!)} trailing 30d realized`,
        reason: "no realized-vol history available for this asset",
      },
      {
        key: "ivPercentile",
        label: "Vol percentile",
        weight: 0.25,
        score: input.ivPercentile === null ? null : mirror(input.ivPercentile * 100),
        detail:
          input.ivPercentile === null
            ? ""
            : `richer than ${pct(input.ivPercentile)} of the past year's 30d realized vol`,
        reason: "no realized-vol history available for this asset",
      },
      {
        key: "vegaRisk",
        label: "Vega exposure",
        weight: 0.3,
        // Not mirrored: a 5-point vol move hurts whichever side is wrong.
        score: hasVega && grossPremium > 0 ? clamp((vegaShockUsd / grossPremium) * 100) : null,
        detail: hasVega && grossPremium > 0
          ? `a 5-point IV move swings ${pct(vegaShockUsd / grossPremium)} of the premium`
          : "",
        reason: "the book carries no vega for this contract",
      },
    ]),
    { multiplier, mirrored: false },
  );

  // --- Time decay: how fast does the clock eat this position? ---
  // Projected decay walks the actual Black-Scholes curve over the next week
  // rather than straight-lining theta, which overstates near-dated decay.
  const horizonDays = Math.min(7, Math.max(daysToExpiry, 0));
  const valueNow = netIv !== null
    ? legs.reduce((s, l) => s + legSign(l) * l.qty * bsOptionPrice(spot, l.strike, l.iv ?? netIv, years, l.isCall), 0)
    : null;
  const valueLater = netIv !== null
    ? legs.reduce(
        (s, l) =>
          s +
          legSign(l) * l.qty * bsOptionPrice(spot, l.strike, l.iv ?? netIv, Math.max(years - horizonDays / 365, 0), l.isCall),
        0,
      )
    : null;
  const projectedDecay =
    valueNow !== null && valueLater !== null && Math.abs(valueNow) > 1e-9
      ? clamp(((Math.abs(valueNow) - Math.abs(valueLater)) / Math.abs(valueNow)) * 100)
      : null;
  push(
    "timeDecay",
    "Time decay",
    0.1,
    blend([
      {
        key: "dailyDecay",
        label: "Daily decay",
        weight: 0.6,
        score:
          hasTheta && grossPremium > 0
            ? clamp(((Math.abs(netThetaUsd) / grossPremium) / DAILY_DECAY_CAP) * 100)
            : null,
        detail: hasTheta && grossPremium > 0
          ? `${pct(Math.abs(netThetaUsd) / grossPremium)} of the premium per day`
          : "",
        reason: "the book carries no theta for this contract",
      },
      {
        key: "projectedDecay",
        label: `Decay over ${horizonDays < 7 ? "remaining life" : "7 days"}`,
        weight: 0.4,
        score: projectedDecay,
        detail:
          projectedDecay === null
            ? ""
            : `${projectedDecay.toFixed(0)}% of today's value gone by then if spot holds`,
        reason: "cannot model decay without an IV",
      },
    ]),
    { multiplier, mirrored: isShort },
  );

  // --- Liquidity: what does getting back out actually cost? ---
  // Open interest and per-contract traded volume do not exist on this venue,
  // and every contract on the book is quoted by exactly one maker, so the
  // participation/OI/activity trio from the spec cannot be sourced. What
  // survives is measured, and the drops are reported rather than papered over.
  const { bidUsd, askUsd, fairUsd, contractDepthUsd, tradeSizeUsd } = input.liquidity;
  const twoSided = bidUsd !== null && askUsd !== null && bidUsd > 0 && askUsd > 0;
  const mid = twoSided ? (bidUsd! + askUsd!) / 2 : null;
  const quotedSpread = twoSided && mid! > 0 ? (askUsd! - bidUsd!) / mid! : null;
  const reference = isShort ? bidUsd : askUsd;
  // One side only: distance from model fair value, doubled to stand in for a
  // round trip. Labelled "modelled" wherever it is shown.
  const modelledSpread =
    quotedSpread === null && reference !== null && fairUsd !== null && fairUsd > 0
      ? Math.abs(2 * (reference - fairUsd)) / fairUsd
      : null;
  const spreadPct = quotedSpread ?? modelledSpread;
  push(
    "liquidity",
    "Liquidity",
    0.2,
    blend([
      {
        key: "spread",
        label: "Spread",
        weight: 0.45,
        score: spreadPct === null ? null : clamp(spreadPct * 100),
        detail:
          spreadPct === null
            ? ""
            : quotedSpread !== null
              ? `${pct(quotedSpread)} quoted bid-ask on this contract`
              : `${pct(modelledSpread!)} round trip vs model fair value — modelled, one side quoted`,
        reason: "no quote on this contract",
      },
      {
        key: "depth",
        label: "Resting depth",
        weight: 0.3,
        score:
          contractDepthUsd !== null && contractDepthUsd >= 0
            ? clamp(100 * (1 - Math.tanh(contractDepthUsd / 25_000)))
            : null,
        detail:
          contractDepthUsd === null
            ? ""
            : `$${Math.round(contractDepthUsd).toLocaleString("en-US")} resting on this contract`,
        reason: "no resting size found",
      },
      {
        key: "participation",
        label: "Your share of the book",
        weight: 0.25,
        score:
          tradeSizeUsd !== null && contractDepthUsd !== null && contractDepthUsd > 0
            ? clamp((tradeSizeUsd / contractDepthUsd) * 100)
            : null,
        detail:
          tradeSizeUsd !== null && contractDepthUsd
            ? `your size is ${pct(tradeSizeUsd / contractDepthUsd)} of what is resting`
            : "",
        reason:
          tradeSizeUsd === null
            ? "no trade size given — browse view"
            // Same wording as the depth drop above so the component-level
            // summary collapses them into one reason instead of two.
            : "no resting size found",
      },
    ]),
  );

  // --- Market: the book-level dealer-gamma read (lib/engine.ts) ---
  push(
    "market",
    "Market structure",
    0.25,
    blend([
      {
        key: "bookScore",
        label: "Dealer gamma regime",
        weight: 1,
        score: input.marketScore,
        detail: input.marketScore === null ? "" : `live ${input.asset} book amplification score`,
        reason: "book snapshot unavailable",
      },
    ]),
  );

  // --- Expiry: how little runway is left, and is spot pinned to the strike? ---
  const nearestStrike = legs.reduce((best, l) =>
    Math.abs(Math.log(spot / l.strike)) < Math.abs(Math.log(spot / best.strike)) ? l : best,
  ).strike;
  const z =
    netIv !== null && years > 0 ? Math.abs(Math.log(spot / nearestStrike)) / (netIv * Math.sqrt(years)) : null;
  push(
    "expiry",
    "Expiry",
    0.1,
    blend([
      {
        key: "runway",
        label: "Time remaining",
        weight: 0.6,
        score: daysToExpiry >= 0 ? 100 * Math.exp(-daysToExpiry / 14) : null,
        detail: `${daysToExpiry.toFixed(1)} days to expiry`,
        reason: "already expired",
      },
      {
        key: "pin",
        label: "Strike proximity",
        weight: 0.4,
        score: z === null ? null : 100 * Math.exp(-0.5 * z * z),
        detail: z === null ? "" : `spot sits ${z.toFixed(2)}σ from the ${nearestStrike} strike`,
        reason: "no IV to scale distance by",
      },
    ]),
  );

  const totalWeight = components.reduce((s, c) => s + c.weight, 0);
  if (!components.length || totalWeight <= 0) return null;
  const score = clamp(components.reduce((s, c) => s + c.score * (c.weight / totalWeight), 0));

  return {
    score,
    level: levelOf(score),
    direction,
    components,
    dropped: droppedComponents,
    daysToExpiry,
    expiryMultiplier: multiplier,
    lossProbability: pLoss,
    net: {
      premiumUsd: netPremiumUsd,
      intrinsicUsd: netIntrinsicUsd,
      extrinsicUsd: netExtrinsicUsd,
      thetaUsd: netThetaUsd,
      vegaUsd: netVegaUsd,
      iv: netIv,
    },
  };
}
