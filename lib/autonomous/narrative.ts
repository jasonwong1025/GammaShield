// Plain-language narration of a decision the engine has already made.
//
// This is the AI's ONLY job in the position-strategy panel. The action, the
// rejected alternatives and every number come from lib/autonomous/decision.ts
// before this runs; the model is handed the finished verdict and asked to say
// it in a sentence or two a person can act on.
//
// It cannot change the answer, and that is structural rather than a rule it is
// asked to follow: this returns a string, not an action, so there is nothing
// for a wrong or compromised model to flip. Compare ./proposal.ts, which does
// return an action and therefore needs `resolveAgentAction` to re-check every
// bound on the way back.
//
// Any failure — no key, timeout, malformed reply — returns null, and the panel
// falls back to the engine's own explanation. A missing narrative costs a
// nicer sentence and nothing else.

import "server-only";

import { gonkaApiKey, gonkaBaseUrl } from "../gonkaConfig";
import type { AutonomousDecision, TradingThesis } from "./types";

const TIMEOUT_MS = 12_000;
const MAX_CHARS = 320;

export type NarrativeContext = {
  asset: string;
  isCall: boolean;
  strike: number;
  spot: number;
  contracts: number;
  daysToExpiry: number;
  /** Market-maker bid for the whole position, USD. Null when unpriceable. */
  exitValueUsd: number | null;
  positionRiskScore: number | null;
  bookRiskScore: number;
  thesis: TradingThesis | null;
  decision: AutonomousDecision;
  /** Whether anything here can actually execute the chosen action. */
  executable: boolean;
};

const SYSTEM = [
  "You explain an options position-management verdict that has ALREADY been decided by a deterministic engine.",
  "Your only job is to restate it in plain language for the position's owner. Do not change the action, do not propose a different one, and do not add numbers that are not given to you.",
  "Two to three sentences, under 320 characters, second person, no preamble, no markdown, no bullet points.",
  "Lead with what to do and the single most important reason. If the action cannot be executed here, say plainly that they have to act on it themselves.",
  "Never claim the position is safe or guaranteed, and never give financial advice framed as certainty.",
].join(" ");

export async function narrateDecision(context: NarrativeContext): Promise<{ text: string; model: string } | null> {
  if (!gonkaApiKey) return null;
  const model = process.env.GONKAROUTER_MODEL ?? "deepseek-ai/DeepSeek-V4-Flash-0731";
  try {
    const response = await fetch(`${gonkaBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${gonkaApiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 512,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: JSON.stringify({
              verdict: context.decision.action,
              why: context.decision.reason,
              urgency: context.decision.urgency,
              reasonCodes: context.decision.reasonCodes,
              rejected: context.decision.alternatives.map((entry) => `${entry.action}: ${entry.rejected}`),
              position: {
                asset: context.asset,
                type: context.isCall ? "call" : "put",
                strike: context.strike,
                spot: context.spot,
                contracts: context.contracts,
                daysToExpiry: Number(context.daysToExpiry.toFixed(1)),
              },
              exitValueUsd: context.exitValueUsd,
              positionRiskScore: context.positionRiskScore,
              bookRiskScore: context.bookRiskScore,
              recordedView: context.thesis && {
                direction: context.thesis.direction,
                objective: context.thesis.objective,
                targetPrice: context.thesis.targetPrice,
              },
              canExecuteHere: context.executable,
            }),
          },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const content: unknown = (await response.json())?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    // Reasoning models sometimes wrap the answer; keep the prose only.
    const text = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim().slice(0, MAX_CHARS);
    return text.length > 0 ? { text, model } : null;
  } catch {
    return null;
  }
}
