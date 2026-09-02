// Server-side trade quoting.
// Thetanuts prices a fixed tenor grid (client.mmPricing), not a continuous
// range — real, Friday-anchored expiries like ~weekly/~biweekly/~4-week that
// count down day by day (today's "weekly" might read as 6d, not 7d). We offer
// the three standard periods (7/14/28d) and, for each, quote the real grid
// tenor nearest to it — never an interpolated day that doesn't exist:
//   • if a listed maker order exists at that exact expiry ("fillable"), the
//     quote is that order's real price and we prepare approve + fill calldata
//     — instant fill;
//   • otherwise the quote is the MM ask at that real tenor (an executable-size
//     estimate; filling it goes through the OptionFactory RFQ auction).
// The SDK stays read-only here: only the user's browser wallet ever signs.

import type { ThetanutsClient } from "@thetanuts-finance/thetanuts-client";
import { getClient, getMarketSnapshot, getLastNormalizedOrders } from "./snapshot";
import { computeAssetSnapshot, type NormalizedOrder } from "./engine";
import { bsGreeks, bsOptionPrice, bsRho } from "./modelBook";
import { computeContractRisk, type ContractRisk } from "./contractRisk";
import { getVolContext, percentileOf } from "./realizedVol";
import { isOptionsAsset, type Asset, type OptionsAsset } from "./assets";
import { TRADE_PERIODS, type TradePeriod } from "./tradePeriods";

export { TRADE_PERIODS, type TradePeriod } from "./tradePeriods";

type SdkOrder = Awaited<ReturnType<ThetanutsClient["api"]["fetchOrders"]>>[number];
type MmRow = Awaited<ReturnType<ThetanutsClient["mmPricing"]["getPricingArray"]>>[number];

export type TradeSide = "call" | "put";

export type TradeQuoteOptions = {
  /** Bypass the short server cache before a user action. */
  fresh?: boolean;
  /** Prefer a protective put within this USD premium ceiling. */
  maxPremiumUsd?: number;
  /** Require this exact listed/MM strike; never silently substitute another. */
  strike?: number;
  /** Require this exact real Thetanuts expiry; never synthesize a tenor. */
  expiry?: number;
};

export type TradeQuote = {
  asset: Asset;
  side: TradeSide;
  spot: number;
  /** The 3 standard periods resolved to their real grid tenor. `fillable` = listed maker order exists there. */
  expiries: { period: TradePeriod; ts: number; days: number; fillable: boolean }[];
  /** Echo of the requested standard period this quote answers. */
  requestedPeriod: TradePeriod;
  expiryTs: number;
  strike: number;
  /** "book" = live maker order (instant fill) · "mm" = MM ask estimate (RFQ-only expiry). */
  source: "book" | "mm";
  /** Premium currency: the maker's collateral token for book fills, the underlying for MM quotes. */
  premiumToken: string;
  premiumPerContractToken: number;
  premiumPerContractUsd: number;
  contracts: number;
  maxContracts: number | null;
  totalCostToken: number;
  totalCostUsd: number;
  breakEven: number;
  iv: number | null;
  maker: string | null;
  /** Full per-contract greeks for this quote — real (book) or Black-Scholes
   * fallback (MM/RFQ or missing pricing-API data); rho is always derived,
   * see lib/modelBook.ts. Feeds the AI risk read (lib/aiRisk.ts). */
  greeks: NormalizedOrder["greeks"];
  /** Per-contract risk for the option being bought (lib/contractRisk.ts).
   * Unlike the browse view in the book feed, a real size is known here, so
   * the liquidity participation sub-score is measured rather than dropped. */
  risk: ContractRisk | null;
  /** How filling this trade would move the market-structure risk. */
  impact: {
    scoreBefore: number;
    scoreAfter: number;
    netGexBefore: number;
    netGexAfter: number;
    regimeBefore: string;
    regimeAfter: string;
  } | null;
  /** Transactions for the wallet (book fills only): approve premium token, then fill. */
  txs: {
    chainId: string;
    approve: { to: string; data: string };
    fill: { to: string; data: string };
  } | null;
};

const ORDERS_CACHE_MS = 5_000;
const PRICING_CACHE_MS = 15_000;
let ordersCache: { at: number; orders: SdkOrder[] } | null = null;
const pricingCache = new Map<string, { at: number; rows: MmRow[] }>();

async function getBookOrders(c: ThetanutsClient, fresh = false): Promise<SdkOrder[]> {
  if (!fresh && ordersCache && Date.now() - ordersCache.at < ORDERS_CACHE_MS) return ordersCache.orders;
  const orders = await c.api.fetchOrders();
  ordersCache = { at: Date.now(), orders };
  return orders;
}

async function getMmPricing(c: ThetanutsClient, asset: OptionsAsset, fresh = false): Promise<MmRow[]> {
  const cached = pricingCache.get(asset);
  if (!fresh && cached && Date.now() - cached.at < PRICING_CACHE_MS) return cached.rows;
  const rows = await c.mmPricing.getPricingArray(asset);
  pricingCache.set(asset, { at: Date.now(), rows });
  return rows;
}

export async function getTradeQuote(
  asset: Asset,
  side: TradeSide,
  contracts: number,
  period: TradePeriod,
  options: TradeQuoteOptions = {},
): Promise<TradeQuote> {
  const { fresh = false, maxPremiumUsd, strike: requestedStrike, expiry: requestedExpiry } = options;
  if (!isOptionsAsset(asset)) {
    throw new Error(`${asset} has no live Thetanuts market to trade`);
  }

  const c = getClient();
  const [orders, market, snapshot, pricing] = await Promise.all([
    getBookOrders(c, fresh),
    c.api.getMarketData(),
    getMarketSnapshot({ fresh }), // keeps getLastNormalizedOrders() fresh for impact math
    getMmPricing(c, asset, fresh),
  ]);
  const spot = market.prices[asset];
  if (!Number.isFinite(spot) || spot <= 0) throw new Error(`no live ${asset} spot price`);

  const feed = c.chainConfig.priceFeeds[asset]?.toLowerCase();
  const nowSec = Math.floor(Date.now() / 1000);
  const isCall = side === "call";

  // Buyable book orders = vanilla, maker is selling (taker goes long).
  // raw.isLong is the MAKER's side — maker sells when it is false (verified
  // on a mainnet fork; filling an isLong=true order makes the taker the
  // seller: they post collateral and receive the premium).
  const buyable = orders.filter((o) => {
    const raw = o.rawApiData;
    return (
      raw &&
      !raw.isLong &&
      raw.isCall === isCall &&
      raw.strikes?.length === 1 &&
      raw.priceFeed?.toLowerCase() === feed &&
      Number(o.order.expiry) > nowSec &&
      raw.orderExpiryTimestamp > nowSec &&
      o.availableAmount > 0n
    );
  });
  const fillableTs = new Set(buyable.map((o) => Number(o.order.expiry)));

  // Duration axis: the SDK's own pricing tenor grid, not an arbitrary day
  // count. A listed order only marks its matching grid expiry as fillable;
  // otherwise one short-dated maker order would incorrectly become every
  // period in the UI.
  const sideRows = pricing.filter((r) => r.isCall === isCall && r.expiry > nowSec);
  if (!sideRows.length && !buyable.length) {
    throw new Error(`no live ${asset} ${side} pricing right now`);
  }
  const mmTenors = [...new Set(sideRows.map((r) => r.expiry))];
  const bookTenors = [...fillableTs];
  const nearestTenor = (targetDays: number, candidates: number[]): number | null => {
    if (!candidates.length) return null;
    return candidates.reduce((best, ts) =>
      Math.abs((ts - nowSec) / 86400 - targetDays) < Math.abs((best - nowSec) / 86400 - targetDays)
        ? ts
        : best,
    );
  };
  const expiries = TRADE_PERIODS.map((p) => {
    const ts = nearestTenor(p, mmTenors) ?? nearestTenor(p, bookTenors);
    return ts == null ? null : { period: p, ts, days: (ts - nowSec) / 86400, fillable: fillableTs.has(ts) };
  }).filter((e): e is NonNullable<typeof e> => e != null);
  if (!expiries.length) throw new Error(`no ${asset} ${side} expiries available`);

  const targetEntry = requestedExpiry == null
    ? expiries.find((e) => e.period === period) ?? expiries[0]
    : (() => {
        const available = new Set([...mmTenors, ...bookTenors]);
        if (!available.has(requestedExpiry)) {
          throw new Error("requested expiry is no longer available on the live Thetanuts book");
        }
        return {
          period,
          ts: requestedExpiry,
          days: (requestedExpiry - nowSec) / 86400,
          fillable: fillableTs.has(requestedExpiry),
        };
      })();
  const targetTs = targetEntry.ts;

  // For a protective plan, prefer a listed put within the user's premium
  // ceiling; otherwise preserve the normal nearest-ATM selection. The SDK
  // preview below remains authoritative for the final fill amount.
  const bookBest = targetEntry.fillable
    ? buyable
        .filter(
          (o) =>
            Number(o.order.expiry) === targetTs &&
            (requestedStrike == null || Number(o.rawApiData!.strikes[0]) / 1e8 === requestedStrike),
        )
        .sort((a, b) => {
          const sa = Number(a.rawApiData!.strikes[0]) / 1e8;
          const sb = Number(b.rawApiData!.strikes[0]) / 1e8;
          if (side === "put" && maxPremiumUsd != null) {
            const usd = (order: typeof a) => {
              const token = Object.values(c.chainConfig.tokens).find(
                (entry) => entry.address.toLowerCase() === order.rawApiData!.collateral.toLowerCase(),
              );
              const tokenUsd = token?.symbol.includes("USD")
                ? 1
                : token?.symbol.includes("ETH")
                  ? market.prices.ETH
                  : token?.symbol.includes("BTC")
                    ? market.prices.BTC
                    : Number.POSITIVE_INFINITY;
              return (Number(order.order.price) / 1e8) * contracts * tokenUsd;
            };
            const aFits = usd(a) <= maxPremiumUsd;
            const bFits = usd(b) <= maxPremiumUsd;
            if (aFits !== bFits) return aFits ? -1 : 1;
          }
          return Math.abs(sa - spot) - Math.abs(sb - spot) || Number(a.order.price - b.order.price);
        })[0]
    : undefined;

  let strike: number;
  let premiumPerContractToken: number;
  let premiumPerContractUsd: number;
  let tokenSymbol: string;
  let maxContracts: number | null;
  let filled: number;
  let iv: number | null;
  let maker: string | null;
  let greeks: NormalizedOrder["greeks"];
  let txs: TradeQuote["txs"] = null;
  const source: "book" | "mm" = bookBest ? "book" : "mm";

  if (bookBest) {
    const raw = bookBest.rawApiData!;
    strike = Number(raw.strikes[0]) / 1e8;
    const price = bookBest.order.price; // 8 decimals, in collateral-token units

    // Only fill against the chain-configured OptionBook (mirrors the SDK's
    // resolveOptionBookTarget safety check).
    const bookAddress = c.optionBook.contractAddress;
    if (raw.optionBookAddress && raw.optionBookAddress.toLowerCase() !== bookAddress.toLowerCase()) {
      throw new Error("order targets an unrecognized OptionBook contract");
    }

    const token = Object.values(c.chainConfig.tokens).find(
      (t) => t.address.toLowerCase() === raw.collateral.toLowerCase(),
    );
    if (!token) throw new Error("order uses an unrecognized collateral token");
    const knownImplementations = new Set(
      Object.values(c.chainConfig.implementations).map((address) => address.toLowerCase()),
    );
    if (!raw.implementation || !knownImplementations.has(raw.implementation.toLowerCase())) {
      throw new Error("order uses an unrecognized option implementation");
    }
    tokenSymbol = token.symbol;
    const tokenUsd = tokenSymbol.includes("USD")
      ? 1
      : tokenSymbol.includes("ETH")
        ? market.prices.ETH
        : tokenSymbol.includes("BTC")
          ? market.prices.BTC
          : 1;

    // The SDK owns size conversion, max-fill math, and the signed calldata.
    // The UI expresses a size in contracts, so translate it to the SDK's
    // 6-decimal spend input, then use its preview as the authoritative result.
    const requestedContracts6 = BigInt(Math.floor(Math.max(contracts, 0) * 1e6));
    const requestedSpend = (requestedContracts6 * price + 99_999_999n) / 100_000_000n;
    const preview = c.optionBook.previewFillOrder(bookBest, requestedSpend);
    premiumPerContractToken = Number(price) / 1e8;
    premiumPerContractUsd = premiumPerContractToken * tokenUsd;
    maxContracts = Number(preview.maxContracts) / 1e6;
    filled = Number(preview.numContracts) / 1e6;
    iv = raw.greeks?.iv ?? null;
    maker = bookBest.makerAddress;
    // The pricing API's greeks cover delta/gamma/theta/vega but not rho —
    // derive it via Black-Scholes at the same IV, same as lib/snapshot.ts.
    greeks = raw.greeks
      ? {
          ...raw.greeks,
          rho: bsRho(spot, strike, raw.greeks.iv, (targetTs - nowSec) / (365 * 86400), isCall),
        }
      : null;

    if (filled > 0) {
      const fill = c.optionBook.encodeFillOrder(bookBest, requestedSpend);
      // `previewFillOrder` is the authoritative amount this exact fill can
      // pull. Approve exactly that amount: an allowance must never exceed the
      // reviewed fill merely to provide rounding headroom.
      const approve = c.erc20.encodeApprove(preview.collateralToken, fill.to, preview.totalCollateral);
      if (fill.to.toLowerCase() !== bookAddress.toLowerCase()) {
        throw new Error("fill targets an unrecognized OptionBook contract");
      }
      if (preview.collateralToken.toLowerCase() !== token.address.toLowerCase() || approve.to.toLowerCase() !== token.address.toLowerCase()) {
        throw new Error("approval targets an unrecognized collateral token");
      }
      txs = { chainId: "0x2105", approve, fill };
    }
  } else {
    // MM ask for the ATM strike at this real grid tenor — no listed order to
    // fill; executing would go through the OptionFactory RFQ auction.
    const rows = sideRows.filter((r) => r.expiry === targetTs);
    if (!rows.length) throw new Error(`no ${asset} ${side} pricing at this expiry`);
    const atm = requestedStrike == null
      ? rows.reduce((best, r) =>
          Math.abs(r.strike - spot) < Math.abs(best.strike - spot) ? r : best,
        )
      : rows.find((r) => r.strike === requestedStrike);
    if (!atm) throw new Error("requested strike is no longer available on the live Thetanuts book");
    strike = atm.strike;
    premiumPerContractToken = atm.rawAskPrice; // in underlying units
    premiumPerContractUsd = atm.rawAskPrice * spot;
    tokenSymbol = asset;
    maxContracts = null;
    filled = Math.max(0, contracts);
    iv = null;
    maker = null;
    greeks = null;
  }

  // Greeks for the impact estimate: real ones when the order carries them,
  // Black-Scholes against the book's average IV otherwise.
  if (!greeks) {
    const fallbackIv = snapshot.assets[asset]?.avgIv ?? 0.5;
    greeks = bsGreeks(spot, strike, fallbackIv, (targetTs - nowSec) / (365 * 86400), isCall);
  }

  const totalCostToken = filled * premiumPerContractToken;
  const totalCostUsd = filled * premiumPerContractUsd;
  const breakEven = isCall ? strike + premiumPerContractUsd : strike - premiumPerContractUsd;

  // --- amplification impact of this fill ---
  let impact: TradeQuote["impact"] = null;
  if (filled > 0) {
    const before = snapshot.assets[asset];
    const hypothetical: NormalizedOrder = {
      asset,
      structure: isCall ? "CALL" : "PUT",
      isCall,
      takerIsLong: true, // buying → the dealer goes short gamma
      strike,
      strikes: [strike],
      expiryTs: targetTs,
      collateralUsd: filled * (isCall ? spot : strike),
      pricePerContractUsd: premiumPerContractUsd,
      maker: maker ?? "rfq",
      greeks,
    };
    const after = computeAssetSnapshot(
      asset,
      spot,
      [...getLastNormalizedOrders(), hypothetical],
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

  // --- per-contract risk ---
  // Depth and both quote sides come from the same normalized book the
  // snapshot uses. An RFQ/MM quote has no resting order behind it, so those
  // sub-scores drop out and say so rather than being modelled into existence.
  const contractOrders = getLastNormalizedOrders().filter(
    (o) =>
      o.asset === asset &&
      o.isCall === isCall &&
      o.strikes.length === 1 &&
      o.strike === strike &&
      o.expiryTs === targetTs,
  );
  let bidUsd: number | null = null;
  let askUsd: number | null = null;
  let depthUsd = 0;
  for (const o of contractOrders) {
    depthUsd += o.collateralUsd;
    const px = o.pricePerContractUsd;
    if (px === null || px <= 0) continue;
    if (o.takerIsLong) askUsd = askUsd === null ? px : Math.min(askUsd, px);
    else bidUsd = bidUsd === null ? px : Math.max(bidUsd, px);
  }
  const volContext = await getVolContext(asset).catch(() => null);
  const riskIv = greeks?.iv ?? iv;
  // Sized in the same collateral units as the resting depth it is compared
  // against — premium paid would be a different unit and a meaningless ratio.
  const fillNotionalUsd = filled * (isCall ? spot : strike);
  const risk = computeContractRisk({
    asset,
    spot,
    nowSec,
    expiryTs: targetTs,
    legs: [
      {
        isCall,
        action: "buy",
        strike,
        qty: filled,
        premiumUsd: premiumPerContractUsd,
        iv: riskIv,
        thetaUsd: greeks?.theta ?? null,
        vegaUsd: greeks?.vega ?? null,
        deltaPerContract: greeks?.delta ?? null,
      },
    ],
    marketScore: snapshot.assets[asset]?.score ?? null,
    baselineVol: volContext?.baselineVol ?? null,
    ivPercentile: volContext && riskIv ? percentileOf(volContext, riskIv) : null,
    liquidity: {
      bidUsd,
      askUsd,
      fairUsd:
        riskIv != null
          ? bsOptionPrice(spot, strike, riskIv, (targetTs - nowSec) / (365 * 86400), isCall)
          : null,
      contractDepthUsd: contractOrders.length ? depthUsd : null,
      tradeSizeUsd: fillNotionalUsd > 0 ? fillNotionalUsd : null,
    },
  });

  return {
    asset,
    side,
    spot,
    expiries,
    requestedPeriod: targetEntry.period,
    expiryTs: targetTs,
    strike,
    source,
    premiumToken: tokenSymbol,
    premiumPerContractToken,
    premiumPerContractUsd,
    contracts: filled,
    maxContracts,
    totalCostToken,
    totalCostUsd,
    breakEven,
    iv,
    maker,
    greeks,
    risk,
    impact,
    txs,
  };
}

/** Real strikes available to a long taker at one expiry, from the SDK book/MM grid. */
export async function getAvailableStrikes(
  asset: OptionsAsset,
  side: TradeSide,
  expiry: number,
): Promise<number[]> {
  const c = getClient();
  const [orders, pricing] = await Promise.all([getBookOrders(c), getMmPricing(c, asset)]);
  const feed = c.chainConfig.priceFeeds[asset]?.toLowerCase();
  const nowSec = Math.floor(Date.now() / 1000);
  const isCall = side === "call";
  const strikes = new Set<number>();
  for (const row of pricing) {
    if (row.isCall === isCall && row.expiry === expiry && row.expiry > nowSec) strikes.add(row.strike);
  }
  for (const order of orders) {
    const raw = order.rawApiData;
    if (
      raw &&
      !raw.isLong &&
      raw.isCall === isCall &&
      raw.strikes?.length === 1 &&
      raw.priceFeed?.toLowerCase() === feed &&
      Number(order.order.expiry) === expiry &&
      raw.orderExpiryTimestamp > nowSec &&
      order.availableAmount > 0n
    ) {
      strikes.add(Number(raw.strikes[0]) / 1e8);
    }
  }
  return [...strikes].sort((a, b) => a - b);
}

/** Finds one real expiry with pricing for both sides, nearest to the requested standard tenor. */
export async function resolveSharedExpiry(asset: OptionsAsset, period: TradePeriod): Promise<number | null> {
  const c = getClient();
  const pricing = await getMmPricing(c, asset);
  const nowSec = Math.floor(Date.now() / 1000);
  const calls = new Set(pricing.filter((row) => row.isCall && row.expiry > nowSec).map((row) => row.expiry));
  const puts = new Set(pricing.filter((row) => !row.isCall && row.expiry > nowSec).map((row) => row.expiry));
  const shared = [...calls].filter((expiry) => puts.has(expiry));
  if (!shared.length) return null;
  return shared.reduce((best, expiry) =>
    Math.abs((expiry - nowSec) / 86400 - period) < Math.abs((best - nowSec) / 86400 - period)
      ? expiry
      : best,
  );
}
