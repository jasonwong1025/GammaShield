// Plain-English Options & Risk Knowledge Engine for GammaShield.
// Features automatic multi-tier failover: MiniMax-M2.7 -> DeepSeek Flash -> Local Knowledge.

import { gonkaApiKey, gonkaBaseUrl } from "./gonkaConfig";
import { GONKA_MODELS } from "./gonka";

export type KnowledgeRequest = {
  question: string;
  asset: string;
  spotPrice: number;
  score: number;
  netGexUsd?: number;
  regime?: "dampening" | "amplifying" | "neutral";
  flipStrike?: number | null;
};

export type KnowledgeResult = {
  summary: string;
  analogy: string;
  explanation: string;
  takeaway: string;
  liveContext?: string | null;
  source: "ai" | "deterministic";
  modelUsed?: string | null;
};

/**
 * Extracts clean JSON from LLM outputs, stripping <think> tags if present.
 */
function extractJson<T>(raw: string): T {
  let cleaned = raw.replace(/<think[\s\S]*?<\/think>/gi, "");
  const danglingThink = cleaned.search(/<think\b/i);
  if (danglingThink !== -1) cleaned = cleaned.slice(0, danglingThink);
  cleaned = cleaned.trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Model returned no complete JSON response");
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

/**
 * Performs an HTTP call with a timeout.
 */
async function callModel(
  baseUrl: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  timeoutMs = 15_000,
): Promise<string> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HTTP ${res.status}: ${errText}`);
  }

  const json = await res.json();
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty model completion");
  return content;
}

/**
 * Answers options & risk questions in plain everyday English.
 * Follows an automatic fallback chain: MiniMax-M2.7 -> DeepSeek Flash -> Local Knowledge.
 */
export async function askOptionsKnowledge(params: KnowledgeRequest): Promise<KnowledgeResult> {
  const apiKey = gonkaApiKey;
  const baseUrl = gonkaBaseUrl;

  const systemPrompt = `You are the friendly, expert Options Knowledge Copilot in GammaShield on Base.
Your mission is to explain options concepts, Greeks, market risk, and gas fees in plain, everyday English that anyone can understand.

CRITICAL COMMUNICATION RULES:
1. Speak in clear, friendly, conversational English (high school reading level).
2. NEVER use dense academic math formulas or unexplained Greek notation.
3. Use relatable real-world analogies (cars, driving, insurance, highway tolls, rollercoasters).
4. GammaShield has TWO distinct risk scores:
   - Market / Book Fragility Score (0-100): Measures the whole options order book on Base. When high, dealers are short gamma, meaning market selloffs get accelerated.
   - Per-Contract / Position Risk Score (0-100): Measures a specific trade or position you hold, scored across 6 parts (Premium, IV, Time Decay, Liquidity, Market Regime, Expiry Proximity).
   If the user asks about the "risk score", distinguish these two clearly!
5. When relevant, connect your answer to the live market numbers provided in the user prompt (current spot price, risk score, regime).
6. CRITICAL: Output ONLY the raw JSON object directly. Do NOT output <think> tags or internal chain-of-thought.

OUTPUT FORMAT:
Output ONLY a valid JSON object matching this schema without any markdown formatting:
{
  "summary": "<1-2 sentence direct, punchy answer>",
  "analogy": "<A relatable real-world analogy explaining the core idea>",
  "explanation": "<2-3 short, clear sentences breaking down how it works in practice>",
  "takeaway": "<1-2 sentences of actionable advice for a trader>",
  "liveContext": "<1 sentence connecting the explanation to current live market data, or null if not applicable>"
}`;

  const userPrompt = `User question: "${params.question}"

Live Dashboard Context:
- Asset: ${params.asset}
- Live Spot Price: $${params.spotPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}
- Market Fragility Risk Score: ${params.score}/100
- Net Dealer GEX: $${(params.netGexUsd ?? 0).toLocaleString()} / 1% move
- Current Market Regime: ${params.regime ?? "neutral"}
- Gamma Flip Strike: ${params.flipStrike ? `$${params.flipStrike.toLocaleString()}` : "None"}`;

  // If API key is available, try the model chain
  if (apiKey && apiKey !== "sk-your-gonkarouter-api-key-here") {
    // 1. Primary: MiniMax-M2.7
    try {
      const rawMiniMax = await callModel(
        baseUrl,
        apiKey,
        GONKA_MODELS.PRIMARY,
        systemPrompt,
        userPrompt,
        25_000,
      );
      const parsed = extractJson<Omit<KnowledgeResult, "source" | "modelUsed">>(rawMiniMax);
      return {
        ...parsed,
        source: "ai",
        modelUsed: "MiniMax-M2.7",
      };
    } catch (err) {
      console.warn("[Knowledge Copilot] MiniMax failed, falling back to DeepSeek Flash:", err);

      // 2. Secondary Failover: DeepSeek Flash
      try {
        const rawDeepSeek = await callModel(
          baseUrl,
          apiKey,
          GONKA_MODELS.FLASH,
          systemPrompt,
          userPrompt,
          22_000,
        );
        const parsed = extractJson<Omit<KnowledgeResult, "source" | "modelUsed">>(rawDeepSeek);
        return {
          ...parsed,
          source: "ai",
          modelUsed: "DeepSeek Flash",
        };
      } catch (deepSeekErr) {
        console.warn("[Knowledge Copilot] DeepSeek failover also failed:", deepSeekErr);
      }
    }
  }

  // 3. Return a clean, honest plain-English error card rather than hardcoded content
  return {
    summary: "The AI models on the Gonka Network are temporarily busy or experiencing high queue latency.",
    analogy: "Like a temporary traffic jam on the network highway, the decentralized inference nodes took longer than expected to return a response.",
    explanation: `We attempted to reach ${GONKA_MODELS.PRIMARY} and ${GONKA_MODELS.FLASH}, but the request timed out. Your market data for ${params.asset} (Spot: $${params.spotPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}, Fragility Score: ${params.score}/100) is still actively streaming.`,
    takeaway: "Please wait a few seconds and click Ask again to retry the inference.",
    liveContext: `Live ${params.asset} market data remains fully active.`,
    source: "ai",
    modelUsed: "Gonka Gateway (Timeout)",
  };
}
