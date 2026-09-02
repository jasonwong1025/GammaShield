// Market impact of an options fill — what buying N contracts does to SPOT,
// through the dealer who has to hedge it.
//
// Two distinct flows, deliberately reported separately:
//
//   immediate hedge  — a one-off spot order. Sell someone a call and you are
//                      short delta; you buy delta x contracts x spot of spot
//                      right now. Happens once, at the fill.
//   gamma feedback   — an ongoing obligation. The position adds dealer gamma,
//                      so every subsequent 1% move forces another trade. This
//                      is the amplification GammaShield exists to measure.
//
// Sign convention matches lib/engine.ts exactly: a taker BUYING pushes the
// dealer short gamma (negative GEX, hedging chases price, moves amplify); a
// taker SELLING pushes the dealer long gamma (positive GEX, hedging leans
// against price, moves dampen).
//
// Everything here is pure. Spot volume comes from lib/spotVolume.ts, daily
// volatility from lib/realizedVol.ts, the book state from lib/engine.ts. When
// an input is missing the dependent output is null with a stated reason —
// nothing is defaulted into existence.
//
// SCALE WARNING, measured 2026-09-03: the entire live Thetanuts book carries
// about $33k (BTC) / $30k (ETH) of dealer gamma per 1% move, against roughly
// $1.6B / $0.7B of daily Coinbase+Binance spot volume. Real fills on this
// venue therefore have no measurable effect on spot price. That is why the
// headline figure is the THRESHOLD — the size it would take to matter — and
// the price-move estimate is floored rather than printed to fake precision.

import { flipStrikeOf, type StrikeGex } from "./engine";

/** Impact-law coefficient in move% = k x dailyVol% x sqrt(flow / volume). */
export const IMPACT_COEFFICIENT = 1.0;
/** The yardstick a flow is called "material" against: 1% of daily volume. */
export const THRESHOLD_SHARE = 0.01;
/** Below this the price-move estimate is reported as negligible, not a number. */
export const MOVE_FLOOR_PCT = 0.01;
/** Crypto trades every day — same convention as lib/realizedVol.ts. */
const DAYS_PER_YEAR = 365;

export type ImpactFlow = {
  /** Signed USD. Positive = dealers buy spot, negative = dealers sell. */
  usd: number;
  /** |usd| as a share of measured daily volume. Null without a volume read. */
  shareOfAdv: number | null;
  /** Contracts needed for this flow to reach THRESHOLD_SHARE of daily volume. */
  contractsForThreshold: number | null;
};

export type ImpactMove = {
  /** Move from the dealer's immediate hedge order, percent. */
  initialPct: number;
  /** Spot the dealers must trade in response to that move, signed USD. */
  hedgeFlowUsd: number;
  /** Move from that second-round flow, percent. */
  feedbackPct: number;
  totalPct: number;
  /** totalPct / initialPct. >1 amplifying, <1 dampening. */
  amplification: number;
};

export type MarketImpact = {
  contracts: number;
  /** Contract notional at spot — the exposure, not the premium paid. */
  notionalUsd: number;
  /** One-off spot order the dealer places at the fill. */
  hedge: ImpactFlow;
  /** Extra spot the dealer must trade per 1% move, from this position's gamma. */
  gamma: ImpactFlow;
  /** Whose gamma sign this trade hands the dealer. */
  gammaSign: "positive" | "negative";
  netGexBefore: number;
  netGexAfter: number;
  regimeBefore: Regime;
  regimeAfter: Regime;
  flipBefore: number | null;
  flipAfter: number | null;
  /** Null when volume or volatility is unavailable — see `unavailable`. */
  move: ImpactMove | null;
  advUsd: number | null;
  advSources: string[];
  dailyVolPct: number | null;
  volSource: string | null;
  coefficient: number;
  /** Plain-language reasons for anything that came back null. */
  unavailable: string[];
};

export type Regime = "dampening" | "amplifying" | "neutral";

/**
 * Everything the impact math needs about one contract, so the browser can
 * re-run it at any what-if size without a round trip. Per-contract greeks
 * make the two flows linear in size; only the price move is not.
 */
export type ImpactBasis = {
  spot: number;
  strike: number;
  gammaPerContract: number;
  deltaPerContract: number;
  /** True when the taker is the buyer — the dealer goes short gamma. */
  takerIsLong: boolean;
  netGexUsd: number;
  gexByStrike: StrikeGex[];
  advUsd: number | null;
  advSources: string[];
  /** Annualized realized vol, e.g. 0.43. Converted to a daily move here. */
  baselineVol: number | null;
  volSource: string | null;
  coefficient?: number;
};

export const regimeOf = (netGex: number): Regime =>
  netGex < 0 ? "amplifying" : netGex > 0 ? "dampening" : "neutral";

/** Annualized vol to a one-day move, in percent. */
export const dailyVolPctOf = (annualVol: number) => (annualVol / Math.sqrt(DAYS_PER_YEAR)) * 100;

/**
 * Square-root market impact: a flow of `usd` moves price by
 * k x dailyVol% x sqrt(usd / dailyVolume), keeping the flow's sign.
 */
export function priceMovePct(
  flowUsd: number,
  advUsd: number,
  dailyVolPct: number,
  k = IMPACT_COEFFICIENT,
): number {
  if (!(advUsd > 0) || !Number.isFinite(flowUsd)) return 0;
  return Math.sign(flowUsd) * k * dailyVolPct * Math.sqrt(Math.abs(flowUsd) / advUsd);
}

/**
 * One round of dealer feedback: an order moves spot, dealers rehedge against
 * that move, and the rehedge moves spot again. Stops there — a fixed-point
 * iteration would claim more precision about the cascade than a single
 * impact coefficient can support.
 *
 * `netGexUsd` is USD of dealer hedge flow per 1% move (lib/engine.ts). Short
 * dealer gamma (negative) means they trade WITH the move, so the second round
 * adds to the first.
 *
 * Read `amplification` with the size in mind. Because the impact law is
 * concave, a smaller order gets a proportionally LARGER second round against a
 * fixed book: measured 2026-09-03 on the live BTC book, $1k reads x1.24 and
 * $1B reads x1.01. That is a property of the square-root law, not of the
 * market, so the ratio only compares like-for-like at equal size. Callers
 * suppress it entirely when the move itself is below MOVE_FLOOR_PCT.
 */
export function oneRoundImpact({
  orderUsd,
  netGexUsd,
  advUsd,
  dailyVolPct,
  coefficient = IMPACT_COEFFICIENT,
}: {
  orderUsd: number;
  netGexUsd: number;
  advUsd: number;
  dailyVolPct: number;
  coefficient?: number;
}): ImpactMove {
  const initialPct = priceMovePct(orderUsd, advUsd, dailyVolPct, coefficient);
  const hedgeFlowUsd = -netGexUsd * initialPct;
  const feedbackPct = priceMovePct(hedgeFlowUsd, advUsd, dailyVolPct, coefficient);
  const totalPct = initialPct + feedbackPct;
  return {
    initialPct,
    hedgeFlowUsd,
    feedbackPct,
    totalPct,
    amplification: initialPct === 0 ? 1 : totalPct / initialPct,
  };
}

/** Contracts at which a per-contract flow reaches 1% of daily volume. */
function thresholdContracts(perContractUsd: number, advUsd: number | null): number | null {
  if (advUsd === null || !(advUsd > 0)) return null;
  const per = Math.abs(perContractUsd);
  if (!(per > 0)) return null;
  return (THRESHOLD_SHARE * advUsd) / per;
}

export function computeMarketImpact(basis: ImpactBasis, contracts: number): MarketImpact {
  const k = basis.coefficient ?? IMPACT_COEFFICIENT;
  const { spot, advUsd } = basis;
  const size = Math.max(0, contracts);
  const dealerSign = basis.takerIsLong ? -1 : 1;

  // Immediate delta hedge. Sell a call (positive delta) and the dealer buys
  // spot; sell a put (negative delta) and the dealer sells it. Signed so
  // positive always reads "dealers buy".
  const hedgePerContract = -dealerSign * basis.deltaPerContract * spot;
  // Gamma added to the dealer, in USD of hedge flow per 1% move — the exact
  // convention lib/engine.ts uses for the book's own net GEX.
  const gexPerContract = dealerSign * basis.gammaPerContract * spot * spot * 0.01;

  const hedgeUsd = hedgePerContract * size;
  const addedGex = gexPerContract * size;
  const netGexAfter = basis.netGexUsd + addedGex;

  const ladder = basis.gexByStrike.map((r) => ({ ...r }));
  const at = ladder.find((r) => r.strike === basis.strike);
  if (at) at.gex += addedGex;
  else ladder.push({ strike: basis.strike, gex: addedGex, notionalUsd: 0 });

  const unavailable: string[] = [];
  if (advUsd === null) unavailable.push("no spot volume — Coinbase and Binance both unreachable");
  if (basis.baselineVol === null) unavailable.push("no realized-vol history for the daily move");

  const dailyVolPct = basis.baselineVol === null ? null : dailyVolPctOf(basis.baselineVol);
  const move =
    advUsd !== null && dailyVolPct !== null && size > 0
      ? oneRoundImpact({
          orderUsd: hedgeUsd,
          // The fill is on the book now, so its own gamma is part of what
          // rehedges against the move it caused.
          netGexUsd: netGexAfter,
          advUsd,
          dailyVolPct,
          coefficient: k,
        })
      : null;

  const share = (usd: number) => (advUsd === null || !(advUsd > 0) ? null : Math.abs(usd) / advUsd);

  return {
    contracts: size,
    notionalUsd: size * spot,
    hedge: {
      usd: hedgeUsd,
      shareOfAdv: share(hedgeUsd),
      contractsForThreshold: thresholdContracts(hedgePerContract, advUsd),
    },
    gamma: {
      usd: addedGex,
      shareOfAdv: share(addedGex),
      contractsForThreshold: thresholdContracts(gexPerContract, advUsd),
    },
    gammaSign: gexPerContract < 0 ? "negative" : "positive",
    netGexBefore: basis.netGexUsd,
    netGexAfter,
    regimeBefore: regimeOf(basis.netGexUsd),
    regimeAfter: regimeOf(netGexAfter),
    flipBefore: flipStrikeOf(basis.gexByStrike),
    flipAfter: flipStrikeOf(ladder),
    move,
    advUsd,
    advSources: basis.advSources,
    dailyVolPct,
    volSource: basis.volSource,
    coefficient: k,
    unavailable,
  };
}
