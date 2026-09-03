// Server-side view of real, open OptionBook positions from the Thetanuts indexer.

import { buildTicker, type Position } from "@thetanuts-finance/thetanuts-client";
import { type OptionsAsset } from "./assets";
import { getClient } from "./snapshot";

export type ThetanutsPosition = {
  id: string;
  asset: OptionsAsset;
  isCall: boolean;
  strike: number;
  expiryTs: number;
  contracts: number;
  status: string;
  entryTxHash: string | null;
  pnlUsd: number | null;
};

function assetFor(underlying: string): OptionsAsset | null {
  const value = underlying.toUpperCase();
  return value.includes("BTC") ? "BTC" : value.includes("ETH") ? "ETH" : null;
}

function usd8(value: string | null | undefined): number | null {
  if (!value || !/^-?\d+$/.test(value)) return null;
  const amount = Number(BigInt(value)) / 1e8;
  return Number.isFinite(amount) ? amount : null;
}

function normalize(position: Position): ThetanutsPosition | null {
  const asset = assetFor(position.option.underlying);
  const strike = position.option.strikes[0];
  if (!asset || strike == null) return null;

  return {
    id: position.id,
    asset,
    // The OptionBook indexer exposes the implementation name (for example,
    // LINEAR_CALL) as the authoritative product label. Its raw option-type
    // value is not limited to the legacy CALL=0 / PUT=1 enum.
    isCall: position.implementationName
      ? position.implementationName.includes("CALL")
      : position.option.optionType === 0,
    strike: Number(strike) / 1e8,
    expiryTs: position.option.expiry,
    contracts: Number(position.amount) / 1e6,
    status: position.status || "open",
    entryTxHash: position.entryTxHash || null,
    pnlUsd: usd8(position.pnlUsd),
  };
}

/** What a market maker would pay and charge for a position, per contract. */
export type PositionMark = { bidUsd: number | null; askUsd: number | null; markUsd: number | null };

/**
 * Live market-maker quote for a position the user already holds, in USD per
 * contract.
 *
 * Worth being precise about what this is and is not: it is a real, current
 * bid, and on Base mainnet there is no mechanism to hit it. `BaseOption.close()`
 * is bilateral, the OptionBook has no maker-order creation for end users, and
 * RFQ mints new options rather than buying back existing ones. So this prices
 * a recommendation, not an executable exit.
 *
 * Two SDK traps are deliberately avoided here, both found by calling it:
 *
 *   1. `mmPricing.getPositionPricing` is unusable for BTC. It scales the
 *      strike by 1e12 through `floatToBigInt`, and 78500e12 exceeds
 *      Number.MAX_SAFE_INTEGER, so it throws for any BTC-scale strike. It also
 *      requires an integer `numContracts`, which our fractional sizes are not.
 *      `getTickerPricing` returns the identical bid/ask with neither problem —
 *      verified equal on ETH, where both calls succeed.
 *   2. Raw MM prices are FRACTIONS OF THE UNDERLYING, not USD. The SDK's own
 *      `premiumPerContract` documents the rule: for quote (USDC) collateral,
 *      multiply by spot. Returning them unconverted understates the position
 *      by roughly five orders of magnitude.
 *
 * Returns nulls rather than throwing: an unpriceable position must read as
 * unpriced, never as worthless.
 */
export async function getPositionMark(position: ThetanutsPosition): Promise<PositionMark> {
  const empty: PositionMark = { bidUsd: null, askUsd: null, markUsd: null };
  try {
    const ticker = buildTicker(position.asset, position.expiryTs, position.strike, position.isCall);
    const pricing = await getClient().mmPricing.getTickerPricing(ticker);
    const spot = pricing.underlyingPrice;
    if (!(spot > 0)) return empty;

    // These policies collateralise in USDC, so the quote-collateral entry is
    // the one that prices our exit. Its `collateralAmount` is the strike in
    // USD, which is how it identifies itself as the quote side.
    const byCollateral = Object.values(pricing.byCollateral ?? {});
    const quote = byCollateral.find((entry) => entry.collateralAsset?.toUpperCase().includes("USD")) ?? byCollateral[0];
    const usd = (value: number | undefined) => {
      const fraction = positive(value);
      return fraction === null ? null : fraction * spot;
    };
    return { bidUsd: usd(quote?.mmBidPrice), askUsd: usd(quote?.mmAskPrice), markUsd: usd(pricing.markPrice) };
  } catch {
    return empty;
  }
}

const positive = (value: number | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

export async function getThetanutsPositions(address: string): Promise<ThetanutsPosition[]> {
  const positions = await getClient().api.getUserPositionsFromIndexer(address);
  return positions.flatMap((position) => {
    const normalized = normalize(position);
    return normalized ? [normalized] : [];
  });
}
