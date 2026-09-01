import assert from "node:assert/strict";
import { analyzePayoff, terminalPayoff } from "../lib/strategyPayoff.ts";

const straddle = [
  { side: "call" as const, action: "buy" as const, strike: 100, qty: 1 },
  { side: "put" as const, action: "buy" as const, strike: 100, qty: 1 },
];
const straddleAnalysis = analyzePayoff(straddle, 10);
assert.equal(terminalPayoff(120, straddle, 10), 10);
assert.equal(straddleAnalysis.maxLoss, 10);
assert.equal(straddleAnalysis.maxProfit, "unlimited");
assert.deepEqual(straddleAnalysis.breakevens, [90, 110]);

const spread = [
  { side: "call" as const, action: "buy" as const, strike: 100, qty: 1 },
  { side: "call" as const, action: "sell" as const, strike: 120, qty: 1 },
];
const spreadAnalysis = analyzePayoff(spread, 5);
assert.equal(spreadAnalysis.maxProfit, 15);
assert.equal(spreadAnalysis.maxLoss, 5);
assert.deepEqual(spreadAnalysis.breakevens, [105]);

console.log("strategy payoff checks passed");
