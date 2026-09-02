// The AI half of the AI agent.
//
// It is asked one question each cycle: given the action the deterministic risk
// gate has already cleared, should the agent do it, do less of it, or stand
// down? It cannot choose a different action, raise a size, or reach past the
// gate — lib/agentPolicy.ts enforces that on the way back, so a compromised or
// simply wrong model can only ever make the agent do less.
//
// A missing key, a timeout, a malformed reply: all of them return null, which
// means "no opinion" and leaves the deterministic decision exactly as it was.
// The agent is never blocked on the model being reachable.

import "server-only";

import { gonkaApiKey, gonkaBaseUrl } from "./gonkaConfig";
import { ACTION_LABEL, type AgentAction, type AgentProposal } from "./agentPolicy";

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
};

const SYSTEM = [
  "You supervise a crypto options hedging agent that has already passed its own deterministic risk gate.",
  "You may only reduce what it is about to do. You cannot pick a different action, increase the size, or approve anything the gate refused.",
  'Reply with JSON only: {"action":"<the same action>|hold","contracts":number,"rationale":string <=200 chars}.',
  'Use "hold" when the trade looks poor despite the gate — thin liquidity, a size that is pointless, an already-adequate hedge.',
  "contracts must be at or below maxContracts. Anything larger is ignored.",
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
    const parsed = JSON.parse(match[0]) as { action?: unknown; contracts?: unknown; rationale?: unknown };

    // Only the cleared action or a stand-down is a legal answer. Anything else
    // is treated as a stand-down rather than silently ignored, because a model
    // asking for something it was not offered is not a model to act on.
    const action = parsed.action === context.action ? context.action : "hold";
    const contracts = typeof parsed.contracts === "number" && Number.isFinite(parsed.contracts) ? parsed.contracts : context.maxContracts;
    const rationale = typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 200) : "";
    return { action, contracts, rationale };
  } catch {
    return null;
  }
}
