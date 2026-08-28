// Server-side live snapshot from the Thetanuts SDK.
// One fetch feeds the whole dashboard; cached briefly to be gentle on the RPC.

import { ethers } from "ethers";
import { ThetanutsClient } from "@thetanuts-finance/thetanuts-client";
import {
  computeAssetSnapshot,
  type AssetSnapshot,
  type NormalizedOrder,
} from "./engine";

export type MarketSnapshot = {
  ts: number;
  prices: { BTC: number; ETH: number };
  ticker: { symbol: string; price: number }[];
  assets: { BTC: AssetSnapshot; ETH: AssetSnapshot };
  feed: FeedRow[];
  book: { totalOrders: number; withGreeks: number };
  source: "live" | "cache";
};

export type FeedRow = {
  asset: "BTC" | "ETH";
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
  maker: string;
};

const RPC_URL = process.env.THETANUTS_RPC_URL ?? "https://mainnet.base.org";
const CACHE_MS = 8_000;

let client: ThetanutsClient | null = null;
let cached: MarketSnapshot | null = null;
let cachedAt = 0;
let inflight: Promise<MarketSnapshot> | null = null;

export function getClient(): ThetanutsClient {
  if (!client) {
    client = new ThetanutsClient({
      chainId: 8453,
      provider: new ethers.JsonRpcProvider(RPC_URL),
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

      normalized.push({
        asset,
        structure:
          strikes.length === 1
            ? raw.isCall
              ? "CALL"
              : "PUT"
            : `${raw.isCall ? "CALL" : "PUT"} ${STRUCTURE_BY_LEGS[strikes.length] ?? "MULTI"}`,
        isCall: raw.isCall,
        takerIsLong: raw.isLong,
        strike: strikes[0],
        strikes,
        expiryTs: Number(o.order.expiry),
        collateralUsd,
        maker: o.makerAddress,
        greeks: raw.greeks ?? null,
      });
    }

    const nowSec = Math.floor(now / 1000);
    const tickerSymbols = ["BTC", "ETH", "SOL", "XRP", "BNB", "AVAX"];
    const snapshot: MarketSnapshot = {
      ts: now,
      prices,
      ticker: tickerSymbols
        .map((symbol) => ({ symbol, price: market.prices[symbol] }))
        .filter((t) => Number.isFinite(t.price) && t.price > 0),
      assets: {
        BTC: computeAssetSnapshot("BTC", prices.BTC, normalized, nowSec),
        ETH: computeAssetSnapshot("ETH", prices.ETH, normalized, nowSec),
      },
      feed: normalized
        .filter((o) => o.expiryTs > nowSec)
        .sort((a, b) => a.expiryTs - b.expiryTs)
        .slice(0, 60)
        .map((o) => ({
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
          maker: o.maker,
        })),
      book: {
        totalOrders: orders.length,
        withGreeks: orders.filter((o) => o.rawApiData?.greeks).length,
      },
      source: "live",
    };

    cached = snapshot;
    cachedAt = Date.now();
    return snapshot;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}
