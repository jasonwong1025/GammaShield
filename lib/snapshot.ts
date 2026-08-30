// Server-side live snapshot from the Thetanuts SDK.
// One fetch feeds the whole dashboard; cached briefly to be gentle on the RPC.

import { ethers } from "ethers";
import { ThetanutsClient } from "@thetanuts-finance/thetanuts-client";
import {
  computeAssetSnapshot,
  type AssetSnapshot,
  type NormalizedOrder,
} from "./engine";
import { ALL_ASSETS, isOptionsAsset, type Asset } from "./assets";
import { buildModelBook, bsRho } from "./modelBook";

export type MarketSnapshot = {
  ts: number;
  prices: { BTC: number; ETH: number };
  ticker: { symbol: string; price: number }[];
  assets: Record<Asset, AssetSnapshot>;
  feed: FeedRow[];
  book: { totalOrders: number; withGreeks: number };
  source: "live" | "cache";
};

export type FeedRow = {
  asset: Asset;
  structure: string;
  isCall: boolean;
  takerIsLong: boolean;
  strike: number;
  strikes: number[];
  expiryTs: number;
  collateralUsd: number;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  /** Not in the Thetanuts pricing API — Black-Scholes-derived; see lib/modelBook.ts. */
  rho: number | null;
  pricePerContractUsd: number | null;
  maker: string;
  /** What buying this order's full listed size would do to market-structure
   * risk (lib/engine.ts, deterministic). Null when the order carries no
   * greeks to price the hypothetical fill. Feeds the per-row risk drill-down
   * in components/BookFeed.tsx. */
  impact: {
    scoreBefore: number;
    scoreAfter: number;
    netGexBefore: number;
    netGexAfter: number;
    regimeBefore: string;
    regimeAfter: string;
  } | null;
};

const CACHE_MS = 8_000;

let client: ThetanutsClient | null = null;
let cached: MarketSnapshot | null = null;
let cachedAt = 0;
let inflight: Promise<MarketSnapshot> | null = null;
let lastNormalized: NormalizedOrder[] = [];

/** Normalized rows from the most recent snapshot build (for what-if math). */
export function getLastNormalizedOrders(): NormalizedOrder[] {
  return lastNormalized;
}

export function getClient(): ThetanutsClient {
  if (!client) {
    const rpcUrl = process.env.BASE_RPC_URL?.trim();
    if (!rpcUrl) throw new Error("BASE_RPC_URL is not configured");
    client = new ThetanutsClient({
      chainId: 8453,
      provider: new ethers.JsonRpcProvider(rpcUrl),
    });
  }
  return client;
}

const STRUCTURE_BY_LEGS: Record<number, string> = {
  2: "SPREAD",
  3: "FLY",
  4: "CONDOR",
};

// Fast path for the live header/ticker: prices only, cached a few seconds.
const PRICE_CACHE_MS = 3_000;
let priceCache: { at: number; ticker: { symbol: string; price: number }[] } | null = null;

export async function getLivePrices() {
  if (priceCache && Date.now() - priceCache.at < PRICE_CACHE_MS) return priceCache.ticker;
  const market = await getClient().api.getMarketData();
  const ticker = ["BTC", "ETH", "SOL", "XRP", "BNB", "AVAX"]
    .map((symbol) => ({ symbol, price: market.prices[symbol] }))
    .filter((t) => Number.isFinite(t.price) && t.price > 0);
  priceCache = { at: Date.now(), ticker };
  return ticker;
}

export async function getMarketSnapshot(): Promise<MarketSnapshot> {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_MS) return { ...cached, source: "cache" };
  if (inflight) return inflight;

  inflight = (async () => {
    const c = getClient();
    const [orders, market] = await Promise.all([
      c.api.fetchOrders(),
      c.api.getMarketData(),
    ]);

    const prices = { BTC: market.prices.BTC, ETH: market.prices.ETH };
    const feeds = c.chainConfig.priceFeeds;
    const btcFeed = feeds.BTC?.toLowerCase();
    const ethFeed = feeds.ETH?.toLowerCase();

    const tokensByAddress = new Map<string, { symbol: string; decimals: number }>();
    for (const t of Object.values(c.chainConfig.tokens)) {
      tokensByAddress.set(t.address.toLowerCase(), {
        symbol: t.symbol,
        decimals: t.decimals,
      });
    }
    const tokenUsd = (symbol: string) =>
      symbol === "WETH" ? prices.ETH : symbol === "cbBTC" ? prices.BTC : 1;

    const normalized: NormalizedOrder[] = [];
    for (const o of orders) {
      const raw = o.rawApiData;
      if (!raw) continue;

      const feed = raw.priceFeed?.toLowerCase();
      const asset: "BTC" | "ETH" | null =
        feed === btcFeed ? "BTC" : feed === ethFeed ? "ETH" : null;
      if (!asset) continue;

      const token = tokensByAddress.get(raw.collateral?.toLowerCase() ?? "");
      if (!token) continue;
      const collateralUsd =
        (Number(o.availableAmount) / 10 ** token.decimals) * tokenUsd(token.symbol);
      if (!Number.isFinite(collateralUsd) || collateralUsd <= 0) continue;

      const strikes = (raw.strikes ?? []).map((s) => Number(s) / 1e8);
      if (!strikes.length) continue;

      const expiryTs = Number(o.order.expiry);
      const spot = market.prices[asset];
      // The pricing API's greeks cover delta/gamma/theta/vega but not rho —
      // derive it via Black-Scholes at the same IV, consistent with the
      // modeled book's greeks.
      const greeks =
        raw.greeks && spot > 0
          ? { ...raw.greeks, rho: bsRho(spot, strikes[0], raw.greeks.iv, (expiryTs - now / 1000) / (365 * 86400), raw.isCall) }
          : null;

      normalized.push({
        asset,
        structure:
          strikes.length === 1
            ? raw.isCall
              ? "CALL"
              : "PUT"
            : `${raw.isCall ? "CALL" : "PUT"} ${STRUCTURE_BY_LEGS[strikes.length] ?? "MULTI"}`,
        isCall: raw.isCall,
        // raw.isLong is the MAKER's side (verified empirically on a mainnet
        // fork: filling an isLong=true order pays the taker premium — the
        // maker is buying). The taker is long only when the maker sells.
        takerIsLong: !raw.isLong,
        strike: strikes[0],
        strikes,
        expiryTs,
        collateralUsd,
        maker: o.makerAddress,
        greeks,
        pricePerContractUsd: (Number(o.order.price) / 1e8) * tokenUsd(token.symbol),
      });
    }

    const nowSec = Math.floor(now / 1000);

    // Assets without a live Thetanuts market get a modeled book priced off
    // live spot, so the full risk stack works everywhere (labeled in the UI).
    for (const symbol of ALL_ASSETS) {
      if (isOptionsAsset(symbol)) continue;
      normalized.push(...buildModelBook(symbol, market.prices[symbol], nowSec));
    }

    const assetsBefore = Object.fromEntries(
      ALL_ASSETS.map((symbol) => [
        symbol,
        computeAssetSnapshot(symbol, market.prices[symbol] ?? 0, normalized, nowSec),
      ]),
    ) as Record<Asset, AssetSnapshot>;

    const snapshot: MarketSnapshot = {
      ts: now,
      prices,
      ticker: ALL_ASSETS
        .map((symbol) => ({ symbol, price: market.prices[symbol] }))
        .filter((t) => Number.isFinite(t.price) && t.price > 0),
      assets: assetsBefore,
      feed: normalized
        .filter((o) => o.expiryTs > nowSec)
        .sort((a, b) => a.expiryTs - b.expiryTs)
        .slice(0, 200)
        .map((o) => {
          const before = assetsBefore[o.asset];
          // Precomputed here (deterministic, free — lib/engine.ts) so a click
          // in the UI reveals it instantly with no round trip: "if this
          // order's full listed size gets bought, how does market-structure
          // risk move." Same what-if math as the trade-quote impact block.
          let impact: FeedRow["impact"] = null;
          if (o.greeks && o.collateralUsd > 0) {
            const after = computeAssetSnapshot(
              o.asset,
              market.prices[o.asset] ?? 0,
              [...normalized, { ...o, takerIsLong: true }],
              nowSec,
            );
            impact = {
              scoreBefore: before.score,
              scoreAfter: after.score,
              netGexBefore: before.netGexUsd,
              netGexAfter: after.netGexUsd,
              regimeBefore: before.regime,
              regimeAfter: after.regime,
            };
          }
          return {
            asset: o.asset,
            structure: o.structure,
            isCall: o.isCall,
            takerIsLong: o.takerIsLong,
            strike: o.strike,
            strikes: o.strikes,
            expiryTs: o.expiryTs,
            collateralUsd: o.collateralUsd,
            iv: o.greeks?.iv ?? null,
            delta: o.greeks?.delta ?? null,
            gamma: o.greeks?.gamma ?? null,
            theta: o.greeks?.theta ?? null,
            vega: o.greeks?.vega ?? null,
            rho: o.greeks?.rho ?? null,
            pricePerContractUsd: o.pricePerContractUsd,
            maker: o.maker,
            impact,
          };
        }),
      book: {
        totalOrders: orders.length,
        withGreeks: orders.filter((o) => o.rawApiData?.greeks).length,
      },
      source: "live",
    };

    cached = snapshot;
    cachedAt = Date.now();
    lastNormalized = normalized;
    return snapshot;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}
