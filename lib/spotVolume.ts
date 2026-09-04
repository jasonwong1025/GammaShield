// Measured 24h spot volume, the denominator for market-impact estimates
// (lib/marketImpact.ts).
//
// Coinbase and Binance are summed rather than one falling back to the other:
// impact scales with 1/sqrt(volume), so which venues are counted changes the
// answer, and the honest thing is to name them. `sources` always lists the
// venues that actually contributed, and a single-venue reading is labelled as
// such instead of being scaled up to a guess at global volume. Both feeds
// failing returns null — callers drop the impact estimate rather than
// substituting a constant.
//
// This is deliberately NOT global volume. Real BTC spot trades across dozens
// of venues; two of them is a floor, which makes every impact number here an
// over-estimate. Said plainly in the UI, never silently corrected for.

import type { Asset } from "./assets";

const COINBASE_API_URL = process.env.COINBASE_API_URL ?? "https://api.exchange.coinbase.com";
const BINANCE_API_URL = process.env.BINANCE_API_URL ?? "https://data-api.binance.vision";

const COINBASE_PRODUCTS: Record<Asset, string> = { BTC: "BTC-USD", ETH: "ETH-USD" };
const BINANCE_SYMBOLS: Record<Asset, string> = { BTC: "BTCUSDT", ETH: "ETHUSDT" };

const CACHE_MS = 5 * 60 * 1000;
/** Newest hourly candle / ticker close must be at least this fresh. */
const STALE_SEC = 2 * 3600;
const HOURS = 24;

export type SpotVolume = {
  asset: Asset;
  /** Sum of the contributing venues' trailing-24h USD volume. */
  advUsd: number;
  /** Venues that actually contributed, in the order they were summed. */
  sources: string[];
  /** Newest upstream timestamp behind the reading, unix seconds. */
  asOf: number;
};

const cache = new Map<Asset, { at: number; vol: SpotVolume }>();
const inflight = new Map<Asset, Promise<SpotVolume | null>>();

type VenueVolume = { venue: string; usd: number; asOf: number };

// Coinbase publishes a 24h stat but no timestamp with it. Hourly candles carry
// one, so the staleness guard has something real to check — same convention as
// the klines proxy.
async function coinbaseVolume(asset: Asset): Promise<VenueVolume> {
  const product = COINBASE_PRODUCTS[asset];
  const res = await fetch(`${COINBASE_API_URL}/products/${product}/candles?granularity=3600`, {
    headers: { "user-agent": "gammashield-hackathon" },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`coinbase ${res.status}`);
  const rows: number[][] = await res.json();
  // [time, low, high, open, close, volume], newest first, volume in base units.
  const recent = rows
    .filter((r) => Number.isFinite(r[0]) && Number.isFinite(r[4]) && Number.isFinite(r[5]))
    .sort((a, b) => b[0] - a[0])
    .slice(0, HOURS);
  if (recent.length < HOURS) throw new Error("coinbase short candle history");
  const asOf = recent[0][0];
  if (Date.now() / 1000 - asOf > STALE_SEC) throw new Error("coinbase volume stale");
  const usd = recent.reduce((s, r) => s + r[5] * r[4], 0);
  if (!(usd > 0)) throw new Error("coinbase volume empty");
  return { venue: "coinbase", usd, asOf };
}

async function binanceVolume(asset: Asset): Promise<VenueVolume> {
  const symbol = BINANCE_SYMBOLS[asset];
  const res = await fetch(`${BINANCE_API_URL}/api/v3/ticker/24hr?symbol=${symbol}`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`binance ${res.status}`);
  const json = await res.json();
  // quoteVolume is already denominated in the quote asset (USDT ≈ USD).
  const usd = Number(json.quoteVolume);
  const asOf = Math.floor(Number(json.closeTime) / 1000);
  if (!(usd > 0) || !Number.isFinite(asOf)) throw new Error("binance volume empty");
  if (Date.now() / 1000 - asOf > STALE_SEC) throw new Error("binance volume stale");
  return { venue: "binance", usd, asOf };
}

async function build(asset: Asset): Promise<SpotVolume | null> {
  const results = await Promise.allSettled([coinbaseVolume(asset), binanceVolume(asset)]);
  const ok = results
    .filter((r): r is PromiseFulfilledResult<VenueVolume> => r.status === "fulfilled")
    .map((r) => r.value);
  if (!ok.length) return null;
  return {
    asset,
    advUsd: ok.reduce((s, v) => s + v.usd, 0),
    sources: ok.map((v) => v.venue),
    asOf: Math.max(...ok.map((v) => v.asOf)),
  };
}

export async function getSpotVolume(asset: Asset): Promise<SpotVolume | null> {
  const hit = cache.get(asset);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.vol;
  const running = inflight.get(asset);
  if (running) return running;

  const task = build(asset)
    .then((vol) => {
      if (vol) cache.set(asset, { at: Date.now(), vol });
      return vol;
    })
    .catch(() => null)
    .finally(() => inflight.delete(asset));

  inflight.set(asset, task);
  return task;
}

export const __internals = { coinbaseVolume, binanceVolume, STALE_SEC, HOURS };
