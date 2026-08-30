// Multi-leg quote resolution for the Hegic-style strategy builder. Resolves
// every leg of a lib/strategy.ts StrategyDef against the real book/MM grid at
// one shared expiry, prices each leg via lib/trade.ts's existing single-leg
// quoting (so book-vs-MM sourcing, greeks, and Black-Scholes fallbacks are
// exactly the same as the single-option flow), then aggregates net premium,
// payoff (lib/strategyPayoff.ts), and market-structure impact.

import { getStrategy } from "./strategy";
import { getAvailableStrikes, getTradeQuote, resolveSharedExpiry, type TradeSide } from "./trade";
import { getMarketSnapshot, getLastNormalizedOrders } from "./snapshot";
import { computeAssetSnapshot, type NormalizedOrder } from "./engine";
import { analyzePayoff, type ResolvedLeg } from "./strategyPayoff";
import { isOptionsAsset, type OptionsAsset } from "./assets";
import type { TradePeriod } from "./tradePeriods";

export type StrategyQuoteLeg = {
  side: TradeSide;
  action: "buy" | "sell";
  qty: number;
  strike: number;
  premiumPerContractUsd: number;
  premiumPerContractToken: number;
  premiumToken: string;
  source: "book" | "mm";
  /** Max fillable size for this leg alone (book fills only) — null = MM estimate, no book depth cap. */
  maxContracts: number | null;
};

export type StrategyQuote = {
  asset: OptionsAsset;
  strategyId: string;
  strategyName: string;
  executable: boolean;
  spot: number;
  expiryTs: number;
  contracts: number;
  legs: StrategyQuoteLeg[];
  /** Positive = net debit (cost to open); negative = net credit (received to open). */
  netPremiumUsd: number;
  maxProfit: number | "unlimited";
  maxLoss: number | "unlimited";
  breakevens: number[];
  impact: {
    scoreBefore: number;
    scoreAfter: number;
    netGexBefore: number;
    netGexAfter: number;
    regimeBefore: string;
    regimeAfter: string;
  } | null;
};

export async function resolveStrategyQuote(
  asset: OptionsAsset,
  strategyId: string,
  contracts: number,
  period: TradePeriod,
): Promise<StrategyQuote> {
  if (!isOptionsAsset(asset)) throw new Error(`${asset} has no live Thetanuts market to trade`);
  const def = getStrategy(strategyId);
  if (!def) throw new Error(`unknown strategy "${strategyId}"`);
  if (!(contracts > 0)) throw new Error("contracts must be positive");

  const expiryTs = await resolveSharedExpiry(asset, period);
  if (expiryTs == null) throw new Error(`no ${asset} expiries available at any period`);

  const sides = [...new Set(def.legs.map((l) => l.side))];
  const grids = new Map<TradeSide, number[]>();
  for (const side of sides) grids.set(side, await getAvailableStrikes(asset, side, expiryTs));

  const snapshot = await getMarketSnapshot();
  const spot = snapshot.prices[asset];
  if (!Number.isFinite(spot) || spot <= 0) throw new Error(`no live ${asset} spot price`);

  const atmIndex = new Map<TradeSide, number>();
  for (const [side, grid] of grids) {
    if (!grid.length) continue;
    let best = 0;
    for (let i = 1; i < grid.length; i++) {
      if (Math.abs(grid[i] - spot) < Math.abs(grid[best] - spot)) best = i;
    }
    atmIndex.set(side, best);
  }

  const legs: StrategyQuoteLeg[] = [];
  const resolvedLegs: ResolvedLeg[] = [];
  const hypotheticals: NormalizedOrder[] = [];
  let netPremiumPerUnitUsd = 0;

  for (const leg of def.legs) {
    const grid = grids.get(leg.side) ?? [];
    const idx = (atmIndex.get(leg.side) ?? 0) + leg.strikeOffset;
    if (!grid.length || idx < 0 || idx >= grid.length) {
      throw new Error(`not enough listed ${leg.side} strikes for ${def.name} at this expiry`);
    }
    const strike = grid[idx];
    const legContracts = contracts * leg.qty;
    const quote = await getTradeQuote(asset, leg.side, legContracts, period, strike, expiryTs);

    legs.push({
      side: leg.side,
      action: leg.action,
      qty: leg.qty,
      strike,
      premiumPerContractUsd: quote.premiumPerContractUsd,
      premiumPerContractToken: quote.premiumPerContractToken,
      premiumToken: quote.premiumToken,
      source: quote.source,
      maxContracts: quote.maxContracts,
    });
    resolvedLegs.push({ side: leg.side, action: leg.action, strike, qty: leg.qty });
    netPremiumPerUnitUsd += (leg.action === "buy" ? 1 : -1) * leg.qty * quote.premiumPerContractUsd;

    if (quote.greeks) {
      const filled = Math.min(legContracts, quote.maxContracts ?? legContracts);
      hypotheticals.push({
        asset,
        structure: `${leg.side.toUpperCase()} LEG`,
        isCall: leg.side === "call",
        takerIsLong: leg.action === "buy",
        strike,
        strikes: [strike],
        expiryTs,
        collateralUsd: filled * (leg.side === "call" ? spot : strike),
        pricePerContractUsd: quote.premiumPerContractUsd,
        maker: quote.maker ?? "rfq",
        greeks: quote.greeks,
      });
    }
  }

  const perUnit = analyzePayoff(resolvedLegs, netPremiumPerUnitUsd);
  const scale = (v: number | "unlimited") => (v === "unlimited" ? "unlimited" : v * contracts);

  let impact: StrategyQuote["impact"] = null;
  if (hypotheticals.length) {
    const nowSec = Math.floor(Date.now() / 1000);
    const before = snapshot.assets[asset];
    const after = computeAssetSnapshot(asset, spot, [...getLastNormalizedOrders(), ...hypotheticals], nowSec);
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
    strategyId: def.id,
    strategyName: def.name,
    executable: def.executable,
    spot,
    expiryTs,
    contracts,
    legs,
    netPremiumUsd: netPremiumPerUnitUsd * contracts,
    maxProfit: scale(perUnit.maxProfit),
    maxLoss: scale(perUnit.maxLoss),
    breakevens: perUnit.breakevens,
    impact,
  };
}
