// Server-side trade quoting.
// The duration axis comes from the MM pricing grid (client.mmPricing) — every
// expiry market makers currently price (~13 tenors from <1d to ~300d), far
// finer than the listed book. For the chosen expiry we quote the ATM strike:
//   • if a listed maker order exists there ("fillable"), the quote is that
//     order's real price and we prepare approve + fill calldata — instant fill;
//   • otherwise the quote is the MM ask (an executable-size estimate; filling
//     it would go through the OptionFactory RFQ auction, not built yet).
// Longer duration ⇒ more time value ⇒ higher premium, straight from live data.
// The SDK stays read-only here: only the user's browser wallet ever signs.

import { OPTION_BOOK_ABI, type ThetanutsClient } from "@thetanuts-finance/thetanuts-client";
import { ethers } from "ethers";
import { getClient, getMarketSnapshot, getLastNormalizedOrders } from "./snapshot";
import { computeAssetSnapshot, type NormalizedOrder } from "./engine";
import { bsGreeks } from "./modelBook";
import { isOptionsAsset, type Asset, type OptionsAsset } from "./assets";

type SdkOrder = Awaited<ReturnType<ThetanutsClient["api"]["fetchOrders"]>>[number];
type MmRow = Awaited<ReturnType<ThetanutsClient["mmPricing"]["getPricingArray"]>>[number];

export type TradeSide = "call" | "put";

export type TradeQuote = {
  asset: Asset;
  side: TradeSide;
  spot: number;
  /** MM-priced expiries for this side, soonest first. `fillable` = listed maker order exists. */
  expiries: { ts: number; days: number; fillable: boolean }[];
  /** Echo of the (clamped, whole-day) duration this quote answers. */
  requestedDays: number;
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
// mis-scales physically-settled calls with <18-decimal collateral (cbBTC), so
// compute it directly: calls are collateralized in the underlying (1 contract
// locks 1 unit), puts in stables (1 contract locks `strike`).
function maxContracts6(order: SdkOrder, tokenDecimals: number): bigint {
  const raw = order.rawApiData!;
  if (raw.isCall) {
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
  days: number,
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
  const buyable = orders.filter((o) => {
    const raw = o.rawApiData;
    return (
      raw &&
      raw.isLong &&
      raw.isCall === isCall &&
      raw.strikes?.length === 1 &&
      raw.priceFeed?.toLowerCase() === feed &&
      Number(o.order.expiry) > nowSec &&
      raw.orderExpiryTimestamp > nowSec &&
      o.availableAmount > 0n
    );
  });
  const fillableTs = new Set(buyable.map((o) => Number(o.order.expiry)));

  // Duration axis: every MM-priced expiry with rows for this side.
  const sideRows = pricing.filter((r) => r.isCall === isCall && r.expiry > nowSec);
  if (!sideRows.length && !buyable.length) {
    throw new Error(`no live ${asset} ${side} pricing right now`);
  }
  const gridTs = [...new Set([...sideRows.map((r) => r.expiry), ...fillableTs])].sort(
    (a, b) => a - b,
  );
  // Tradable window: 1–90 days (a stop within a day past 90 still counts).
  const expiries = gridTs
    .map((ts) => ({
      ts,
      days: (ts - nowSec) / 86400,
      fillable: fillableTs.has(ts),
    }))
    .filter((e) => e.days >= 1 && e.days <= 91);
  if (!expiries.length) throw new Error(`no ${asset} ${side} expiries inside 1–90 days`);

  // Any whole day 1–90 is selectable. A listed book expiry within half a day
  // of the request becomes an instant fill; anything else is an MM estimate
  // (interpolated between the surrounding MM tenors — executing there would
  // go through the OptionFactory RFQ auction, which prices any expiry).
  const reqDays = Math.min(90, Math.max(1, Math.round(days)));
  const bookMatch =
    [...fillableTs]
      .filter((ts) => {
        const d = (ts - nowSec) / 86400;
        return d >= 0.5 && d <= 91;
      })
      .sort(
        (a, b) =>
          Math.abs((a - nowSec) / 86400 - reqDays) - Math.abs((b - nowSec) / 86400 - reqDays),
      )
      .find((ts) => Math.abs((ts - nowSec) / 86400 - reqDays) <= 0.55) ?? null;
  const targetTs = bookMatch ?? nowSec + reqDays * 86400;

  // Best listed maker order at the matched expiry: ATM first, cheaper on ties.
  const bookBest = bookMatch
    ? buyable
        .filter((o) => Number(o.order.expiry) === bookMatch)
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
    const max6 = maxContracts6(bookBest, tokenDecimals);
    maxContracts = Number(max6) / 1e6;
    filled = Math.max(0, Math.min(contracts, maxContracts));
    iv = raw.greeks?.iv ?? null;
    maker = bookBest.makerAddress;
    greeks = raw.greeks ?? null;

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
    // MM ask for the ATM strike, linearly interpolated in time between the
    // two surrounding MM tenors — an estimate; no listed order to fill.
    if (!sideRows.length) throw new Error(`no ${asset} ${side} pricing right now`);
    const tenors = [...new Set(sideRows.map((r) => r.expiry))].sort((a, b) => a - b);
    const atmAt = (ts: number) => {
      const rows = sideRows.filter((r) => r.expiry === ts);
      return rows.reduce((best, r) =>
        Math.abs(r.strike - spot) < Math.abs(best.strike - spot) ? r : best,
      );
    };
    const lower = [...tenors].reverse().find((t) => t <= targetTs);
    const upper = tenors.find((t) => t >= targetTs);
    let askUnderlying: number;
    if (lower != null && upper != null && upper !== lower) {
      const lo = atmAt(lower);
      const hi = atmAt(upper);
      const w = (targetTs - lower) / (upper - lower);
      askUnderlying = lo.rawAskPrice * (1 - w) + hi.rawAskPrice * w;
      strike = (w < 0.5 ? lo : hi).strike;
    } else {
      const atm = atmAt((lower ?? upper)!);
      askUnderlying = atm.rawAskPrice;
      strike = atm.strike;
    }
    premiumPerContractToken = askUnderlying; // in underlying units
    premiumPerContractUsd = askUnderlying * spot;
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
    requestedDays: reqDays,
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
    impact,
    txs,
  };
}
