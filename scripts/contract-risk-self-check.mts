import assert from "node:assert/strict";
import {
  computeContractRisk,
  expiryMultiplier,
  levelOf,
  payoffAtExpiry,
  type RiskLeg,
} from "../lib/contractRisk.ts";
import { __internals, percentileOf } from "../lib/realizedVol.ts";

const NOW = 1_700_000_000;
const DAYS = (d: number) => NOW + d * 86400;

const leg = (over: Partial<RiskLeg> = {}): RiskLeg => ({
  isCall: true,
  action: "buy",
  strike: 110,
  qty: 1,
  premiumUsd: 2,
  iv: 0.6,
  thetaUsd: -0.08,
  vegaUsd: 0.05,
  deltaPerContract: 0.25,
  ...over,
});

const base = {
  asset: "ETH" as const,
  legs: [leg()],
  spot: 100,
  nowSec: NOW,
  expiryTs: DAYS(30),
  marketScore: 50,
  baselineVol: 0.5,
  ivPercentile: 0.6,
  liquidity: {
    bidUsd: 1.4,
    askUsd: 2.6,
    fairUsd: 2,
    contractDepthUsd: 10_000,
    tradeSizeUsd: 1_000,
  },
};

// --- Expiry multiplier bands ---
assert.equal(expiryMultiplier(1), 1.5);
assert.equal(expiryMultiplier(3), 1.5);
assert.equal(expiryMultiplier(7), 1.3);
assert.equal(expiryMultiplier(14), 1.15);
assert.equal(expiryMultiplier(30), 1.0);
assert.equal(expiryMultiplier(58), 0.9);

// --- Risk bands ---
assert.equal(levelOf(10), "low");
assert.equal(levelOf(50), "medium");
assert.equal(levelOf(70), "high");
assert.equal(levelOf(90), "extreme");

// --- Payoff ---
assert.equal(payoffAtExpiry([leg({ strike: 110 })], 130), 20);
assert.equal(payoffAtExpiry([leg({ strike: 110 })], 90), 0);
assert.equal(
  payoffAtExpiry([leg({ strike: 100 }), leg({ strike: 120, action: "sell" })], 130),
  20,
  "a 100/120 call spread caps out at its 20-wide strike width",
);

// --- Premium risk: an OTM long collapses to the agreed 30 + 0.7 x P(loss) ---
const long = computeContractRisk({ ...base, legs: [leg()] });
assert.ok(long, "a fully specified long call should score");
const premium = long!.components.find((c) => c.key === "premium")!;
const pLoss = long!.lossProbability!;
assert.ok(pLoss > 0.75 && pLoss < 0.79, `OTM call loss probability ~0.77, got ${pLoss.toFixed(3)}`);
assert.ok(
  Math.abs(premium.score - (30 + 0.7 * pLoss * 100)) < 0.01,
  "out-of-the-money premium risk must equal 30 + 0.7 x loss probability",
);

// --- Short exposure inverts the directional components ---
const short = computeContractRisk({ ...base, legs: [leg({ action: "sell" })] });
assert.ok(short, "a short call should score");
assert.equal(short!.direction, "short");
assert.equal(long!.direction, "long");
const shortPremium = short!.components.find((c) => c.key === "premium")!;
assert.ok(
  Math.abs(shortPremium.score - (100 - premium.score)) < 0.01,
  "the seller's premium risk mirrors the buyer's",
);
assert.ok(
  Math.abs(short!.lossProbability! - (1 - pLoss)) < 1e-9,
  "loss probability is direction-aware without a second flip",
);

// Liquidity is an exit cost for both sides, so it must NOT mirror.
const liq = (r: NonNullable<ReturnType<typeof computeContractRisk>>) =>
  r.components.find((c) => c.key === "liquidity")!;
assert.equal(liq(long!).mirrored, false);
assert.equal(liq(short!).mirrored, false);
assert.equal(
  liq(long!).parts.find((p) => p.key === "spread")!.score,
  liq(short!).parts.find((p) => p.key === "spread")!.score,
  "a quoted bid-ask costs the same whichever way you cross it",
);

// Vega exposure never mirrors: a 5-point move hurts whoever is wrong.
const ivLong = long!.components.find((c) => c.key === "iv")!;
const ivShort = short!.components.find((c) => c.key === "iv")!;
assert.equal(
  ivLong.parts.find((p) => p.key === "vegaRisk")!.score,
  ivShort.parts.find((p) => p.key === "vegaRisk")!.score,
);
assert.ok(
  ivShort.parts.find((p) => p.key === "relativeIv")!.score <
    ivLong.parts.find((p) => p.key === "relativeIv")!.score,
  "rich vol is the buyer's problem and the seller's income",
);

// --- Multi-leg integrates the same distribution the closed form solves ---
// A zero-size second leg leaves the payoff untouched but forces the numeric path.
const forcedNumeric = computeContractRisk({
  ...base,
  legs: [leg(), leg({ qty: 0, strike: 200 })],
});
assert.ok(
  Math.abs(forcedNumeric!.lossProbability! - pLoss) < 0.005,
  `numeric loss probability ${forcedNumeric!.lossProbability!.toFixed(4)} should match closed form ${pLoss.toFixed(4)}`,
);

const spread = computeContractRisk({
  ...base,
  legs: [leg({ strike: 105, premiumUsd: 4 }), leg({ strike: 120, action: "sell", premiumUsd: 1.5 })],
});
assert.ok(spread, "a call spread should score");
assert.equal(spread!.direction, "long", "a net debit is a long structure");
assert.ok(spread!.lossProbability! > 0 && spread!.lossProbability! < 1);

// --- Unavailable inputs drop and renormalize; they never default to a midpoint ---
const noHistory = computeContractRisk({ ...base, baselineVol: null, ivPercentile: null });
const ivNoHistory = noHistory!.components.find((c) => c.key === "iv")!;
assert.equal(ivNoHistory.parts.length, 1, "only vega survives with no vol history");
assert.equal(ivNoHistory.dropped.length, 2);
assert.equal(ivNoHistory.parts[0].weight, 1, "the surviving weight renormalizes to 1");

const browsing = computeContractRisk({
  ...base,
  liquidity: { ...base.liquidity, tradeSizeUsd: null },
});
const browseLiq = liq(browsing!);
assert.ok(
  browseLiq.dropped.some((d) => d.key === "participation"),
  "with no trade size, participation is reported as dropped rather than guessed",
);
assert.ok(
  Math.abs(browseLiq.parts.reduce((s, p) => s + p.weight, 0) - 1) < 1e-9,
  "surviving liquidity weights renormalize to 1",
);

const noBook = computeContractRisk({ ...base, marketScore: null });
assert.ok(
  noBook!.dropped.some((d) => d.key === "market"),
  "a missing book snapshot drops the market component outright",
);
assert.equal(noBook!.components.length, 5);
assert.ok(noBook!.score >= 0 && noBook!.score <= 100);

// --- One-sided book falls back to a modelled spread, and says so ---
const oneSided = computeContractRisk({
  ...base,
  liquidity: { ...base.liquidity, bidUsd: null },
});
const spreadPart = liq(oneSided!).parts.find((p) => p.key === "spread")!;
assert.match(spreadPart.detail, /modelled/, "a one-sided spread must be labelled modelled");

// A contract with no quote at all loses the spread part entirely.
const unquoted = computeContractRisk({
  ...base,
  liquidity: { bidUsd: null, askUsd: null, fairUsd: null, contractDepthUsd: 500, tradeSizeUsd: null },
});
assert.ok(liq(unquoted!).dropped.some((d) => d.key === "spread"));

// --- Near-dated contracts score hotter than far-dated, all else equal ---
const near = computeContractRisk({ ...base, expiryTs: DAYS(2) });
const far = computeContractRisk({ ...base, expiryTs: DAYS(58) });
assert.ok(near!.expiryMultiplier === 1.5 && far!.expiryMultiplier === 0.9);
assert.ok(
  near!.components.find((c) => c.key === "expiry")!.score >
    far!.components.find((c) => c.key === "expiry")!.score,
  "two days out is more expiry risk than two months",
);

// --- Realized vol ---
const { realizedVol } = __internals;
const r = 0.02;
const closes = [100];
for (let i = 1; i < 200; i++) closes.push(closes[i - 1] * Math.exp(i % 2 ? r : -r));
const rv = realizedVol(closes, closes.length - 1, 30)!;
assert.ok(
  Math.abs(rv - r * Math.sqrt(365)) < 0.02,
  `alternating ${r} daily moves annualize to ~${(r * Math.sqrt(365)).toFixed(3)}, got ${rv.toFixed(3)}`,
);
assert.equal(realizedVol(closes, 5, 30), null, "not enough history returns null, never a guess");

const ctx = {
  asset: "ETH" as const,
  baselineVol: 0.5,
  distribution: [0.2, 0.3, 0.4, 0.5, 0.6],
  windowDays: 30,
  lookbackDays: 5,
  source: "coinbase" as const,
  asOf: 0,
};
assert.equal(percentileOf(ctx, 0.45), 0.6);
assert.equal(percentileOf(ctx, 0.1), 0);
assert.equal(percentileOf(ctx, 0.9), 1);

console.log("contract risk checks passed");
