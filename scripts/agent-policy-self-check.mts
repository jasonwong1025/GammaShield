// Self-check for the AI agent's action model (lib/agentPolicy.ts). Pure, no
// network. Run with `npm run check:agent`.
//
// The properties that matter are the safety ones: the derived caps must never
// round up past what the user typed, the toggles and the AI must only ever
// subtract, and an action the deployment cannot execute must never resolve.

import assert from "node:assert/strict";
import {
  ACTION_LABEL,
  AGENT_ACTIONS,
  DEFAULT_AGENT_LIMITS,
  MIN_UNIT,
  NOTIONAL_STRIKE_HEADROOM,
  ROLL_WINDOW_SECONDS,
  agentActionAvailability,
  deriveMandateCaps,
  deterministicIntent,
  fillExceedsNotionalCap,
  floor6,
  isActionArmed,
  notionalUsd,
  resolveAgentAction,
  toUnitString,
  type AgentLimits,
  type GateState,
} from "../lib/agentPolicy.ts";

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

// --- the rule-based gate: one distinct trigger per action ---
{
  const now = 1_800_000_000;
  const position = { positionId: 0, expiryTs: now + 30 * 86_400, contracts: 0.5 };
  const state = (over: Partial<GateState> = {}): GateState =>
    ({ riskScore: 80, threshold: 75, persistenceMet: true, positions: [], now, ...over });

  assert.equal(deterministicIntent(state()).action, "hedge", "hot, persisted, nothing open");
  assert.equal(deterministicIntent(state({ persistenceMet: false })).action, "hold", "persistence still required");
  assert.equal(deterministicIntent(state({ riskScore: 74 })).action, "hold", "cold with nothing open");
  assert.equal(deterministicIntent(state({ positions: [position] })).action, "hold", "already hedged");

  // Cold risk with a position open is the close trigger.
  const closing = deterministicIntent(state({ riskScore: 74, positions: [position] }));
  assert.equal(closing.action, "close");
  assert.equal(closing.position, position);

  // Roll fires only inside the window AND only while risk is still hot: a
  // hedge that is no longer needed is left to expire, never rolled.
  const expiring = { ...position, expiryTs: now + ROLL_WINDOW_SECONDS - 60 };
  assert.equal(deterministicIntent(state({ positions: [expiring] })).action, "roll", "hot near expiry rolls");
  assert.equal(deterministicIntent(state({ riskScore: 74, positions: [expiring] })).action, "close", "cold near expiry does not roll");
  assert.equal(
    deterministicIntent(state({ persistenceMet: false, positions: [expiring] })).action,
    "hold",
    "a roll still needs persisted risk",
  );
  // The nearest expiry is the one that gets rolled.
  const far = { positionId: 1, expiryTs: now + ROLL_WINDOW_SECONDS - 10, contracts: 1 };
  assert.equal(deterministicIntent(state({ positions: [far, expiring] })).position, expiring, "rolls the nearest leg");
}

// --- resolution: toggles, availability and the AI can only subtract ---
{
  const now = 1_800_000_000;
  const intent = deterministicIntent({ riskScore: 80, threshold: 75, persistenceMet: true, positions: [], now });
  const sepolia = agentActionAvailability(limits(), "sepolia", 2);
  const base = { intent, availability: sepolia, maxContracts: 0.005 };

  const clean = resolveAgentAction({ ...base, proposal: null });
  assert.equal(clean.action, "hedge");
  near(clean.contracts, 0.005, 0, "no proposal leaves the size alone");
  assert.equal(clean.aiRationale, null, "no AI, no rationale");

  // Unavailable and switched-off both collapse to hold, each with its reason.
  const onMainnet = resolveAgentAction({
    intent: deterministicIntent({ riskScore: 70, threshold: 75, persistenceMet: true, positions: [{ positionId: 0, expiryTs: now + 1000, contracts: 1 }], now }),
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

  // The AI may shrink.
  const smaller = resolveAgentAction({ ...base, proposal: { action: "hedge", contracts: 0.002, rationale: "thin book" } });
  near(smaller.contracts, 0.002, 0, "AI shrank the size");
  assert.equal(smaller.aiRationale, "thin book");

  // The AI may not grow.
  const bigger = resolveAgentAction({ ...base, proposal: { action: "hedge", contracts: 5, rationale: "go big" } });
  near(bigger.contracts, 0.005, 0, "AI cannot raise the size");

  // The AI may stand down.
  assert.equal(resolveAgentAction({ ...base, proposal: { action: "hold", contracts: 0, rationale: "spread too wide" } }).action, "hold");

  // The AI may not swap one action for another, even a cheaper one.
  const swapped = resolveAgentAction({ ...base, proposal: { action: "close", contracts: 1, rationale: "prefer an exit" } });
  assert.equal(swapped.action, "hold", "AI cannot choose a different action");
  assert.ok(swapped.notes.some((note) => note.includes("may only narrow")), "the refusal is explained");

  // A dust-sized proposal stands the agent down rather than sending dust.
  assert.equal(resolveAgentAction({ ...base, proposal: { action: "hedge", contracts: 1e-9, rationale: "tiny" } }).action, "hold");

  // A close is all-or-nothing; the AI cannot part-close.
  const open = { positionId: 0, expiryTs: now + 5 * 86_400, contracts: 0.4 };
  const closing = resolveAgentAction({
    intent: deterministicIntent({ riskScore: 70, threshold: 75, persistenceMet: true, positions: [open], now }),
    availability: sepolia,
    maxContracts: 0.005,
    proposal: { action: "close", contracts: 0.1, rationale: "half out" },
  });
  assert.equal(closing.action, "close");
  near(closing.contracts, 0.4, 0, "a close is always the full position");
}

console.log("agent policy checks passed");
