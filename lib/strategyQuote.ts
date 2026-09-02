import { isOptionsAsset, type OptionsAsset } from "./assets";
import { getStrategy } from "./strategy";
import { getAvailableStrikes, getTradeQuote, resolveSharedExpiry, type TradeSide } from "./trade";
import type { TradePeriod } from "./tradePeriods";
import { analyzePayoff, type ResolvedLeg } from "./strategyPayoff";

export type StrategyQuoteLeg = {
  side: TradeSide;
  action: "buy" | "sell";
  qty: number;
  strike: number;
  source: "book" | "mm" | null;
  premiumPerContractUsd: number | null;
};

export type StrategyQuote = {
  strategyId: string;
  strategyName: string;
  spot: number;
  expiryTs: number;
  contracts: number;
  legs: StrategyQuoteLeg[];
  /** Null when a short leg has no reliable taker-side price in the live book. */
  netPremiumUsd: number | null;
  maxProfit: number | "unlimited" | null;
  maxLoss: number | "unlimited" | null;
  breakevens: number[];
};

export async function resolveStrategyQuote(
  asset: OptionsAsset,
  strategyId: string,
  contracts: number,
  period: TradePeriod,
): Promise<StrategyQuote> {
  if (!isOptionsAsset(asset)) throw new Error(`${asset} has no live Thetanuts market to trade`);
  if (!(contracts > 0)) throw new Error("contracts must be positive");
  const strategy = getStrategy(strategyId);
  if (!strategy) throw new Error("unknown strategy");
  const expiryTs = await resolveSharedExpiry(asset, period);
  if (expiryTs == null) throw new Error(`no shared ${asset} call/put expiry is available`);

  const sides = [...new Set(strategy.legs.map((leg) => leg.side))];
  const grids = new Map<TradeSide, number[]>();
  for (const side of sides) grids.set(side, await getAvailableStrikes(asset, side, expiryTs));

  const spotQuote = await getTradeQuote(asset, strategy.legs[0].side, 0, period, { expiry: expiryTs });
  const spot = spotQuote.spot;
  const atms = new Map<TradeSide, number>();
  for (const [side, grid] of grids) {
    const index = grid.reduce((best, strike, current) =>
      Math.abs(strike - spot) < Math.abs(grid[best] - spot) ? current : best,
    0);
    atms.set(side, index);
  }

  const resolved: ResolvedLeg[] = [];
  const legs: StrategyQuoteLeg[] = [];
  let netPremiumPerUnit = 0;
  let fullyPriced = true;
  for (const leg of strategy.legs) {
    const grid = grids.get(leg.side) ?? [];
    const index = (atms.get(leg.side) ?? 0) + leg.strikeOffset;
    if (index < 0 || index >= grid.length) throw new Error(`not enough live ${leg.side} strikes for ${strategy.name}`);
    const strike = grid[index];
    resolved.push({ ...leg, strike });
    if (leg.action === "sell") {
      fullyPriced = false;
      legs.push({ ...leg, strike, source: null, premiumPerContractUsd: null });
      continue;
    }
    const quote = await getTradeQuote(asset, leg.side, contracts * leg.qty, period, { strike, expiry: expiryTs });
    legs.push({ ...leg, strike, source: quote.source, premiumPerContractUsd: quote.premiumPerContractUsd });
    netPremiumPerUnit += leg.qty * quote.premiumPerContractUsd;
  }

  const payoff = fullyPriced ? analyzePayoff(resolved, netPremiumPerUnit) : null;
  const scale = (value: number | "unlimited") => value === "unlimited" ? value : value * contracts;
  return {
    strategyId: strategy.id,
    strategyName: strategy.name,
    spot,
    expiryTs,
    contracts,
    legs,
    netPremiumUsd: fullyPriced ? netPremiumPerUnit * contracts : null,
    maxProfit: payoff ? scale(payoff.maxProfit) : null,
    maxLoss: payoff ? scale(payoff.maxLoss) : null,
    breakevens: payoff?.breakevens ?? [],
  };
}
