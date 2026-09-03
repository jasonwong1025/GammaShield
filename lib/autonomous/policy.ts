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
//   3. The AI can only subtract, with ONE bounded exception. It picks among
//      the actions the deterministic gate has already cleared, and may shrink
//      the size or stand down. It may never raise a size or bypass the risk
//      gate.
//
//      The exception: it may INITIATE A CLOSE, and only a close, when it
//      judges the position's thesis broken for a reason no deterministic rule
//      here covers. That is a deliberate reversal of the old "never
//      introduce an action" rule, made because a thesis is a human judgement
//      that cannot be reduced to a threshold — and it is bounded hard:
//
//        - close only; a proposed hedge or roll the gate did not clear is
//          still refused outright,
//        - a position must actually be open and close must be armed,
//        - the model must say the thesis is broken and say why,
//        - the size is the whole position, never a number the model chose,
//        - and on Base mainnet, where no exit adapter exists, the result is a
//          recommendation the user executes rather than an autonomous fill.
//
//      Everything downstream is unchanged: the signed mandate, the account's
//      own validation, and the exit-mark checks all still apply.

import type { OptionsAsset } from "../assets";

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
/** Default trigger for the PER-CONTRACT score that arms close and roll.
 *
 *  Deliberately lower than the book trigger. A held position is scored on four
 *  components rather than six — this venue publishes no implied vol for a
 *  position, so the IV and time-decay components drop and the rest
 *  renormalize — so the two numbers are not on the same scale. 70 is the
 *  bottom of contractRisk's "high" band. */
export const DEFAULT_POSITION_RISK_TRIGGER = 70;

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

/**
 * The intended action, as the decision engine produced it. Kept as its own
 * shape so the engine (./decision.ts) and this guard stay independently
 * testable: the engine decides WHAT, the guard decides whether it is allowed.
 */
export type DeterministicIntent = {
  action: AgentDecision;
  /** The position an exit or roll would act on. */
  position: OpenPosition | null;
  reason: string;
};

/** What the AI returns. Every field is a request to do less, except
 *  `thesisBroken`, which is the one claim that can initiate a close. */
export type AgentProposal = {
  action: AgentDecision;
  contracts: number;
  rationale: string;
  /** The model's claim that the view behind the position no longer holds.
   *  Only meaningful alongside `action: "close"`, and only ever unlocks a
   *  close — never a hedge or a roll. */
  thesisBroken?: boolean;
};

export type ResolvedAction = {
  action: AgentDecision;
  contracts: number;
  position: OpenPosition | null;
  /** Every reason the decision landed where it did, most specific first. */
  notes: string[];
  /** Set when the AI narrowed the rule-based decision. */
  aiRationale: string | null;
  /** True only when the AI initiated this action rather than narrowing one.
   *  By construction this can only ever be a close. */
  aiInitiated: boolean;
};

/**
 * Intersect the rule-based intent with the user's toggles, what the deployment
 * can execute, and the AI's opinion.
 *
 * The AI may agree, shrink the size, or stand the agent down. It may not raise
 * a size, and it may not revive an action the gate, the toggles or the
 * deployment ruled out — those still collapse to `hold`. It may swap in
 * exactly one action it was not offered: a close, on a stated thesis break.
 * See invariant 3 at the top of this file for why, and for the bounds.
 *
 * A missing or unparsable proposal changes nothing: the rule-based decision
 * stands, exactly as it does when no AI is configured.
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
    return { action: "hold", contracts: 0, position: intent.position, notes, aiRationale: null, aiInitiated: false };
  };

  // The one action the AI may introduce. Checked before the intent is
  // resolved, because by definition the gate did not clear it.
  const initiated = resolveThesisClose({ intent, availability, proposal, notes });
  if (initiated) return initiated;

  if (intent.action === "hold") {
    return { action: "hold", contracts: 0, position: intent.position, notes, aiRationale: null, aiInitiated: false };
  }

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

  return { action: intent.action, contracts, position: intent.position, notes, aiRationale, aiInitiated: false };
}

/**
 * The bounded exception to "the AI can only subtract": a close the
 * deterministic gate did not select, on a stated thesis break.
 *
 * Returns null whenever any bound fails, so the caller falls through to the
 * ordinary narrowing path and the model's request simply has no effect. Every
 * refusal is written into `notes`, because a proposal that was silently
 * dropped is indistinguishable from one that was never made.
 */
function resolveThesisClose({
  intent,
  availability,
  proposal,
  notes,
}: {
  intent: DeterministicIntent;
  availability: ActionAvailability[];
  proposal: AgentProposal | null;
  notes: string[];
}): ResolvedAction | null {
  if (!proposal || proposal.action !== "close" || intent.action === "close") return null;

  // A thesis break is a claim about a position. Without one there is nothing
  // to close, and this is not a route to opening anything.
  if (!intent.position) {
    notes.push("The AI asked to close on a thesis break, but no position is open.");
    return null;
  }
  if (!proposal.thesisBroken) {
    notes.push(
      `The AI asked for ${ACTION_LABEL.close} where the gate cleared ${
        intent.action === "hold" ? "no action" : ACTION_LABEL[intent.action]
      }, without claiming the view had broken; only a stated thesis break can initiate a close.`,
    );
    return null;
  }
  if (!proposal.rationale?.trim()) {
    notes.push("The AI claimed a thesis break but gave no reason, so it was not acted on.");
    return null;
  }

  const entry = availability.find((value) => value.action === "close");
  if (!entry?.available) {
    notes.push(entry?.reason ?? `${ACTION_LABEL.close} is not available here.`);
    return null;
  }
  if (!entry.enabled) {
    notes.push(`${ACTION_LABEL.close} is switched off, so the AI's thesis break could not be acted on.`);
    return null;
  }

  // Full size, always. The model does not get to choose how much of a broken
  // view to keep, and the book takes full exits only.
  const contracts = intent.position.contracts;
  if (!(contracts > 0)) {
    notes.push("The open position has no closeable size.");
    return null;
  }

  notes.push(`The AI initiated a close on a thesis break: ${proposal.rationale.trim()}`);
  return {
    action: "close",
    contracts,
    position: intent.position,
    notes,
    aiRationale: proposal.rationale.trim(),
    aiInitiated: true,
  };
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
