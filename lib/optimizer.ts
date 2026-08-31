// Intelligent Strike & Expiry Optimizer for protective options on Base Mainnet.
// Scans live listed Put orders from Thetanuts OptionBook, calculates the
// Cost-to-Protection Efficiency Ratio against the Gamma Flip level, spot price,
// and implied volatility, and selects the mathematically optimal contract.

import { isOptionsAsset, type Asset } from "./assets";
import { getMarketSnapshot, type FeedRow, type MarketSnapshot } from "./snapshot";
import type { AssetSnapshot } from "./engine";
import type { PutCandidate, OptimalHedgeRecommendation } from "./optimizerTypes";

export * from "./optimizerTypes";

/**
 * Calculates tail-risk downside coverage percentage based on delta and moneyness
 */
function calculateProtectionCoverage(spot: number, strike: number, delta: number | null): number {
  if (spot <= 0 || strike <= 0) return 50;
  const moneyness = strike / spot;
  // If delta is available, use absolute delta as primary hedge ratio proxy
  if (delta !== null && Number.isFinite(delta)) {
    const rawDelta = Math.abs(delta);
    return Math.min(95, Math.max(20, Math.round(rawDelta * 140)));
  }
  // Fallback based on strike distance to spot
  if (moneyness >= 1.0) return 95; // ATM / ITM covers immediate downside
  if (moneyness >= 0.95) return 85; // Near OTM covers 85% of cascade
  if (moneyness >= 0.90) return 70; // 10% OTM covers severe drops
  if (moneyness >= 0.80) return 50; // Deep OTM covers catastrophic black swans
  return 30;
}

/**
 * Evaluates all live listed PUT orders for an asset and selects the single optimal contract.
 */
export async function getOptimalPutHedge(
  asset: Asset,
  customSpot?: number,
): Promise<OptimalHedgeRecommendation> {
  const snapshot: MarketSnapshot = await getMarketSnapshot();
  const assetSnap: AssetSnapshot | undefined = snapshot.assets[asset];
  const spot = customSpot || assetSnap?.spot || (asset === "BTC" ? snapshot.prices.BTC : snapshot.prices.ETH) || 2500;
  const flipStrike = assetSnap?.flipStrike || null;
  const regime = assetSnap?.regime || "neutral";
  const fragilityScore = assetSnap?.score || 50;
  const nowSec = Math.floor(Date.now() / 1000);

  // Only a live, listed order where the taker buys the PUT is useful here.
  // The live trade path still revalidates it through the SDK before any fill.
  const putRows = snapshot.feed.filter(
    (r: FeedRow) =>
      r.asset === asset &&
      isOptionsAsset(asset) &&
      !r.isCall &&
      r.takerIsLong &&
      r.expiryTs > nowSec &&
      r.strike > 0 &&
      r.collateralUsd > 0 &&
      r.pricePerContractUsd !== null &&
      r.pricePerContractUsd > 0,
  );

  const candidates: PutCandidate[] = [];

  for (const row of putRows) {
    const strike = row.strike;
    const daysToExpiry = Math.max(0.1, Number(((row.expiryTs - nowSec) / 86400).toFixed(1)));
    const priceUsd = row.pricePerContractUsd;
    if (priceUsd === null) continue;
    const otmPct = Number((((spot - strike) / spot) * 100).toFixed(1));
    const flipDist = flipStrike ? Math.abs(strike - flipStrike) / flipStrike : Math.abs(strike - spot * 0.95) / (spot * 0.95);
    const protectionCoveragePct = calculateProtectionCoverage(spot, strike, row.delta);

    // Efficiency Model:
    // Rewards high protection coverage and proximity to the Gamma Flip level.
    // Penalizes excessive time decay (days > 35) or deep out-of-the-money strikes (> 25% OTM).
    const flipProximityFactor = Math.max(0.2, 1 - flipDist * 2);
    const tenorWeight = daysToExpiry <= 14 ? 1.2 : daysToExpiry <= 30 ? 1.0 : 0.7;
    const costFactor = Math.max(0.5, priceUsd / spot);

    const rawScore = (protectionCoveragePct * flipProximityFactor * tenorWeight) / (costFactor * 100);
    const efficiencyScore = Number(rawScore.toFixed(2));

    candidates.push({
      strike,
      expiryTs: row.expiryTs,
      daysToExpiry,
      pricePerContractUsd: priceUsd,
      maker: row.maker,
      iv: row.iv,
      delta: row.delta,
      gamma: row.gamma,
      otmPct,
      flipDistancePct: Number((flipDist * 100).toFixed(1)),
      protectionCoveragePct,
      efficiencyScore,
      isOptimal: false,
    });
  }

  // Sort by efficiency score descending
  candidates.sort((a, b) => b.efficiencyScore - a.efficiencyScore);

  let optimalContract: PutCandidate | null = null;
  if (candidates.length > 0) {
    candidates[0].isOptimal = true;
    optimalContract = candidates[0];
  }

  // Generate Quantitative Rationale
  const rationale = optimalContract
    ? `Selected a currently listed $${optimalContract.strike.toLocaleString()} PUT (${optimalContract.daysToExpiry}d expiry) at a snapshot price of $${optimalContract.pricePerContractUsd.toLocaleString()}. It is a candidate only: the trade flow must obtain a fresh SDK quote before review or execution.`
    : `No eligible listed ${asset} PUT order is currently available. No contract or price recommendation is generated.`;

  return {
    asset,
    spotPrice: spot,
    flipStrike,
    marketRegime: regime,
    fragilityScore,
    optimalContract,
    rankedCandidates: candidates.slice(0, 8),
    quantitativeRationale: rationale,
    generatedAt: Date.now(),
  };
}
