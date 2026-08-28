// Modeled options book for assets without a live Thetanuts market yet.
// Structure (strikes, tenors, sizes, sides) is generated deterministically per
// asset, and greeks come from Black-Scholes against the LIVE spot price — so
// the risk engine and GEX profile behave exactly as they do for the real
// BTC/ETH books. Clearly labeled as modeled in the UI.

import type { Asset } from "./assets";
import type { NormalizedOrder } from "./engine";

type ModelParams = {
  baseIv: number; // ATM implied vol
  orders: number;
  scale: number; // book depth multiplier
  longBias: number; // P(taker is long) → dealers short gamma when high
};

const PARAMS: Partial<Record<Asset, ModelParams>> = {
  SOL: { baseIv: 0.72, orders: 34, scale: 1.0, longBias: 0.62 },
  XRP: { baseIv: 0.68, orders: 26, scale: 0.6, longBias: 0.45 },
  BNB: { baseIv: 0.55, orders: 22, scale: 0.5, longBias: 0.5 },
  AVAX: { baseIv: 0.78, orders: 24, scale: 0.35, longBias: 0.58 },
};

// --- deterministic rng (stable book structure per asset) ---

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Black-Scholes greeks ---

function normPdf(x: number) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function normCdf(x: number) {
  // Abramowitz & Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly =
    t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const p = 1 - normPdf(x) * poly;
  return x >= 0 ? p : 1 - p;
}

function bsGreeks(spot: number, strike: number, iv: number, yearsToExpiry: number, isCall: boolean) {
  const T = Math.max(yearsToExpiry, 1 / 365 / 24);
  const d1 = (Math.log(spot / strike) + 0.5 * iv * iv * T) / (iv * Math.sqrt(T));
  const delta = isCall ? normCdf(d1) : normCdf(d1) - 1;
  const gamma = normPdf(d1) / (spot * iv * Math.sqrt(T));
  const theta = (-spot * normPdf(d1) * iv) / (2 * Math.sqrt(T)) / 365;
  const vega = (spot * normPdf(d1) * Math.sqrt(T)) / 100;
  return { delta, gamma, iv, theta, vega };
}

// Round strikes to a friendly grid: 1/2.5/5 × 10^n near 2.5% of spot.
function strikeStep(spot: number): number {
  const target = spot * 0.025;
  const mag = 10 ** Math.floor(Math.log10(target));
  for (const m of [1, 2.5, 5, 10]) {
    if (target <= m * mag) return m * mag;
  }
  return 10 * mag;
}

const TENOR_DAYS = [2, 5, 9, 16, 30];

export function buildModelBook(asset: Asset, spot: number, nowSec: number): NormalizedOrder[] {
  const p = PARAMS[asset];
  if (!p || !Number.isFinite(spot) || spot <= 0) return [];

  const rng = mulberry32(hashSeed(asset));
  const step = strikeStep(spot);
  const atm = Math.round(spot / step) * step;

  // Expiries snapped to 08:00 UTC like real listings.
  const dayStart = Math.floor(nowSec / 86400) * 86400;
  const expiries = TENOR_DAYS.map((d) => dayStart + d * 86400 + 8 * 3600);

  const orders: NormalizedOrder[] = [];
  for (let i = 0; i < p.orders; i++) {
    // Strikes cluster near the money, thinning toward the wings.
    const offset = Math.round((rng() - 0.5) * 2 * (1 + rng() * 5));
    const strike = Number((atm + offset * step).toPrecision(8));
    if (strike <= 0) continue;

    const expiryTs = expiries[Math.floor(rng() * expiries.length)];
    const isCall = rng() < 0.52;
    const takerIsLong = rng() < p.longBias;

    // Volatility smile: wings trade over ATM.
    const moneyness = strike / spot - 1;
    const iv = p.baseIv + 8 * moneyness * moneyness * p.baseIv * 0.4 + (rng() - 0.5) * 0.06;

    const collateralUsd = p.scale * (4_000 + rng() * rng() * 55_000);
    const spread = rng() < 0.2;
    const strikes = spread
      ? [strike, Number((strike + step * (isCall ? 2 : -2)).toPrecision(8))]
      : [strike];

    const maker = `0x${[...Array(40)].map(() => Math.floor(rng() * 16).toString(16)).join("")}`;

    orders.push({
      asset,
      structure: spread ? `${isCall ? "CALL" : "PUT"} SPREAD` : isCall ? "CALL" : "PUT",
      isCall,
      takerIsLong,
      strike,
      strikes,
      expiryTs,
      collateralUsd,
      maker,
      greeks: bsGreeks(spot, strike, iv, (expiryTs - nowSec) / (365 * 86400), isCall),
    });
  }
  return orders;
}
