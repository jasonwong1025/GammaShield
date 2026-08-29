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

import { OPTION_BOOK_ABI, type ThetanutsClient } from "@thetanuts-finance/thetanuts-client";
import { ethers } from "ethers";
import { getClient, getMarketSnapshot, getLastNormalizedOrders } from "./snapshot";
import { computeAssetSnapshot, type NormalizedOrder } from "./engine";
import { bsGreeks, bsRho } from "./modelBook";
import { isOptionsAsset, type Asset, type OptionsAsset } from "./assets";
import { TRADE_PERIODS, type TradePeriod } from "./tradePeriods";

export { TRADE_PERIODS, type TradePeriod } from "./tradePeriods";

type SdkOrder = Awaited<ReturnType<ThetanutsClient["api"]["fetchOrders"]>>[number];
type MmRow = Awaited<ReturnType<ThetanutsClient["mmPricing"]["getPricingArray"]>>[number];

export type TradeSide = "call" | "put";

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

async function getBookOrders(c: ThetanutsClient): Promise<SdkOrder[]> {
  if (ordersCache && Date.now() - ordersCache.at < ORDERS_CACHE_MS) return ordersCache.orders;
  const orders = await c.api.fetchOrders();
  ordersCache = { at: Date.now(), orders };
  return orders;
}

async function getMmPricing(c: ThetanutsClient, asset: OptionsAsset): Promise<MmRow[]> {
  const cached = pricingCache.get(asset);
  if (cached && Date.now() - cached.at < PRICING_CACHE_MS) return cached.rows;
  const rows = await c.mmPricing.getPricingArray(asset);
  pricingCache.set(asset, { at: Date.now(), rows });
  return rows;
}

// Max fillable contracts in 6-decimal units. The SDK's calculateMaxContracts
// mis-scales calls with <18-decimal underlying collateral (cbBTC), so compute
// it directly: underlying-collateralized (inverse/physical) calls lock 1 unit
// per contract; USD-collateralized legs (puts, linear calls) lock `strike`.
function maxContracts6(order: SdkOrder, tokenDecimals: number, tokenSymbol: string): bigint {
  const raw = order.rawApiData!;
  if (raw.isCall && !tokenSymbol.includes("USD")) {
    const shift = tokenDecimals - 6;
    return shift >= 0
      ? order.availableAmount / 10n ** BigInt(shift)
      : order.availableAmount * 10n ** BigInt(-shift);
  }
  return (order.availableAmount * 100_000_000n) / BigInt(raw.strikes[0]);
}

// Encode fillOrder calldata ourselves (same field mapping as the SDK's
// buildContractOrder — the maker's signature covers the order fields, which we
// pass through untouched; only numContracts is taker-chosen).
function encodeFill(order: SdkOrder, numContracts: bigint, to: string) {
  const raw = order.rawApiData!;
  const contractOrder = {
    maker: order.order.maker,
    orderExpiryTimestamp: BigInt(raw.orderExpiryTimestamp),
    collateral: raw.collateral,
    isCall: raw.isCall,
    priceFeed: raw.priceFeed,
    implementation: raw.implementation,
    isLong: raw.isLong,
    maxCollateralUsable: BigInt(raw.maxCollateralUsable),
    strikes: raw.strikes.map((s) => BigInt(s)),
    expiry: order.order.expiry,
    price: order.order.price,
    numContracts,
    extraOptionData: raw.extraOptionData || "0x",
  };
  const iface = new ethers.Interface(OPTION_BOOK_ABI);
  return {
    to,
    data: iface.encodeFunctionData("fillOrder", [contractOrder, order.signature, ethers.ZeroAddress]),
  };
}

export async function getTradeQuote(
  asset: Asset,
  side: TradeSide,
  contracts: number,
  period: TradePeriod,
): Promise<TradeQuote> {
  if (!isOptionsAsset(asset)) {
    throw new Error(`${asset} has no live Thetanuts market to trade`);
  }

  const c = getClient();
  const [orders, market, snapshot, pricing] = await Promise.all([
    getBookOrders(c),
    c.api.getMarketData(),
    getMarketSnapshot(), // keeps getLastNormalizedOrders() fresh for impact math
    getMmPricing(c, asset),
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

  // Duration axis: the SDK's own tenor grid, not an arbitrary day count. MM
  // pricing only exists at fixed, Friday-anchored expiries (today's "weekly"
  // reads as however many days remain until that Friday, not exactly 7) —
  // there is nothing to interpolate between them for a day that isn't listed.
  const sideRows = pricing.filter((r) => r.isCall === isCall && r.expiry > nowSec);
  if (!sideRows.length && !buyable.length) {
    throw new Error(`no live ${asset} ${side} pricing right now`);
  }
  const mmTenors = [...new Set(sideRows.map((r) => r.expiry))];
  // For each standard period, resolve the real grid tenor nearest to it —
  // preferring the MM grid, falling back to a listed book expiry if the MM
  // hasn't quoted anything yet.
  const nearestTenor = (targetDays: number): number | null => {
    const candidates = mmTenors.length ? mmTenors : [...fillableTs];
    if (!candidates.length) return null;
    return candidates.reduce((best, ts) =>
      Math.abs((ts - nowSec) / 86400 - targetDays) < Math.abs((best - nowSec) / 86400 - targetDays)
        ? ts
        : best,
    );
  };
  const expiries = TRADE_PERIODS.map((p) => {
    const ts = nearestTenor(p);
    return ts == null ? null : { period: p, ts, days: (ts - nowSec) / 86400, fillable: fillableTs.has(ts) };
  }).filter((e): e is NonNullable<typeof e> => e != null);
  if (!expiries.length) throw new Error(`no ${asset} ${side} expiries available`);

  const targetEntry = expiries.find((e) => e.period === period) ?? expiries[0];
  const targetTs = targetEntry.ts;

  // Best listed maker order at the matched expiry: ATM first, cheaper on ties.
  const bookBest = targetEntry.fillable
    ? buyable
        .filter((o) => Number(o.order.expiry) === targetTs)
        .sort((a, b) => {
          const sa = Number(a.rawApiData!.strikes[0]) / 1e8;
          const sb = Number(b.rawApiData!.strikes[0]) / 1e8;
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
    tokenSymbol = token?.symbol ?? "?";
    const tokenDecimals = token?.decimals ?? 6;
    const tokenUsd = tokenSymbol.includes("USD")
      ? 1
      : tokenSymbol.includes("ETH")
        ? market.prices.ETH
        : tokenSymbol.includes("BTC")
          ? market.prices.BTC
          : 1;

    premiumPerContractToken = Number(price) / 1e8;
    premiumPerContractUsd = premiumPerContractToken * tokenUsd;
    const max6 = maxContracts6(bookBest, tokenDecimals, tokenSymbol);
    maxContracts = Number(max6) / 1e6;
    filled = Math.max(0, Math.min(contracts, maxContracts));
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
      const contracts6 = BigInt(Math.round(filled * 1e6));
      const fill = encodeFill(bookBest, contracts6, bookAddress);
      // Premium the contract pulls: contracts × price, in 6-decimal token
      // units; approve in native decimals with +1% headroom for rounding.
      const premium6 = (contracts6 * price + 99_999_999n) / 100_000_000n; // ceil
      const nativeAmount =
        (premium6 * 10n ** BigInt(Math.max(tokenDecimals - 6, 0)) * 101n) / 100n;
      const approve = c.erc20.encodeApprove(raw.collateral, fill.to, nativeAmount);
      txs = { chainId: "0x2105", approve, fill };
    }
  } else {
    // MM ask for the ATM strike at this real grid tenor — no listed order to
    // fill; executing would go through the OptionFactory RFQ auction.
    const rows = sideRows.filter((r) => r.expiry === targetTs);
    if (!rows.length) throw new Error(`no ${asset} ${side} pricing at this expiry`);
    const atm = rows.reduce((best, r) =>
      Math.abs(r.strike - spot) < Math.abs(best.strike - spot) ? r : best,
    );
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
    impact,
    txs,
  };
}
