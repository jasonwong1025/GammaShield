// Self-check for the market-impact model (lib/marketImpact.ts). Pure math,
// no network. Run with `npm run check:impact`.
//
// The properties that matter are the sign conventions — getting one backwards
// would tell a user that buying calms the market down — and agreement with
// lib/engine.ts, whose GEX convention this model has to match exactly.

import assert from "node:assert/strict";
import {
  computeMarketImpact,
  dailyVolPctOf,
  oneRoundImpact,
  priceMovePct,
  regimeOf,
  THRESHOLD_SHARE,
  type ImpactBasis,
} from "../lib/marketImpact.ts";
import { computeAssetSnapshot, flipStrikeOf, type NormalizedOrder } from "../lib/engine.ts";

const near = (a: number, b: number, tol = 1e-9, what = "") =>
  assert.ok(Math.abs(a - b) <= tol, `${what} expected ${b}, got ${a}`);

const SPOT = 77_000;
const ADV = 1_600_000_000;

const basis = (over: Partial<ImpactBasis> = {}): ImpactBasis => ({
  spot: SPOT,
  strike: 77_000,
  gammaPerContract: 1.9e-4,
  deltaPerContract: 0.5,
  takerIsLong: true,
  netGexUsd: -33_000,
  gexByStrike: [
    { strike: 74_000, gex: 800, notionalUsd: 10_000 },
    { strike: 77_000, gex: -33_800, notionalUsd: 10_000 },
  ],
  advUsd: ADV,
  advSources: ["coinbase", "binance"],
  baselineVol: 0.43,
  volSource: "coinbase",
  ...over,
});

// --- daily vol conversion ---
near(dailyVolPctOf(0.43), (0.43 / Math.sqrt(365)) * 100, 1e-12, "daily vol");
near(dailyVolPctOf(0), 0, 1e-12, "zero vol");

// --- square-root impact law ---
{
  const move = priceMovePct(1_000_000, ADV, 2.25, 1);
  near(move, 2.25 * Math.sqrt(1_000_000 / ADV), 1e-12, "impact law");
  // Four times the size is twice the move.
  near(priceMovePct(4_000_000, ADV, 2.25, 1) / move, 2, 1e-9, "sqrt scaling");
  // Sign follows the flow, and the coefficient is linear.
  assert.ok(priceMovePct(-1_000_000, ADV, 2.25, 1) < 0, "sell moves price down");
  near(priceMovePct(1_000_000, ADV, 2.25, 2) / move, 2, 1e-9, "coefficient is linear");
  near(priceMovePct(1_000_000, 0, 2.25, 1), 0, 0, "no volume, no move");
}

// --- one round of feedback: short dealer gamma amplifies, long dampens ---
{
  const args = { orderUsd: 5_000_000, advUsd: ADV, dailyVolPct: 2.25 };
  const short = oneRoundImpact({ ...args, netGexUsd: -33_000 });
  const long = oneRoundImpact({ ...args, netGexUsd: +33_000 });
  const flat = oneRoundImpact({ ...args, netGexUsd: 0 });

  assert.ok(short.amplification > 1, "negative GEX must amplify");
  assert.ok(long.amplification < 1, "positive GEX must dampen");
  near(flat.amplification, 1, 1e-12, "flat book neither amplifies nor dampens");
  near(flat.totalPct, flat.initialPct, 1e-12, "no gamma, no second round");
  // Dealers short gamma trade WITH the move.
  assert.ok(short.hedgeFlowUsd > 0, "short gamma buys into a rally");
  assert.ok(long.hedgeFlowUsd < 0, "long gamma sells into a rally");
  // A sell order mirrors it.
  const sell = oneRoundImpact({ ...args, orderUsd: -5_000_000, netGexUsd: -33_000 });
  near(sell.totalPct, -short.totalPct, 1e-9, "sell mirrors buy");
  near(sell.amplification, short.amplification, 1e-9, "amplification is direction-free");
}

// --- fill impact: sign conventions ---
{
  const buyCall = computeMarketImpact(basis(), 1);
  // Sell someone a call and you are short delta — you buy spot.
  assert.ok(buyCall.hedge.usd > 0, "dealer buys spot against a sold call");
  near(buyCall.hedge.usd, 0.5 * SPOT, 1e-9, "hedge notional");
  assert.equal(buyCall.gammaSign, "negative", "buying hands the dealer short gamma");
  assert.ok(buyCall.gamma.usd < 0, "added GEX is negative for a buy");

  const buyPut = computeMarketImpact(basis({ deltaPerContract: -0.5 }), 1);
  assert.ok(buyPut.hedge.usd < 0, "dealer sells spot against a sold put");
  assert.equal(buyPut.gammaSign, "negative", "buying a put is also short dealer gamma");

  const sellCall = computeMarketImpact(basis({ takerIsLong: false }), 1);
  assert.equal(sellCall.gammaSign, "positive", "selling hands the dealer long gamma");
  near(sellCall.gamma.usd, -buyCall.gamma.usd, 1e-9, "sell mirrors buy on gamma");
  near(sellCall.hedge.usd, -buyCall.hedge.usd, 1e-9, "sell mirrors buy on the hedge");
}

// --- agreement with lib/engine.ts on the GEX convention ---
{
  const order = (over: Partial<NormalizedOrder> = {}): NormalizedOrder => ({
    asset: "BTC",
    structure: "CALL",
    isCall: true,
    takerIsLong: true,
    strike: 77_000,
    strikes: [77_000],
    expiryTs: 2_000_000_000,
    collateralUsd: 77_000, // exactly one contract
    maker: "0xmaker",
    greeks: { delta: 0.5, gamma: 1.9e-4, iv: 0.4, theta: -1, vega: 1, rho: 0 },
    pricePerContractUsd: 1_000,
    ...over,
  });
  const empty = computeAssetSnapshot("BTC", SPOT, [], 1_000_000_000);
  const one = computeAssetSnapshot("BTC", SPOT, [order()], 1_000_000_000);
  const impact = computeMarketImpact(
    basis({ netGexUsd: 0, gexByStrike: [] }),
    1,
  );
  near(impact.gamma.usd, one.netGexUsd - empty.netGexUsd, 1e-6, "GEX matches the engine");
}

// --- linearity in size, and the threshold that follows from it ---
{
  const one = computeMarketImpact(basis(), 1);
  const ten = computeMarketImpact(basis(), 10);
  near(ten.gamma.usd / one.gamma.usd, 10, 1e-9, "gamma flow is linear in size");
  near(ten.hedge.usd / one.hedge.usd, 10, 1e-9, "hedge flow is linear in size");

  // At the threshold size, the flow is exactly 1% of daily volume.
  const at = computeMarketImpact(basis(), one.gamma.contractsForThreshold!);
  near(Math.abs(at.gamma.usd) / ADV, THRESHOLD_SHARE, 1e-12, "gamma threshold");
  const atHedge = computeMarketImpact(basis(), one.hedge.contractsForThreshold!);
  near(Math.abs(atHedge.hedge.usd) / ADV, THRESHOLD_SHARE, 1e-12, "hedge threshold");

  // Real book sizes are far below it — the finding this readout exists to state.
  assert.ok(one.gamma.contractsForThreshold! > 100, "threshold is orders of magnitude above one contract");
}

// --- the book state after the fill ---
{
  const before = basis({ netGexUsd: -33_000 });
  const after = computeMarketImpact(before, 1);
  near(after.netGexAfter, before.netGexUsd + after.gamma.usd, 1e-9, "net GEX adds up");
  assert.equal(after.regimeBefore, "amplifying");
  assert.equal(after.regimeAfter, "amplifying");
  assert.equal(regimeOf(0), "neutral");
  assert.equal(regimeOf(5), "dampening");

  // A big enough buy tips a positive book negative.
  const positive = basis({ netGexUsd: 5_000, gexByStrike: [{ strike: 77_000, gex: 5_000, notionalUsd: 1 }] });
  const flipped = computeMarketImpact(positive, 5);
  assert.equal(flipped.regimeBefore, "dampening");
  assert.equal(flipped.regimeAfter, "amplifying", "enough size flips the regime");

  // Flip strike is recomputed on the modified ladder, by the engine's own walk.
  const ladder = [
    { strike: 74_000, gex: 800, notionalUsd: 1 },
    { strike: 77_000, gex: -100, notionalUsd: 1 },
  ];
  assert.equal(flipStrikeOf(ladder), null, "no crossing yet");
  const moved = computeMarketImpact(basis({ netGexUsd: 700, gexByStrike: ladder }), 1);
  assert.equal(moved.flipBefore, null);
  assert.equal(moved.flipAfter, 77_000, "the fill's gamma drags the ladder through zero");

  // A strike the ladder has never seen gets appended rather than dropped.
  const fresh = computeMarketImpact(basis({ strike: 90_000 }), 1);
  near(fresh.netGexAfter, basis().netGexUsd + fresh.gamma.usd, 1e-9, "unlisted strike still counts");
}

// --- missing inputs drop the dependent output and say why ---
{
  const noVolume = computeMarketImpact(basis({ advUsd: null, advSources: [] }), 1);
  assert.equal(noVolume.move, null, "no volume, no move estimate");
  assert.equal(noVolume.hedge.shareOfAdv, null);
  assert.equal(noVolume.gamma.contractsForThreshold, null);
  assert.ok(noVolume.unavailable.some((r) => r.includes("spot volume")), "reason names the input");
  // The flows themselves are still measured — they need no volume.
  assert.ok(noVolume.hedge.usd > 0, "hedge flow survives a missing denominator");

  const noVol = computeMarketImpact(basis({ baselineVol: null, volSource: null }), 1);
  assert.equal(noVol.move, null, "no realized vol, no move estimate");
  assert.equal(noVol.dailyVolPct, null);
  assert.ok(noVol.gamma.contractsForThreshold !== null, "thresholds need only volume");
  assert.ok(noVol.unavailable.some((r) => r.includes("realized-vol")), "reason names the input");

  const zero = computeMarketImpact(basis(), 0);
  assert.equal(zero.move, null, "no size, no move");
  near(zero.gamma.usd, 0, 0, "no size, no flow");
}

// --- the live-book scale finding, asserted so a regression shows up here ---
{
  // One ATM contract against the real book and real volume: the whole point is
  // that this is invisible to spot.
  const one = computeMarketImpact(basis(), 1);
  assert.ok(Math.abs(one.move!.totalPct) < 0.05, "one contract cannot move spot measurably");
  assert.ok(one.move!.amplification > 1, "but the dealer book still amplifies it");
}

console.log("market impact checks passed");
