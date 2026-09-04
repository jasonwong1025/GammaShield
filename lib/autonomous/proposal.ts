// The AI half of the AI agent.
//
// It is asked one question each cycle: given the action the deterministic risk
// gate has already cleared, should the agent do it, do less of it, or stand
// down? It cannot raise a size or reach past the gate — ./policy.ts enforces
// that on the way back, so a compromised or simply wrong model can only ever
// make the agent do less.
//
// It has exactly one power to ADD something: it may call for a close when it
// judges the position's thesis broken. A thesis is a human judgement about
// why a position exists, and no threshold captures it, so this is the one
// place the model's opinion can start an action rather than shrink one. It is
// bounded to a full-size close of an already-open position, on an armed
// deployment, with a stated reason — ./policy.ts checks every one of those.
//
// A missing key, a timeout, a malformed reply: all of them return null, which
// means "no opinion" and leaves the deterministic decision exactly as it was.
// The agent is never blocked on the model being reachable.

import "server-only";

import { gonkaApiKey, gonkaBaseUrl } from "../gonkaConfig";
import { ACTION_LABEL, type AgentAction, type AgentProposal } from "./policy";

const TIMEOUT_MS = 12_000;

export type ProposalContext = {
  asset: string;
  action: AgentAction;
  /** The largest size the signed limits and the book allow right now. */
  maxContracts: number;
  riskScore: number;
  threshold: number;
  regime: string;
  netGexUsd: number;
  spot: number;
  openPositions: { strike: number; expiryTs: number; contracts: number; pnlUsd: number | null }[];
  /** Per-contract risk of the open position and its own trigger, on the
   *  four-component scale a held position is scored on. Null when nothing is
   *  open or the position could not be priced. */
  positionRiskScore: number | null;
  positionThreshold: number;
  /** Risk trend in points, already measured — never asked of the model. Null
   *  entries mean the history is too short, not that risk is flat. */
  trend: { oneHour: number | null; sixHours: number | null; twentyFourHours: number | null };
  /** The recorded view behind the position, and whether deterministic rules
   *  already consider it broken. Null when no thesis was ever recorded. */
  thesis: {
    direction: string;
    objective: string;
    targetPrice: number | null;
    referenceSpot: number | null;
    horizonEndsAt: number | null;
    note: string | null;
    deterministicVerdict: string;
  } | null;
  /** True when close is armed here, so the model is not invited to call for an
   *  exit this deployment cannot make. */
  closeArmed: boolean;
};

const SYSTEM = [
  "You supervise a crypto options position-management agent that has already passed its own deterministic risk gate.",
  "Normally you may only reduce what it is about to do: you cannot increase a size or approve anything the gate refused.",
  'Reply with JSON only: {"action":"<the cleared action>|hold|close","contracts":number,"rationale":string <=200 chars,"thesisBroken":boolean}.',
  'Use "hold" when the trade looks poor despite the gate — thin liquidity, a size that is pointless, an already-adequate hedge.',
  "contracts must be at or below maxContracts. Anything larger is ignored.",
  'The ONE exception: if an open position\'s recorded thesis is genuinely broken — the reason it was opened no longer applies — you may answer "close" with thesisBroken true and say why, even if the gate cleared something else. Only a close. Never a hedge or a roll.',
  "Do not claim a broken thesis because the position is losing money, because risk is elevated, or because expiry is near. A bought option's loss is capped at its premium and those facts are already scored. Claim it only when the view itself no longer applies.",
  "If closeArmed is false, do not call for a close.",
].join(" ");

export async function proposeAgentAction(context: ProposalContext): Promise<AgentProposal | null> {
  if (!gonkaApiKey) return null;
  try {
    const response = await fetch(`${gonkaBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${gonkaApiKey}` },
      body: JSON.stringify({
        model: process.env.GONKAROUTER_MODEL ?? "deepseek-ai/DeepSeek-V4-Flash-0731",
        temperature: 0.1,
        // Gonka's reasoning models need room to reason before emitting JSON.
        max_tokens: 1024,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: JSON.stringify({
              clearedAction: context.action,
              clearedActionMeans: ACTION_LABEL[context.action],
              maxContracts: context.maxContracts,
              asset: context.asset,
              spot: context.spot,
              bookRiskScore: context.riskScore,
              riskTrigger: context.threshold,
              dealerRegime: context.regime,
              netGexUsdPer1PctMove: context.netGexUsd,
              openPositions: context.openPositions,
              positionRiskScore: context.positionRiskScore,
              positionRiskTrigger: context.positionThreshold,
              riskTrendPoints: context.trend,
              thesis: context.thesis,
              closeArmed: context.closeArmed,
            }),
          },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const content: string | undefined = (await response.json())?.choices?.[0]?.message?.content;
    const match = content?.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as {
      action?: unknown;
      contracts?: unknown;
      rationale?: unknown;
      thesisBroken?: unknown;
    };

    const thesisBroken = parsed.thesisBroken === true;
    // The cleared action, a stand-down, or a thesis-break close: nothing else
    // is a legal answer. Anything else becomes a stand-down rather than being
    // silently ignored, because a model asking for something it was not
    // offered is not a model to act on. policy.ts re-checks every bound on the
    // close path; passing it through here does not authorise it.
    const requestedClose = parsed.action === "close" && thesisBroken && context.closeArmed;
    const action = parsed.action === context.action ? context.action : requestedClose ? "close" : "hold";
    const contracts = typeof parsed.contracts === "number" && Number.isFinite(parsed.contracts) ? parsed.contracts : context.maxContracts;
    const rationale = typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 200) : "";
    return { action, contracts, rationale, thesisBroken };
  } catch {
    return null;
  }
}
