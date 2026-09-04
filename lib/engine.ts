// GammaShield risk engine v0.
// All inputs are normalized, plain-JSON order rows derived from the live
// Thetanuts book (see lib/snapshot.ts). All math here is deliberately simple
// and inspectable — this is a market-structure estimate, not a price forecast.

import type { Asset } from "./assets";

export type NormalizedOrder = {
  asset: Asset;
  structure: string; // CALL | PUT | SPREAD | FLY | CONDOR
  isCall: boolean;
  /** Taker side is long when true (maker/MM is selling the option). */
  takerIsLong: boolean;
  strike: number; // USD, first strike for multi-leg
  strikes: number[];
  expiryTs: number; // unix seconds
  collateralUsd: number;
  maker: string;
  greeks: { delta: number; gamma: number; iv: number; theta: number; vega: number; rho: number } | null;
  /** Ask premium per contract, USD. Null for modeled books — no pricing model backs them yet. */
  pricePerContractUsd: number | null;
  /** The maker's actual settlement token for this order — often a wrapped
   *  variant (aBasUSDC/aBasWETH/aBascbBTC), not the plain underlying RFQs
   *  use. Null for modeled (non-live) books. */
  collateralToken: { address: string; symbol: string; decimals: number } | null;
};

export type StrikeGex = { strike: number; gex: number; notionalUsd: number };

export type ExpiryBucket = {
  ts: number;
  label: string;
  notionalUsd: number;
  orders: number;
  daysOut: number;
};

export type HeatCell = { strike: number; expiryTs: number; notionalUsd: number };

export type Factors = {
  gamma: number;
  concentration: number;
  expiry: number;
  liquidity: number;
  iv: number;
};

export type AssetSnapshot = {
  asset: Asset;
  spot: number;
  score: number;
  regime: "dampening" | "amplifying" | "neutral";
  factors: Factors;
  netGexUsd: number;
  flipStrike: number | null;
  gexByStrike: StrikeGex[];
  expiries: ExpiryBucket[];
  heatmap: HeatCell[];
  depthUsd: number;
  avgIv: number | null;
  orderCount: number;
  greeksCoverage: number;
};

const clamp = (v: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));

// GEX per order in "USD of dealer delta-hedge flow per 1% spot move".
// Dealer = market maker on the book. When the taker is long, the maker is
// short the option and therefore short gamma (hedging chases price).
function orderGex(o: NormalizedOrder, spot: number): number {
  if (!o.greeks) return 0;
  const contracts = o.collateralUsd / Math.max(o.strike, 1);
  const dealerSign = o.takerIsLong ? -1 : 1;
  return dealerSign * o.greeks.gamma * contracts * spot * spot * 0.01;
}

// Flip level: strike where the cumulative GEX profile crosses zero. Exported
// so a what-if fill (lib/marketImpact.ts) can re-run the exact same walk over
// a modified ladder instead of reimplementing it and drifting.
export function flipStrikeOf(gexByStrike: { strike: number; gex: number }[]): number | null {
  let running = 0;
  let prevRunning = 0;
  for (const row of [...gexByStrike].sort((a, b) => a.strike - b.strike)) {
    prevRunning = running;
    running += row.gex;
    if (prevRunning !== 0 && Math.sign(prevRunning) !== Math.sign(running) && running !== 0) {
      return row.strike;
    }
  }
  return null;
}

export function computeAssetSnapshot(
  asset: Asset,
  spot: number,
  orders: NormalizedOrder[],
  now = Math.floor(Date.now() / 1000),
): AssetSnapshot {
  const live = orders.filter((o) => o.asset === asset && o.expiryTs > now);
  const withGreeks = live.filter((o) => o.greeks);

  // --- GEX by strike ---
  const byStrike = new Map<number, StrikeGex>();
  for (const o of live) {
    const row = byStrike.get(o.strike) ?? { strike: o.strike, gex: 0, notionalUsd: 0 };
    row.gex += orderGex(o, spot);
    row.notionalUsd += o.collateralUsd;
    byStrike.set(o.strike, row);
  }
  const gexByStrike = [...byStrike.values()].sort((a, b) => a.strike - b.strike);
  const netGexUsd = gexByStrike.reduce((s, r) => s + r.gex, 0);
  const flipStrike = flipStrikeOf(gexByStrike);

  // --- Expiry buckets ---
  const byExpiry = new Map<number, ExpiryBucket>();
  for (const o of live) {
    const b =
      byExpiry.get(o.expiryTs) ??
      ({
        ts: o.expiryTs,
        label: new Date(o.expiryTs * 1000).toISOString().slice(0, 10),
        notionalUsd: 0,
        orders: 0,
        daysOut: (o.expiryTs - now) / 86400,
      } satisfies ExpiryBucket);
    b.notionalUsd += o.collateralUsd;
    b.orders += 1;
    byExpiry.set(o.expiryTs, b);
  }
  const expiries = [...byExpiry.values()].sort((a, b) => a.ts - b.ts);

  const heatmap: HeatCell[] = live.map((o) => ({
    strike: o.strike,
    expiryTs: o.expiryTs,
    notionalUsd: o.collateralUsd,
  }));

  const depthUsd = live.reduce((s, o) => s + o.collateralUsd, 0);
  const ivs = withGreeks.map((o) => o.greeks!.iv).filter((v) => v > 0);
  const avgIv = ivs.length ? ivs.reduce((s, v) => s + v, 0) / ivs.length : null;

  // --- Factors, each 0–100 ---

  // Net short dealer gamma amplifies moves; magnitude scaled vs book depth.
  const gexMagnitude = Math.abs(netGexUsd) / Math.max(depthUsd, 1);
  const gammaFactor =
    netGexUsd < 0
      ? clamp(55 + 45 * Math.tanh(gexMagnitude * 6))
      : clamp(45 - 35 * Math.tanh(gexMagnitude * 6));

  // Share of open interest held by the three most crowded strikes.
  const top3 = [...gexByStrike]
    .sort((a, b) => b.notionalUsd - a.notionalUsd)
    .slice(0, 3)
    .reduce((s, r) => s + r.notionalUsd, 0);
  const concentrationFactor = depthUsd > 0 ? clamp((top3 / depthUsd) * 100) : 0;

  // Near-dated open interest exerts pin/unclench pressure; weight decays over a week.
  const expiryWeight =
    depthUsd > 0
      ? expiries.reduce(
          (s, b) => s + (b.notionalUsd / depthUsd) * Math.exp(-b.daysOut / 7),
          0,
        )
      : 0;
  const expiryFactor = clamp(expiryWeight * 120);

  // Thin books move further per dollar traded. Calibrated to current book scale.
  const liquidityFactor = clamp(100 * (1 - Math.tanh(depthUsd / 2_000_000)));

  // Elevated implied vol regimes correlate with fragile hedging.
  const ivFactor = avgIv === null ? 50 : clamp(((avgIv - 0.35) / 0.65) * 100);

  const factors: Factors = {
    gamma: Math.round(gammaFactor),
    concentration: Math.round(concentrationFactor),
    expiry: Math.round(expiryFactor),
    liquidity: Math.round(liquidityFactor),
    iv: Math.round(ivFactor),
  };

  const score = Math.round(
    factors.gamma * 0.3 +
      factors.concentration * 0.2 +
      factors.expiry * 0.15 +
      factors.liquidity * 0.2 +
      factors.iv * 0.15,
  );

  const regime = netGexUsd < 0 ? "amplifying" : netGexUsd > 0 ? "dampening" : "neutral";

  return {
    asset,
    spot,
    score,
    regime,
    factors,
    netGexUsd,
    flipStrike,
    gexByStrike,
    expiries,
    heatmap,
    depthUsd,
    avgIv,
    orderCount: live.length,
    greeksCoverage: live.length ? withGreeks.length / live.length : 0,
  };
}
