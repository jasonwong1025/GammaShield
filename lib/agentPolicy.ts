// The AI agent's action model: which predefined actions exist, which ones this
// deployment can actually execute, and how a user's plain-language limits turn
// into the immutable terms their wallet signs.
//
// Everything here is pure. It runs unchanged in the browser (to show a user
// what they are about to sign) and on the server (to bound what the agent may
// do), so the two can never disagree about a limit.
//
// Three things this file is deliberately strict about:
//
//   1. Availability is not the same as permission. `hedge` executes on Base
//      mainnet; `close` and `roll` exist only against GammaShield's own Base
//      Sepolia shadow book. An action the deployment cannot perform is reported
//      unavailable with a reason, never quietly ignored.
//   2. The toggles narrow, they never widen. A registered policy already
//      permits every action its network supports; switching one off is an
//      off-chain restriction on top. The on-chain off switch is pause/revoke.
//   3. The AI can only subtract. It picks among the actions the deterministic
//      gate has already cleared, and may shrink the size or stand down. It can
//      never introduce an action, raise a size, or bypass the risk gate.

import type { OptionsAsset } from "./assets";

export const AGENT_ACTIONS = ["hedge", "close", "roll"] as const;
export type AgentAction = (typeof AGENT_ACTIONS)[number];
/** What the agent does when no action clears every gate. */
export type AgentDecision = AgentAction | "hold";

/** Strike ceiling, as a multiple of spot, used to turn a notional cap into the
 *  signed per-fill contract cap. Notional is contracts x strike, and the signed
 *  mandate bounds contracts, not strike — so the conversion needs a strike the
 *  agent will never exceed. A protective put more than 25% in the money is not
 *  a hedge this agent selects, and the exact notional is re-checked against the
 *  real strike before every fill. */
export const NOTIONAL_STRIKE_HEADROOM = 1.25;
/** How close to expiry a position has to be before a roll is considered. */
export const ROLL_WINDOW_SECONDS = 24 * 3600;
/** Smallest size the signed mandate can express: USDC and contracts are 6dp. */
export const MIN_UNIT = 1e-6;

export type AgentLimits = {
  asset: OptionsAsset;
  /** "Maximum loss" — for a bought option this is exactly the premium at risk. */
  maxLossUsd: number;
  /** "Do not execute trades above" — contract notional, not premium. */
  maxTradeNotionalUsd: number;
  actions: Record<AgentAction, boolean>;
};

export const DEFAULT_AGENT_LIMITS: AgentLimits = {
  asset: "ETH",
  maxLossUsd: 800,
  maxTradeNotionalUsd: 500,
  actions: { hedge: true, close: true, roll: true },
};

export const ACTION_LABEL: Record<AgentAction, string> = {
  hedge: "Auto-Hedge",
  close: "Auto-Close",
  roll: "Auto-Roll",
};

export const ACTION_DESCRIPTION: Record<AgentAction, string> = {
  hedge: "Buy a protective put when book risk stays above the trigger.",
  close: "Sell the hedge back once book risk falls under the trigger again.",
  roll: "At expiry, replace the hedge only if risk is still above the trigger.",
};

/** Per-action execution capability of one deployment. */
export type ActionAvailability = {
  action: AgentAction;
  /** The user's toggle. */
  enabled: boolean;
  /** Whether this deployment can execute it at all. */
  available: boolean;
  /** Why not, in plain language. Null when available. */
  reason: string | null;
};

export type NetworkKind = "mainnet" | "sepolia";

const MAINNET_UNAVAILABLE =
  "Base mainnet executes one signed action — a protective put on the Thetanuts OptionBook. Exiting and rolling a live Thetanuts position have no adapter in this policy account.";
const SHADOW_OUTDATED =
  "The deployed Base Sepolia shadow book predates close support. Redeploy ShadowOptionBook and MandateAccount to enable it.";

/**
 * What a deployment can do. `shadowBookVersion` is read from the deployed
 * ShadowOptionBook: version 2 added `closeShadow`, and an older deployment has
 * no such function, so a failed read is reported as fill-only rather than
 * assumed to work.
 */
export function agentActionAvailability(
  limits: AgentLimits,
  network: NetworkKind,
  shadowBookVersion: number | null,
): ActionAvailability[] {
  return AGENT_ACTIONS.map((action) => {
    const enabled = limits.actions[action];
    if (action === "hedge") return { action, enabled, available: true, reason: null };
    if (network === "mainnet") return { action, enabled, available: false, reason: MAINNET_UNAVAILABLE };
    if ((shadowBookVersion ?? 1) < 2) return { action, enabled, available: false, reason: SHADOW_OUTDATED };
    return { action, enabled, available: true, reason: null };
  });
}

export const isActionArmed = (availability: ActionAvailability[], action: AgentAction): boolean =>
  availability.some((entry) => entry.action === action && entry.enabled && entry.available);

/** The immutable numbers a wallet signs, derived from the five plain limits. */
export type DerivedCaps = {
  maxPremiumTotal: number;
  maxPremiumPerFill: number;
  maxContractsPerFill: number;
  /** Highest strike at which the signed contract cap still holds the notional. */
  strikeCeiling: number;
};

export function deriveMandateCaps(limits: AgentLimits, spot: number): DerivedCaps {
  if (!(spot > 0) || !Number.isFinite(spot)) throw new Error("a live spot price is required to size the policy");
  if (!(limits.maxLossUsd > 0) || !(limits.maxTradeNotionalUsd > 0)) throw new Error("limits must be positive");

  const strikeCeiling = spot * NOTIONAL_STRIKE_HEADROOM;
  const maxContractsPerFill = floor6(limits.maxTradeNotionalUsd / strikeCeiling);
  if (maxContractsPerFill < MIN_UNIT) {
    throw new Error(
      `a ${usd(limits.maxTradeNotionalUsd)} trade cap is smaller than the smallest expressible size at this price`,
    );
  }
  // A bought put's premium is always below its own notional, so the notional
  // cap already bounds one fill's cost; this records the tighter of the two.
  const maxPremiumPerFill = floor6(Math.min(limits.maxLossUsd, limits.maxTradeNotionalUsd));
  return {
    maxPremiumTotal: floor6(limits.maxLossUsd),
    maxPremiumPerFill,
    maxContractsPerFill,
    strikeCeiling,
  };
}

/** Exact notional of a real, quoted fill — the check the signed contract cap approximates. */
export const notionalUsd = (contracts: number, strike: number) => contracts * strike;

export function fillExceedsNotionalCap(limits: AgentLimits, contracts: number, strike: number): boolean {
  return notionalUsd(contracts, strike) > limits.maxTradeNotionalUsd + 1e-9;
}

export type OpenPosition = { positionId: number; expiryTs: number; contracts: number };

export type GateState = {
  riskScore: number;
  threshold: number;
  /** Whether the on-chain risk observation has held above the trigger long enough. */
  persistenceMet: boolean;
  positions: OpenPosition[];
  now: number;
};

export type DeterministicIntent = {
  action: AgentDecision;
  /** The position an exit or roll would act on. */
  position: OpenPosition | null;
  reason: string;
};

/**
 * The rule-based decision, before any toggle, availability check or AI opinion.
 * Each action has its own distinct trigger:
 *
 *   hedge — risk is above the trigger and has stayed there, and nothing is open.
 *   close — risk has fallen back under the trigger, so the hedge is spare.
 *   roll  — a hedge is about to expire and risk is STILL above the trigger.
 *           If risk has cooled, the position is left to expire instead.
 */
export function deterministicIntent(state: GateState): DeterministicIntent {
  const hot = state.riskScore >= state.threshold;
  const expiring = [...state.positions]
    .filter((position) => position.expiryTs - state.now <= ROLL_WINDOW_SECONDS)
    .sort((a, b) => a.expiryTs - b.expiryTs)[0] ?? null;

  if (!hot) {
    const open = state.positions[0] ?? null;
    if (!open) return { action: "hold", position: null, reason: "Risk is under the trigger and nothing is open." };
    return { action: "close", position: open, reason: "Risk fell back under the trigger, so the hedge is spare." };
  }
  if (!state.persistenceMet) {
    return { action: "hold", position: null, reason: "Risk is above the trigger but has not held there long enough." };
  }
  if (expiring) {
    return { action: "roll", position: expiring, reason: "The open hedge expires soon and risk is still above the trigger." };
  }
  if (state.positions.length > 0) {
    return { action: "hold", position: state.positions[0], reason: "Risk is above the trigger and a hedge is already open." };
  }
  return { action: "hedge", position: null, reason: "Risk has held above the trigger with nothing open." };
}

/** What the AI returns. Advisory: every field is a request to do LESS. */
export type AgentProposal = {
  action: AgentDecision;
  contracts: number;
  rationale: string;
};

export type ResolvedAction = {
  action: AgentDecision;
  contracts: number;
  position: OpenPosition | null;
  /** Every reason the decision landed where it did, most specific first. */
  notes: string[];
  /** Set when the AI narrowed the rule-based decision. */
  aiRationale: string | null;
};

/**
 * Intersect the rule-based intent with the user's toggles, what the deployment
 * can execute, and the AI's opinion.
 *
 * The AI may agree, shrink the size, or stand the agent down. It may not swap
 * one action for another, raise a size, or revive an action the gate, the
 * toggles or the deployment ruled out — an unreachable proposal collapses to
 * `hold`. A missing or unparsable proposal changes nothing: the rule-based
 * decision stands, exactly as it does when no AI is configured.
 */
export function resolveAgentAction({
  intent,
  availability,
  maxContracts,
  proposal,
}: {
  intent: DeterministicIntent;
  availability: ActionAvailability[];
  maxContracts: number;
  proposal: AgentProposal | null;
}): ResolvedAction {
  const notes = [intent.reason];
  const hold = (note: string): ResolvedAction => {
    notes.push(note);
    return { action: "hold", contracts: 0, position: intent.position, notes, aiRationale: null };
  };

  if (intent.action === "hold") return { action: "hold", contracts: 0, position: intent.position, notes, aiRationale: null };

  const entry = availability.find((value) => value.action === intent.action);
  if (!entry?.available) return hold(entry?.reason ?? `${ACTION_LABEL[intent.action]} is not available here.`);
  if (!entry.enabled) return hold(`${ACTION_LABEL[intent.action]} is switched off.`);

  let contracts = intent.action === "close" ? (intent.position?.contracts ?? 0) : maxContracts;
  if (!(contracts > 0)) return hold("The signed limits leave no executable size.");

  let aiRationale: string | null = null;
  if (proposal) {
    if (proposal.action === "hold") return hold(`The AI stood the agent down: ${proposal.rationale}`);
    if (proposal.action !== intent.action) {
      return hold(
        `The AI asked for ${ACTION_LABEL[proposal.action]} where the risk gate cleared ${ACTION_LABEL[intent.action]}; it may only narrow, so nothing ran.`,
      );
    }
    // A close is all-or-nothing: the book takes full exits only.
    if (intent.action !== "close" && Number.isFinite(proposal.contracts) && proposal.contracts < contracts) {
      if (proposal.contracts < MIN_UNIT) return hold(`The AI sized this below the executable minimum: ${proposal.rationale}`);
      const before = contracts;
      contracts = floor6(proposal.contracts);
      notes.push(`The AI narrowed the size from ${trim(before)} to ${trim(contracts)} contracts.`);
    }
    aiRationale = proposal.rationale || null;
  }

  return { action: intent.action, contracts, position: intent.position, notes, aiRationale };
}

/** Round DOWN to the 6dp the mandate and USDC both use, so no derived cap ever
 *  rounds up past what the user typed. */
export function floor6(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value * 1e6) / 1e6;
}

/** 6dp decimal string for the EIP-712 `parseUnits` path, without a trailing dot. */
export const toUnitString = (value: number): string => floor6(value).toFixed(6).replace(/\.?0+$/, "") || "0";

const trim = (value: number) => Number(value.toPrecision(4)).toString();
const usd = (value: number) => `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
