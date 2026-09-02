// Historical realized-volatility context for the contract risk model
// (lib/contractRisk.ts). Two things come out of here, both derived from the
// same daily candle history we already proxy for the price chart:
//
//   baselineVol   — trailing 30d realized vol, annualized. The "is this IV
//                   rich or cheap" denominator.
//   ivPercentile  — where a given IV sits in the distribution of trailing 30d
//                   realized vol over the past year.
//
// The percentile is deliberately measured against REALIZED vol, not implied:
// nothing in this stack persists an implied-vol history, and inventing one
// would be exactly the kind of silent substitution the data-honesty rule
// forbids. Callers surface it as "vs. 1y realized" — never as "IV percentile"
// unqualified. Returns null on any upstream failure so the risk model drops
// the affected sub-scores and renormalizes rather than guessing.

import type { Asset } from "./assets";

const COINBASE_API_URL = process.env.COINBASE_API_URL ?? "https://api.exchange.coinbase.com";
const BINANCE_API_URL = process.env.BINANCE_API_URL ?? "https://data-api.binance.vision";

const COINBASE_PRODUCTS: Record<Asset, string> = { BTC: "BTC-USD", ETH: "ETH-USD" };
const BINANCE_SYMBOLS: Record<Asset, string> = { BTC: "BTCUSDT", ETH: "ETHUSDT" };

/** Trailing window for a single realized-vol reading. */
const RV_WINDOW_DAYS = 30;
/** How much history the percentile distribution is drawn from. */
const LOOKBACK_DAYS = 365;
/** Enough closes for LOOKBACK_DAYS of RV_WINDOW_DAYS-wide windows. */
const NEEDED_CLOSES = LOOKBACK_DAYS + RV_WINDOW_DAYS + 1;
/** Crypto trades every day — no 252-day business-year convention here. */
const DAYS_PER_YEAR = 365;

const CACHE_MS = 60 * 60 * 1000;
const STALE_SEC = 3 * 86400;

export type VolContext = {
  asset: Asset;
  /** Trailing 30d realized vol, annualized (0.55 = 55%). */
  baselineVol: number;
  /** Sorted distribution of trailing 30d realized vol over the lookback. */
  distribution: number[];
  windowDays: number;
  lookbackDays: number;
  source: "coinbase" | "binance";
  asOf: number;
};

const cache = new Map<Asset, { at: number; ctx: VolContext }>();
const inflight = new Map<Asset, Promise<VolContext | null>>();

type DailyClose = { t: number; c: number };

async function coinbaseCloses(asset: Asset): Promise<DailyClose[]> {
  const product = COINBASE_PRODUCTS[asset];
  // Coinbase caps a candle response at 300 rows, so the lookback is paged.
  const nowSec = Math.floor(Date.now() / 1000);
  const pages: Promise<number[][]>[] = [];
  for (let offset = 0; offset < NEEDED_CLOSES; offset += 280) {
    const end = nowSec - offset * 86400;
    const start = end - 280 * 86400;
    const url =
      `${COINBASE_API_URL}/products/${product}/candles?granularity=86400` +
      `&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`;
    pages.push(
      fetch(url, {
        headers: { "user-agent": "gammashield-hackathon" },
        signal: AbortSignal.timeout(6000),
      }).then(async (res) => {
        if (!res.ok) throw new Error(`coinbase ${res.status}`);
        return (await res.json()) as number[][];
      }),
    );
  }
  const rows = (await Promise.all(pages)).flat();
  const byTime = new Map<number, number>();
  for (const r of rows) byTime.set(r[0], r[4]);
  return [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, c]) => ({ t, c }));
}

async function binanceCloses(asset: Asset): Promise<DailyClose[]> {
  const url = `${BINANCE_API_URL}/api/v3/klines?symbol=${BINANCE_SYMBOLS[asset]}&interval=1d&limit=500`;
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`binance ${res.status}`);
  const rows = (await res.json()) as unknown[][];
  return rows.map((r) => ({ t: Math.floor(Number(r[0]) / 1000), c: Number(r[4]) }));
}

/** Annualized stdev of log returns over the trailing `window` closes. */
function realizedVol(closes: number[], from: number, window: number): number | null {
  if (from - window < 0) return null;
  const returns: number[] = [];
  for (let i = from - window + 1; i <= from; i++) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if (!(prev > 0) || !(cur > 0)) return null;
    returns.push(Math.log(cur / prev));
  }
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const vol = Math.sqrt(variance * DAYS_PER_YEAR);
  return Number.isFinite(vol) && vol > 0 ? vol : null;
}

function build(asset: Asset, candles: DailyClose[], source: "coinbase" | "binance"): VolContext | null {
  const usable = candles.filter((d) => Number.isFinite(d.c) && d.c > 0 && Number.isFinite(d.t));
  // Staleness guard, matching the klines proxy: a feed that quietly serves
  // year-old candles would poison the baseline with no visible error.
  const newest = usable.length ? usable[usable.length - 1].t : 0;
  if (Date.now() / 1000 - newest > STALE_SEC) return null;
  const clean = usable.map((d) => d.c);
  // Need at least a couple of months of windows for a percentile to mean anything.
  if (clean.length < RV_WINDOW_DAYS + 60) return null;

  const distribution: number[] = [];
  for (let i = RV_WINDOW_DAYS; i < clean.length; i++) {
    const rv = realizedVol(clean, i, RV_WINDOW_DAYS);
    if (rv !== null) distribution.push(rv);
  }
  const baselineVol = realizedVol(clean, clean.length - 1, RV_WINDOW_DAYS);
  if (baselineVol === null || !distribution.length) return null;

  return {
    asset,
    baselineVol,
    distribution: distribution.slice(-LOOKBACK_DAYS).sort((a, b) => a - b),
    windowDays: RV_WINDOW_DAYS,
    lookbackDays: Math.min(distribution.length, LOOKBACK_DAYS),
    source,
    asOf: Date.now(),
  };
}

/**
 * Fraction of the lookback distribution sitting at or below `vol`, 0–1.
 * Pure — exported so the risk model stays free of I/O.
 */
export function percentileOf(ctx: VolContext, vol: number): number | null {
  if (!Number.isFinite(vol) || vol <= 0 || !ctx.distribution.length) return null;
  let below = 0;
  for (const v of ctx.distribution) {
    if (v <= vol) below++;
    else break;
  }
  return below / ctx.distribution.length;
}

export async function getVolContext(asset: Asset): Promise<VolContext | null> {
  const hit = cache.get(asset);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.ctx;
  const pending = inflight.get(asset);
  if (pending) return pending;

  const task = (async () => {
    // Coinbase first, Binance fallback, staleness guard — same contract as
    // the klines proxy so one flaky upstream never silently degrades a score.
    for (const source of ["coinbase", "binance"] as const) {
      try {
        const candles = source === "coinbase" ? await coinbaseCloses(asset) : await binanceCloses(asset);
        const ctx = build(asset, candles, source);
        if (ctx) {
          cache.set(asset, { at: Date.now(), ctx });
          return ctx;
        }
      } catch {
        // fall through to the next source
      }
    }
    return null;
  })().finally(() => inflight.delete(asset));

  inflight.set(asset, task);
  return task;
}

/** Exported for the self-check (scripts/contract-risk-self-check.mts). */
export const __internals = { realizedVol, build, STALE_SEC, NEEDED_CLOSES };
