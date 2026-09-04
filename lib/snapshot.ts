// Server-side live snapshot from the Thetanuts SDK.
// One fetch feeds the whole dashboard; cached briefly to be gentle on the RPC.

import { ethers } from "ethers";
import { ThetanutsClient } from "@thetanuts-finance/thetanuts-client";
import {
  computeAssetSnapshot,
  type AssetSnapshot,
  type NormalizedOrder,
} from "./engine";
import { ALL_ASSETS, type Asset } from "./assets";
import { bsOptionPrice, bsRho } from "./modelBook";
import { computeContractRisk, type ContractRisk } from "./contractRisk";
import { getVolContext, percentileOf, type VolContext } from "./realizedVol";
import { getSpotVolume, type SpotVolume } from "./spotVolume";
import type { ImpactBasis } from "./marketImpact";

export type MarketSnapshot = {
  ts: number;
  prices: { BTC: number; ETH: number };
  ticker: { symbol: string; price: number }[];
  assets: Record<Asset, AssetSnapshot>;
  feed: FeedRow[];
  book: { totalOrders: number; withGreeks: number };
  /** What the contract risk model used as its realized-vol reference, per
   * asset, so the UI can name the source instead of implying an IV history
   * we do not keep. Null when the candle feeds were unreachable. */
  volBaseline: Record<Asset, { vol: number; windowDays: number; lookbackDays: number; source: string } | null>;
  /** Measured spot volume behind every market-impact estimate, per asset, so
   * the UI can name the venues instead of implying global volume. Null when
   * both feeds were unreachable. */
  spotVolume: Record<Asset, SpotVolume | null>;
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
  /** Per-contract risk for this exact option (lib/contractRisk.ts) — a
   * different question from the book-level `impact` below. Null for
   * multi-leg orders, whose per-leg premiums and greeks the pricing API
   * does not break out. */
  risk: ContractRisk | null;
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
  /** Everything lib/marketImpact.ts needs to price this fill's effect on SPOT
   * at any what-if size, minus the strike ladder — that is one array per
   * asset, already on the client for the GEX chart, so it is merged in there
   * rather than repeated on 200 rows. Null without greeks. */
  impactBasis: Omit<ImpactBasis, "gexByStrike"> | null;
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
  const ticker = ALL_ASSETS
    .map((symbol) => ({ symbol, price: market.prices[symbol] }))
    .filter((t) => Number.isFinite(t.price) && t.price > 0);
  priceCache = { at: Date.now(), ticker };
  return ticker;
}

export async function getMarketSnapshot({ fresh = false }: { fresh?: boolean } = {}): Promise<MarketSnapshot> {
  const now = Date.now();
  if (!fresh && cached && now - cachedAt < CACHE_MS) return { ...cached, source: "cache" };
  if (inflight) return inflight;

  inflight = (async () => {
    const c = getClient();
    // Realized-vol history feeds the IV component of contract risk. It is
    // hourly-cached and independently fallible: a failure drops those
    // sub-scores rather than failing the snapshot.
    const [orders, market, volContexts, spotVolumes] = await Promise.all([
      c.api.fetchOrders(),
      c.api.getMarketData(),
      Promise.all(ALL_ASSETS.map((a) => getVolContext(a).catch(() => null))),
      // Denominator for market impact (lib/marketImpact.ts). Fails the same
      // way: the estimate drops and says so, it is never back-filled.
      Promise.all(ALL_ASSETS.map((a) => getSpotVolume(a).catch(() => null))),
    ]);
    const volByAsset = Object.fromEntries(
      ALL_ASSETS.map((a, i) => [a, volContexts[i]]),
    ) as Record<Asset, VolContext | null>;
    const spotVolByAsset = Object.fromEntries(
      ALL_ASSETS.map((a, i) => [a, spotVolumes[i]]),
    ) as Record<Asset, SpotVolume | null>;

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

    // Best live bid/ask and resting depth per contract. A maker's side is the
    // inverse of the taker's: an order the taker can lift is an ask, one the
    // taker can hit is a bid. About a tenth of contracts are quoted both ways;
    // the rest fall back to a modelled spread inside lib/contractRisk.ts.
    type ContractQuote = { bidUsd: number | null; askUsd: number | null; depthUsd: number };
    const contractKey = (o: NormalizedOrder) =>
      `${o.asset}|${o.isCall ? "C" : "P"}|${o.strikes.join("_")}|${o.expiryTs}`;
    const quotes = new Map<string, ContractQuote>();
    for (const o of normalized) {
      const key = contractKey(o);
      const q = quotes.get(key) ?? { bidUsd: null, askUsd: null, depthUsd: 0 };
      q.depthUsd += o.collateralUsd;
      const px = o.pricePerContractUsd;
      if (px !== null && px > 0) {
        if (o.takerIsLong) q.askUsd = q.askUsd === null ? px : Math.min(q.askUsd, px);
        else q.bidUsd = q.bidUsd === null ? px : Math.max(q.bidUsd, px);
      }
      quotes.set(key, q);
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
          // Per-contract risk. Single-leg only: the pricing API returns one
          // premium and one greeks block for a multi-leg order, and splitting
          // those across legs would be invention, not measurement.
          const spotFor = market.prices[o.asset] ?? 0;
          const vol = volByAsset[o.asset];
          const quote = quotes.get(contractKey(o)) ?? {
            bidUsd: null,
            askUsd: null,
            depthUsd: o.collateralUsd,
          };
          const risk =
            o.strikes.length === 1 && o.greeks && o.pricePerContractUsd !== null && spotFor > 0
              ? computeContractRisk({
                  asset: o.asset,
                  spot: spotFor,
                  nowSec,
                  expiryTs: o.expiryTs,
                  legs: [
                    {
                      isCall: o.isCall,
                      action: o.takerIsLong ? "buy" : "sell",
                      strike: o.strike,
                      qty: o.collateralUsd / Math.max(o.strike, 1),
                      premiumUsd: o.pricePerContractUsd,
                      iv: o.greeks.iv,
                      thetaUsd: o.greeks.theta,
                      vegaUsd: o.greeks.vega,
                      deltaPerContract: o.greeks.delta,
                    },
                  ],
                  marketScore: before.score,
                  baselineVol: vol?.baselineVol ?? null,
                  ivPercentile: vol ? percentileOf(vol, o.greeks.iv) : null,
                  liquidity: {
                    bidUsd: quote.bidUsd,
                    askUsd: quote.askUsd,
                    fairUsd: bsOptionPrice(
                      spotFor,
                      o.strike,
                      o.greeks.iv,
                      (o.expiryTs - nowSec) / (365 * 86400),
                      o.isCall,
                    ),
                    contractDepthUsd: quote.depthUsd,
                    // Browse view — no size chosen yet, so the participation
                    // sub-score drops rather than assuming one.
                    tradeSizeUsd: null,
                  },
                })
              : null;

          // Effect on SPOT if this order gets filled (lib/marketImpact.ts).
          // Only the per-contract inputs travel: the browser re-runs the math
          // for any what-if size without another round trip.
          const sv = spotVolByAsset[o.asset];
          const impactBasis: FeedRow["impactBasis"] =
            o.greeks && spotFor > 0
              ? {
                  spot: spotFor,
                  strike: o.strike,
                  gammaPerContract: o.greeks.gamma,
                  deltaPerContract: o.greeks.delta,
                  // The taker lifts a resting order, so a maker-sold order is
                  // one the taker buys.
                  takerIsLong: o.takerIsLong,
                  netGexUsd: before.netGexUsd,
                  advUsd: sv?.advUsd ?? null,
                  advSources: sv?.sources ?? [],
                  baselineVol: vol?.baselineVol ?? null,
                  volSource: vol?.source ?? null,
                }
              : null;

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
            risk,
            impact,
            impactBasis,
          };
        }),
      book: {
        totalOrders: orders.length,
        withGreeks: orders.filter((o) => o.rawApiData?.greeks).length,
      },
      volBaseline: Object.fromEntries(
        ALL_ASSETS.map((a) => {
          const v = volByAsset[a];
          return [
            a,
            v
              ? { vol: v.baselineVol, windowDays: v.windowDays, lookbackDays: v.lookbackDays, source: v.source }
              : null,
          ];
        }),
      ) as MarketSnapshot["volBaseline"],
      spotVolume: spotVolByAsset,
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
