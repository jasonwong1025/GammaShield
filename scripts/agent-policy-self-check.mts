// Self-check for the autonomous position-management layer. Pure, no network.
// Run with `npm run check:agent`.
//
// The properties that matter are the safety ones: the derived caps must never
// round up past what the user typed, the toggles must only ever subtract, an
// action the deployment cannot execute must never resolve, and the AI's one
// power to initiate an action must stay inside every one of its bounds.
//
// The six scenarios the spec asks for (A-F) are covered under "the decision
// engine" below, alongside the two rules that are easiest to break by
// accident: never close on a drawdown, and never roll on expiry alone.

import assert from "node:assert/strict";
import {
  ACTION_LABEL,
  AGENT_ACTIONS,
  DEFAULT_AGENT_LIMITS,
  MIN_UNIT,
  NOTIONAL_STRIKE_HEADROOM,
  NO_BUDGET,
  advisoryAvailability,
  agentActionAvailability,
  deriveMandateCaps,
  fillExceedsNotionalCap,
  floor6,
  isActionArmed,
  notionalUsd,
  resolveAgentAction,
  toUnitString,
  type AgentLimits,
  type OpenPosition,
} from "../lib/autonomous/policy.ts";
import { CRITICAL_RISK, decide, intentOf, type DecisionInput, type ManagedPosition } from "../lib/autonomous/decision.ts";
import { riskTrendFrom, type RiskSample } from "../lib/autonomous/trend.ts";
import { computePositionRisk, HELD_POSITION_DROPS } from "../lib/autonomous/positionRisk.ts";
import { evaluateThesis, targetReached } from "../lib/autonomous/thesisRules.ts";
import { UNSOURCEABLE_REASON_CODES, type RiskTrend, type TradingThesis } from "../lib/autonomous/types.ts";

const near = (a: number, b: number, tol = 1e-9, what = "") =>
  assert.ok(Math.abs(a - b) <= tol, `${what} expected ${b}, got ${a}`);

const SPOT = 77_000;
const limits = (over: Partial<AgentLimits> = {}): AgentLimits => ({ ...DEFAULT_AGENT_LIMITS, ...over });

// --- the user's two dollar figures become signed caps ---
{
  const caps = deriveMandateCaps(limits(), SPOT);
  near(caps.maxPremiumTotal, 800, 0, "max loss is the total premium cap");
  near(caps.strikeCeiling, SPOT * NOTIONAL_STRIKE_HEADROOM, 1e-9, "strike ceiling");

  // The contract cap must hold notional at or under the trade cap for every
  // strike up to the ceiling, and must never round UP past it.
  // Truncating to the 6dp the mandate can express gives up at most one tick of
  // notional, and always downward.
  const atCeiling = notionalUsd(caps.maxContractsPerFill, caps.strikeCeiling);
  assert.ok(atCeiling <= 500, "cap rounds up past the trade limit");
  assert.ok(500 - atCeiling <= caps.strikeCeiling * MIN_UNIT, "cap gives up more than one contract tick");
  assert.ok(notionalUsd(caps.maxContractsPerFill, SPOT) < 500, "at spot the cap is comfortably inside");

  // A bought put's premium is below its own notional, so the per-fill premium
  // cap is the tighter of the two figures, never a third invented number.
  near(caps.maxPremiumPerFill, 500, 0, "per-fill premium cap");
  near(deriveMandateCaps(limits({ maxLossUsd: 200 }), SPOT).maxPremiumPerFill, 200, 0, "loss cap can be the tighter one");

  // Signed sizes are 6dp; rounding is always downward.
  near(floor6(0.0051948), 0.005194, 0, "floor6 truncates");
  assert.equal(toUnitString(0.0051948), "0.005194");
  assert.equal(toUnitString(800), "800");
}

// --- limits that cannot be expressed are refused, not silently zeroed ---
{
  assert.throws(() => deriveMandateCaps(limits({ maxTradeNotionalUsd: 0 }), SPOT), /positive/);
  assert.throws(() => deriveMandateCaps(limits(), 0), /spot/);
  // $0.05 of BTC notional is below the 1e-6 contract resolution.
  assert.throws(() => deriveMandateCaps(limits({ maxTradeNotionalUsd: 0.05 }), 1e9), /smaller than/);
  const tiny = deriveMandateCaps(limits({ maxTradeNotionalUsd: 1 }), SPOT);
  assert.ok(tiny.maxContractsPerFill >= MIN_UNIT, "smallest workable cap still expressible");
}

// --- the exact notional check the signed cap approximates ---
{
  const caps = deriveMandateCaps(limits(), SPOT);
  assert.ok(!fillExceedsNotionalCap(limits(), caps.maxContractsPerFill, SPOT), "a fill at spot is inside the cap");
  // The signed contract cap alone would allow this; the exact check is what stops it.
  assert.ok(fillExceedsNotionalCap(limits(), caps.maxContractsPerFill, SPOT * 2), "an out-of-range strike is caught exactly");
}

// --- availability: mainnet is hedge-only, and it says why ---
{
  const mainnet = agentActionAvailability(limits(), "mainnet", null);
  assert.equal(mainnet.filter((entry) => entry.available).length, 1, "mainnet executes one action");
  assert.ok(isActionArmed(mainnet, "hedge"), "hedge is armed on mainnet");
  for (const action of ["close", "roll"] as const) {
    const entry = mainnet.find((value) => value.action === action)!;
    assert.equal(entry.available, false);
    assert.ok(entry.reason && entry.reason.length > 20, `${action} must carry a stated reason`);
    assert.ok(!isActionArmed(mainnet, action), `${action} must not be armed on mainnet`);
  }

  // Sepolia needs the redeployed book; an unreadable version means fill-only.
  const stale = agentActionAvailability(limits(), "sepolia", 1);
  assert.ok(!isActionArmed(stale, "close"), "an old shadow book cannot close");
  assert.ok(stale.find((entry) => entry.action === "close")!.reason!.includes("Redeploy"), "reason names the fix");
  assert.ok(!isActionArmed(agentActionAvailability(limits(), "sepolia", null), "roll"), "unknown version is treated as old");

  const current = agentActionAvailability(limits(), "sepolia", 2);
  for (const action of AGENT_ACTIONS) assert.ok(isActionArmed(current, action), `${action} armed on a current shadow book`);

  // A toggle only ever subtracts.
  const off = agentActionAvailability(limits({ actions: { hedge: true, close: false, roll: true } }), "sepolia", 2);
  assert.ok(!isActionArmed(off, "close") && isActionArmed(off, "hedge"), "a toggle switches exactly one action off");
  assert.ok(off.find((entry) => entry.action === "close")!.available, "a switched-off action is still reported available");
}

// --- the risk trend: unknown is not flat ---
{
  const now = 1_800_000_000;
  const sample = (agoHours: number, book: number, position: number): RiskSample => ({
    observedAt: now - agoHours * 3600,
    bookScoreBps: book * 100,
    positionScoreBps: position * 100,
  });

  const empty = riskTrendFrom([], "book", now);
  assert.equal(empty.oneHour, null, "no samples cannot describe an hour");
  assert.equal(empty.samples, 0);

  // One sample is history, but it is not a change.
  assert.equal(riskTrendFrom([sample(0, 70, 60)], "book", now).oneHour, null, "a single sample is not a trend");

  // Two hours of history: the 1h window is measurable, the 24h one is not.
  const short = riskTrendFrom([sample(2, 50, 40), sample(1, 60, 45), sample(0, 70, 55)], "book", now);
  near(short.oneHour ?? NaN, 10, 1e-9, "1h delta");
  assert.equal(short.twentyFourHours, null, "two hours cannot describe a day");
  assert.notEqual(short.twentyFourHours, 0, "an unknown window must never read as flat");

  // A genuinely flat trend reports 0, which is a different fact.
  const flat = riskTrendFrom([sample(2, 70, 60), sample(1, 70, 60), sample(0, 70, 60)], "book", now);
  near(flat.oneHour ?? NaN, 0, 1e-9, "a flat hour is 0, not null");

  // The subject is selectable, and the two series are independent.
  const byPosition = riskTrendFrom([sample(2, 50, 80), sample(1, 60, 70), sample(0, 70, 60)], "position", now);
  near(byPosition.oneHour ?? NaN, -10, 1e-9, "position risk fell while book risk rose");
}

// --- a held position: what cannot be sourced is dropped, not modelled ---
{
  const now = 1_800_000_000;
  const position = {
    id: "7",
    asset: "BTC" as const,
    isCall: false,
    strike: 80_000,
    expiryTs: now + 10 * 86_400,
    contracts: 0.01,
    entryPremiumUsd: 900,
    markUsd: 1_100,
    askUsd: 1_300,
    pnlUsd: 2,
  };
  const risk = computePositionRisk({ position, spot: SPOT, nowSec: now, marketScore: 60, contractDepthUsd: 50_000 });
  assert.ok(risk, "a marked position is scoreable");
  const keys = risk!.components.map((component) => component.key);
  const dropped = risk!.dropped.map((entry) => entry.key);

  // Four of six components survive. The two that do not are dropped WITH a
  // reason, never defaulted to a midpoint.
  assert.deepEqual(keys.sort(), ["expiry", "liquidity", "market", "premium"], "the four sourceable components survive");
  for (const { key } of HELD_POSITION_DROPS) {
    assert.ok(dropped.includes(key), `${key} is dropped for a held position`);
  }
  for (const entry of risk!.dropped) assert.ok(entry.reason.length > 10, `${entry.key} drop states a reason`);

  // The surviving weights renormalize to 1, so the score stays on 0-100.
  near(risk!.components.reduce((sum, component) => sum + component.weight, 0), 0.75, 1e-9, "raw weights of the survivors");
  assert.ok(risk!.score >= 0 && risk!.score <= 100, "score stays in range");

  // An unpriceable position is unscored, which is not the same as safe.
  assert.equal(
    computePositionRisk({ position: { ...position, markUsd: null, entryPremiumUsd: null }, spot: SPOT, nowSec: now, marketScore: 60, contractDepthUsd: null }),
    null,
    "no mark means no score, never a zero score",
  );

  // Every reason code the spec asked for and this venue cannot support is
  // documented rather than quietly emitted as a guess.
  assert.ok(UNSOURCEABLE_REASON_CODES.length >= 5, "the unsourceable codes are enumerated");
  for (const entry of UNSOURCEABLE_REASON_CODES) assert.ok(entry.reason.length > 20, `${entry.code} states why`);
}

// --- the thesis: only measurable things can break a view ---
{
  const now = 1_800_000_000;
  const thesis = (over: Partial<TradingThesis> = {}): TradingThesis => ({
    direction: "BULLISH",
    objective: "ACQUIRE_CRYPTO",
    targetPrice: null,
    horizonEndsAt: null,
    referenceSpot: 80_000,
    note: null,
    ...over,
  });

  assert.ok(evaluateThesis(thesis(), 78_000, now).valid, "a 2.5% dip does not break a two-week view");
  assert.ok(!evaluateThesis(thesis(), 71_000, now).valid, "an 11% fall breaks a bullish view");
  assert.ok(evaluateThesis(thesis({ direction: "BEARISH" }), 71_000, now).valid, "the same fall confirms a bearish view");
  assert.ok(!evaluateThesis(thesis({ direction: "BEARISH" }), 89_000, now).valid, "an 11% rally breaks a bearish view");
  assert.ok(!evaluateThesis(thesis({ direction: "NEUTRAL" }), 89_000, now).valid, "either direction breaks a neutral view");
  assert.ok(!evaluateThesis(thesis({ horizonEndsAt: now - 1 }), 80_000, now).valid, "an elapsed horizon breaks the view");

  // No recorded view cannot be invalidated, and must say so rather than
  // pretending a neutral one was given.
  const none = evaluateThesis(null, 80_000, now);
  // Absent is valid only because nothing can invalidate it — which must never
  // be worded, or reasoned about, as a view that is holding up.
  assert.ok(none.valid, "an absent view cannot be invalidated");
  assert.equal(none.recorded, false, "an absent view is flagged as unrecorded");
  assert.ok(evaluateThesis(thesis(), 78_000, now).recorded, "a real view is flagged as recorded");

  // Reaching a target completes a view rather than breaking it.
  const hit = evaluateThesis(thesis({ targetPrice: 85_000 }), 86_000, now);
  assert.ok(hit.valid && hit.reason.includes("target"), "a reached target is not an invalidation");
  assert.ok(targetReached(thesis({ targetPrice: 85_000 }), 86_000), "target reached upward");
  assert.ok(targetReached(thesis({ direction: "BEARISH", targetPrice: 70_000 }), 69_000), "target reached downward");
  assert.ok(!targetReached(thesis({ direction: "NEUTRAL", targetPrice: 85_000 }), 86_000), "a neutral view has no directional target");
}

// --- the decision engine, including the spec's six scenarios ---
{
  const now = 1_800_000_000;
  const armed = agentActionAvailability(limits(), "sepolia", 2);
  const cover = (over: Partial<ManagedPosition> = {}): ManagedPosition => ({
    id: "1",
    asset: "ETH",
    isCall: false,
    strike: 2_400,
    expiryTs: now + 30 * 86_400,
    contracts: 0.5,
    entryPremiumUsd: 40,
    markUsd: 30,
    askUsd: 45,
    pnlUsd: -5,
    role: "cover",
    ...over,
  });
  const trend = (over: Partial<RiskTrend> = {}): RiskTrend => ({
    oneHour: 0,
    sixHours: 0,
    twentyFourHours: 0,
    historySeconds: 24 * 3600,
    samples: 24,
    ...over,
  });
  const input = (over: Partial<DecisionInput> = {}): DecisionInput => ({
    position: null,
    bookRiskScore: 80,
    bookThreshold: 75,
    bookPersistenceMet: true,
    positionRiskScore: null,
    positionThreshold: 70,
    trend: trend(),
    thesis: { valid: true, recorded: true, reason: "spot is still inside the range the view allows for" },
    objective: "HEDGE_EXISTING_POSITION",
    targetReached: false,
    availability: armed,
    maxContracts: 0.5,
    quotedPremiumUsd: 40,
    lossBudgetUsd: 800,
    spentPremiumUsd: 0,
    executable: true,
    nowSec: now,
    ...over,
  });

  // Scenario A — healthy position, stable trend, valid view, comfortable expiry.
  const healthy = decide(input({ position: cover(), positionRiskScore: 30 }));
  assert.equal(healthy.action, "HOLD", "scenario A holds");
  assert.equal(healthy.urgency, "LOW");

  // Scenario B — view holds, expiry near, position still risky.
  const rolling = decide(input({ position: cover({ expiryTs: now + 6 * 3600 }), positionRiskScore: 78 }));
  assert.equal(rolling.action, "ROLL", "scenario B rolls");
  assert.ok(rolling.reasonCodes.includes("EXPIRY_NEAR"));

  // Scenario C — nothing open, book hot and persisted, cover affordable.
  const hedging = decide(input());
  assert.equal(hedging.action, "HEDGE", "scenario C hedges");
  assert.ok(hedging.reasonCodes.includes("HEDGE_COST_ACCEPTABLE"));
  // A hedge bounds this account's loss; it does not lower the book's score,
  // and claiming otherwise would invent an effect the book cannot feel.
  assert.equal(hedging.estimatedRiskAfter, null, "a hedge does not claim to lower book risk");

  // Scenario D — the view is broken.
  const closing = decide(input({
    position: cover(),
    positionRiskScore: 50,
    thesis: { valid: false, recorded: true, reason: "spot has moved 12% against the bullish view" },
  }));
  assert.equal(closing.action, "CLOSE", "scenario D closes");
  assert.ok(closing.reasonCodes.includes("THESIS_INVALIDATED"));
  near(closing.estimatedCostUsd ?? NaN, -15, 1e-9, "an exit reports proceeds as a negative cost");

  // Scenario E — the cover costs more than the budget has left. Refused with
  // the reason, and the alternatives record why.
  const overBudget = decide(input({ quotedPremiumUsd: 500, spentPremiumUsd: 700 }));
  assert.notEqual(overBudget.action, "HEDGE", "scenario E blocks the hedge");
  const hedgeAlternative = overBudget.alternatives.find((entry) => entry.action === "HEDGE");
  assert.ok(hedgeAlternative?.rejected.includes("budget"), "the block states the budget reason");

  // Scenario F — risk accelerating raises urgency.
  const accelerating = decide(input({ position: cover(), positionRiskScore: 72, trend: trend({ sixHours: 20, oneHour: 8 }) }));
  assert.equal(accelerating.urgency, "HIGH", "scenario F is urgent");
  assert.ok(accelerating.reasonCodes.includes("RISK_ACCELERATING"));

  // Never roll on expiry alone: near expiry with a cold position expires.
  const expiringCold = decide(input({ position: cover({ expiryTs: now + 6 * 3600 }), positionRiskScore: 40 }));
  assert.notEqual(expiringCold.action, "ROLL", "expiry alone does not justify a roll");
  const rollAlternative = expiringCold.alternatives.find((entry) => entry.action === "ROLL");
  assert.ok(rollAlternative?.rejected.includes("expire"), "the refusal says letting it expire is free");

  // Never close on a drawdown: a directional position under water with a
  // valid view and calm book is held.
  const underwater = decide(input({
    position: cover({ role: "directional", markUsd: 5, entryPremiumUsd: 40, pnlUsd: -35 }),
    positionRiskScore: 40,
    bookRiskScore: 10,
  }));
  assert.equal(underwater.action, "HOLD", "a drawdown is not a reason to close");

  // Cover, though, IS spare once the book cools — the distinction between the
  // two roles is the whole point of tracking it.
  const spare = decide(input({ position: cover(), positionRiskScore: 40, bookRiskScore: 10 }));
  assert.equal(spare.action, "CLOSE", "cover is closed once the risk it covered is gone");
  assert.ok(spare.reasonCodes.includes("RISK_COOLING"));

  // Extreme risk closes, unless it is already falling back.
  assert.equal(decide(input({ position: cover(), positionRiskScore: CRITICAL_RISK + 1 })).action, "CLOSE", "extreme risk exits");
  assert.equal(
    decide(input({ position: cover(), positionRiskScore: CRITICAL_RISK + 1, trend: trend({ sixHours: -20 }) })).action,
    "HOLD",
    "extreme but falling risk is not chased",
  );

  // The objective changes what the same fact means.
  const profitTaker = decide(input({ position: cover(), positionRiskScore: 40, bookRiskScore: 80, targetReached: true, objective: "PROFIT_FROM_OPTIONS" }));
  assert.equal(profitTaker.action, "CLOSE", "a reached target takes profit for this objective");
  const acquirer = decide(input({ position: cover({ role: "directional" }), positionRiskScore: 40, bookRiskScore: 80, targetReached: true, objective: "ACQUIRE_CRYPTO" }));
  assert.notEqual(acquirer.action, "CLOSE", "the same target keeps exposure for this objective");

  // Short history is reported as short, never as a calm trend.
  const noHistory = decide(input({ position: cover(), positionRiskScore: 40, trend: trend({ oneHour: null, sixHours: null, twentyFourHours: null, samples: 1, historySeconds: 0 }) }));
  assert.ok(noHistory.reasonCodes.includes("INSUFFICIENT_HISTORY"), "a short history is stated");
  assert.ok(noHistory.explanation.includes("too short"), "and it is stated in words too");

  // Every rejection carries a reason, always.
  for (const decision of [healthy, rolling, hedging, closing, spare]) {
    assert.equal(decision.alternatives.length, 3, "every other action is accounted for");
    for (const alternative of decision.alternatives) {
      assert.ok(alternative.rejected.length > 5, `${decision.action}: ${alternative.action} rejection has a reason`);
    }
  }

  // A deployment that cannot execute reports a recommendation, not a fill.
  const recommendation = decide(input({ position: cover(), positionRiskScore: 50, thesis: { valid: false, recorded: true, reason: "the view broke" }, executable: false }));
  assert.equal(recommendation.action, "CLOSE");
  assert.ok(recommendation.recommendationOnly, "an unexecutable action is flagged as advisory");
  assert.ok(recommendation.explanation.includes("recommendation only"), "and says so");
  assert.ok(!decide(input({ position: cover(), positionRiskScore: 30 })).recommendationOnly, "holding is never a recommendation");
}

// --- the advisory path used by the position-strategy panel ---
{
  const now = 1_800_000_000;
  const held = {
    id: "1", asset: "BTC" as const, isCall: false, strike: 78_000, expiryTs: now + 10 * 86_400,
    contracts: 0.01, entryPremiumUsd: null, markUsd: 25, askUsd: 60, pnlUsd: null,
    role: "directional" as const,
  };
  const advisory = (over: Partial<DecisionInput> = {}): DecisionInput => ({
    position: held, bookRiskScore: 40, bookThreshold: 75, bookPersistenceMet: true,
    positionRiskScore: 65, positionThreshold: 70,
    trend: { oneHour: null, sixHours: null, twentyFourHours: null, historySeconds: 0, samples: 0 },
    thesis: { valid: true, recorded: false, reason: "no view was recorded" },
    objective: null, targetReached: false,
    availability: advisoryAvailability(),
    maxContracts: 0.01, quotedPremiumUsd: 60,
    lossBudgetUsd: NO_BUDGET, spentPremiumUsd: 0, executable: false, nowSec: now, ...over,
  });

  // Every action is considered on merit. Gating on real availability would
  // make a mainnet close unpickable, so the panel could never suggest selling.
  for (const action of AGENT_ACTIONS) {
    assert.ok(isActionArmed(advisoryAvailability(), action), `${action} is considered in an advisory read`);
  }

  // The budget sentinel must not read as an exhausted budget, which would
  // suppress every buy on a position the user opened themselves.
  const codes = decide(advisory()).reasonCodes;
  assert.ok(!codes.includes("LOSS_BUDGET_NEAR"), "no signed budget must not read as an exhausted one");

  // A broken view still closes, and an unexecutable deployment says so rather
  // than quietly declining to suggest it.
  const broken = decide(advisory({ thesis: { valid: false, recorded: true, reason: "the view broke" } }));
  assert.equal(broken.action, "CLOSE", "an advisory read can still call for a sell");
  assert.ok(broken.recommendationOnly, "and flags that it cannot be executed here");

  // A position the user opened is not cover, and must not be described as it.
  const hedgeAlternative = decide(advisory()).alternatives.find((entry) => entry.action === "HEDGE");
  assert.ok(!hedgeAlternative!.rejected.includes("cover is already in place"), "a directional position is not called cover");

  // With no view recorded, nothing may claim the view is holding up.
  const holding = decide(advisory());
  assert.equal(holding.action, "HOLD");
  assert.ok(holding.reason.includes("no view is recorded"), "an absent view is stated in the verdict");
  assert.ok(!holding.reason.includes("still holds"), "an absent view is never reported as holding");
}

// --- resolution: toggles, availability and the AI can only subtract ---
{
  const now = 1_800_000_000;
  const sepolia = agentActionAvailability(limits(), "sepolia", 2);
  const open: OpenPosition = { positionId: 0, expiryTs: now + 5 * 86_400, contracts: 0.4 };
  const hedgeIntent = { action: "hedge" as const, position: null, reason: "book risk has held above the trigger" };
  const holdIntent = { action: "hold" as const, position: open, reason: "the view still holds" };
  const closeIntent = { action: "close" as const, position: open, reason: "cover is spare" };
  const base = { intent: hedgeIntent, availability: sepolia, maxContracts: 0.005 };

  const clean = resolveAgentAction({ ...base, proposal: null });
  assert.equal(clean.action, "hedge");
  near(clean.contracts, 0.005, 0, "no proposal leaves the size alone");
  assert.equal(clean.aiRationale, null, "no AI, no rationale");
  assert.equal(clean.aiInitiated, false);

  // Unavailable and switched-off both collapse to hold, each with its reason.
  const onMainnet = resolveAgentAction({
    intent: closeIntent,
    availability: agentActionAvailability(limits(), "mainnet", null),
    maxContracts: 1,
    proposal: null,
  });
  assert.equal(onMainnet.action, "hold", "close cannot resolve on mainnet");
  assert.ok(onMainnet.notes.some((note) => note.includes("Base mainnet")), "hold states the deployment reason");

  const switchedOff = resolveAgentAction({
    ...base,
    availability: agentActionAvailability(limits({ actions: { hedge: false, close: true, roll: true } }), "sepolia", 2),
    proposal: null,
  });
  assert.equal(switchedOff.action, "hold");
  assert.ok(switchedOff.notes.some((note) => note.includes(ACTION_LABEL.hedge)), "hold names the toggle");

  // The AI may shrink, may not grow, and may stand down.
  const smaller = resolveAgentAction({ ...base, proposal: { action: "hedge", contracts: 0.002, rationale: "thin book" } });
  near(smaller.contracts, 0.002, 0, "AI shrank the size");
  assert.equal(smaller.aiRationale, "thin book");
  near(resolveAgentAction({ ...base, proposal: { action: "hedge", contracts: 5, rationale: "go big" } }).contracts, 0.005, 0, "AI cannot raise the size");
  assert.equal(resolveAgentAction({ ...base, proposal: { action: "hold", contracts: 0, rationale: "spread too wide" } }).action, "hold");
  assert.equal(resolveAgentAction({ ...base, proposal: { action: "hedge", contracts: 1e-9, rationale: "tiny" } }).action, "hold", "dust stands the agent down");

  // A close is all-or-nothing; the AI cannot part-close.
  const closing = resolveAgentAction({ intent: closeIntent, availability: sepolia, maxContracts: 0.005, proposal: { action: "close", contracts: 0.1, rationale: "half out" } });
  assert.equal(closing.action, "close");
  near(closing.contracts, 0.4, 0, "a close is always the full position");

  // --- the ONE thing the AI may initiate, and every bound on it ---

  // Allowed: an open position, close armed, the claim made, a reason given.
  const initiated = resolveAgentAction({
    intent: holdIntent,
    availability: sepolia,
    maxContracts: 0.005,
    proposal: { action: "close", contracts: 0.4, rationale: "the merger that motivated this trade was called off", thesisBroken: true },
  });
  assert.equal(initiated.action, "close", "a stated thesis break can initiate a close");
  assert.equal(initiated.aiInitiated, true, "and it is marked as AI-initiated");
  near(initiated.contracts, 0.4, 0, "an AI-initiated close is the whole position");

  // Refused: no claim, so it is an ordinary illegal action swap.
  const noClaim = resolveAgentAction({ intent: holdIntent, availability: sepolia, maxContracts: 0.005, proposal: { action: "close", contracts: 0.4, rationale: "feels wrong" } });
  assert.equal(noClaim.action, "hold", "a close without a thesis claim is refused");
  assert.ok(noClaim.notes.some((note) => note.includes("thesis break")), "and the refusal explains what was missing");

  // Refused: the claim without a reason is not actionable.
  const noReason = resolveAgentAction({ intent: holdIntent, availability: sepolia, maxContracts: 0.005, proposal: { action: "close", contracts: 0.4, rationale: "   ", thesisBroken: true } });
  assert.equal(noReason.action, "hold", "a claim with no reason is refused");

  // Refused: nothing is open, so this is not a route to opening anything.
  const nothingOpen = resolveAgentAction({
    intent: { action: "hold", position: null, reason: "nothing open" },
    availability: sepolia,
    maxContracts: 0.005,
    proposal: { action: "close", contracts: 1, rationale: "view broke", thesisBroken: true },
  });
  assert.equal(nothingOpen.action, "hold", "no position, no close");
  assert.ok(nothingOpen.notes.some((note) => note.includes("no position is open")));

  // Refused: close switched off, and refused: close unavailable here.
  assert.equal(
    resolveAgentAction({
      intent: holdIntent,
      availability: agentActionAvailability(limits({ actions: { hedge: true, close: false, roll: true } }), "sepolia", 2),
      maxContracts: 0.005,
      proposal: { action: "close", contracts: 0.4, rationale: "view broke", thesisBroken: true },
    }).action,
    "hold",
    "a switched-off close cannot be initiated",
  );
  assert.equal(
    resolveAgentAction({
      intent: holdIntent,
      availability: agentActionAvailability(limits(), "mainnet", null),
      maxContracts: 0.005,
      proposal: { action: "close", contracts: 0.4, rationale: "view broke", thesisBroken: true },
    }).action,
    "hold",
    "an unavailable close cannot be initiated",
  );

  // Refused: the exception is close-only. A thesis claim cannot smuggle in a
  // hedge or a roll the gate never cleared.
  for (const action of ["hedge", "roll"] as const) {
    const smuggled = resolveAgentAction({
      intent: holdIntent,
      availability: sepolia,
      maxContracts: 0.005,
      proposal: { action, contracts: 0.4, rationale: "view broke", thesisBroken: true },
    });
    assert.equal(smuggled.action, "hold", `a thesis claim cannot initiate a ${action}`);
    assert.equal(smuggled.aiInitiated, false);
  }

  // The bridge from the engine keeps the action and the subject aligned.
  const bridged = intentOf(
    { action: "CLOSE", reason: "the view broke", urgency: "HIGH", reasonCodes: [], explanation: "", riskBefore: 50, estimatedRiskAfter: 0, estimatedCostUsd: -10, alternatives: [], aiInitiated: false, recommendationOnly: false },
    open,
  );
  assert.equal(bridged.action, "close");
  assert.equal(bridged.position, open, "the guard acts on the position the engine reasoned about");
}

console.log("agent policy checks passed");
