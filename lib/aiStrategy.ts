import type { Asset } from "./assets";
import { gonkaApiKey, gonkaBaseUrl } from "./gonkaConfig";
import { STRATEGY_CATALOG, type SentimentBucket } from "./strategy";

export type AiStrategySuggestion = {
  sentiment: SentimentBucket;
  strategyId: string;
  rationale: string;
  confidence: number;
  model: string;
};

type MarketInput = {
  asset: Asset;
  spot: number;
  score: number;
  regime: string;
  netGexUsd: number;
  avgIv: number | null;
  flipStrike: number | null;
};

const MODEL = process.env.GONKAROUTER_MODEL ?? "deepseek-ai/DeepSeek-V4-Flash-0731";
const TIMEOUT_MS = 20_000;
const sentiments = new Set<SentimentBucket>(["bullish", "bearish", "highVol", "lowVol"]);
const strategyIds = new Set(STRATEGY_CATALOG.map((strategy) => strategy.id));

export async function getAiStrategySuggestion(input: MarketInput): Promise<AiStrategySuggestion | null> {
  if (!gonkaApiKey) return null;
  const catalog = STRATEGY_CATALOG.map(({ id, name, sentiment, description }) => ({ id, name, sentiment, description }));
  try {
    const response = await fetch(`${gonkaBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${gonkaApiKey}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        max_tokens: 700,
        messages: [
          {
            role: "system",
            content: "You are an options strategy advisor. Pick exactly one catalog strategy for the supplied live dealer-gamma snapshot. Return only JSON: {\"sentiment\": \"bullish\"|\"bearish\"|\"highVol\"|\"lowVol\", \"strategyId\": catalog id, \"rationale\": <=200 characters, \"confidence\": number 0-1}. This is advisory only; never claim it can execute.",
          },
          { role: "user", content: JSON.stringify({ market: input, catalog }) },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const content = (await response.json())?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    const answer = content.includes("</think>") ? content.slice(content.lastIndexOf("</think>") + 8) : content;
    const match = answer.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    if (
      typeof parsed.sentiment !== "string" ||
      !sentiments.has(parsed.sentiment as SentimentBucket) ||
      typeof parsed.strategyId !== "string" ||
      !strategyIds.has(parsed.strategyId) ||
      !Number.isFinite(Number(parsed.confidence))
    ) return null;
    return {
      sentiment: parsed.sentiment as SentimentBucket,
      strategyId: parsed.strategyId,
      rationale: String(parsed.rationale ?? "").slice(0, 200),
      confidence: Math.min(1, Math.max(0, Number(parsed.confidence))),
      model: MODEL,
    };
  } catch {
    return null;
  }
}
