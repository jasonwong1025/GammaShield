import type { Asset } from "./assets";

export type PutCandidate = {
  strike: number;
  expiryTs: number;
  daysToExpiry: number;
  pricePerContractUsd: number;
  maker: string;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  /** Distance from current spot price (percentage OTM/ITM) */
  otmPct: number;
  /** Distance from the Gamma Flip level */
  flipDistancePct: number;
  /** Estimated tail-risk downside coverage (0 - 100%) */
  protectionCoveragePct: number;
  /** Estimated cost for ~1-2 USDC baseline protection */
  estCostUsdc: number;
  /** Cost-to-Protection Efficiency Ratio (higher = better protection per dollar) */
  efficiencyScore: number;
  isOptimal: boolean;
};

export type OptimalHedgeRecommendation = {
  asset: Asset;
  spotPrice: number;
  flipStrike: number | null;
  marketRegime: "dampening" | "amplifying" | "neutral";
  fragilityScore: number;
  optimalContract: PutCandidate | null;
  rankedCandidates: PutCandidate[];
  quantitativeRationale: string;
  generatedAt: number;
};
