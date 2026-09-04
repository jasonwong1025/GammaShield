import type { Asset } from "./assets";
import { gonkaApiKey, gonkaBaseUrl } from "./gonkaConfig";
import type { SentimentBucket } from "./strategy";

export type AiStrategySuggestion = {
  sentiment: SentimentBucket;
  strategyId: string;
  rationale: string;
  confidence: number;
  /** A deterministic result is clearly labeled in the UI; it never claims a model produced it. */
  source: "gonka" | "deterministic";
  model: string | null;
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
const TIMEOUT_MS = 18_000;
const CACHE_MS = 45_000;
const SENTIMENT_BY_TOKEN = new Map<string, SentimentBucket>([
  ["bullish", "bullish"],
  ["bearish", "bearish"],
  ["highvol", "highVol"],
  ["highvolatility", "highVol"],
  ["lowvol", "lowVol"],
  ["lowvolatility", "lowVol"],
]);
const STRATEGY_FOR_SENTIMENT: Record<SentimentBucket, string> = {
  bullish: "strap",
  bearish: "strip",
  highVol: "straddle",
  lowVol: "long-butterfly",
};

const cache = new Map<string, { at: number; value: AiStrategySuggestion }>();
const inflight = new Map<string, Promise<AiStrategySuggestion>>();

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function cacheKey(input: MarketInput) {
  return [input.asset, Math.round(input.score / 5), input.regime, Math.round(input.netGexUsd / 10_000), input.avgIv?.toFixed(2) ?? "-"].join(":");
}

function deterministicSuggestion(input: MarketInput): AiStrategySuggestion {
  const sentiment: SentimentBucket =
    input.regime === "amplifying" ? "highVol" : input.netGexUsd > 0 ? "lowVol" : input.score >= 60 ? "bearish" : "bullish";
  return {
    sentiment,
    strategyId: STRATEGY_FOR_SENTIMENT[sentiment],
    rationale: "Deterministic market-structure mapping only; the reasoning model did not return before the advisory timeout.",
    confidence: 0,
    source: "deterministic",
    model: null,
  };
}

async function callGonka(input: MarketInput): Promise<AiStrategySuggestion | null> {
  if (!gonkaApiKey) return null;
  try {
    const response = await fetch(`${gonkaBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${gonkaApiKey}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        // Gonka documents 1024 as the minimum safe headroom for models with
        // reasoning output. We ask only for market stance, not a 12-way plan.
        max_tokens: 1024,
        messages: [
          {
            role: "system",
            content: "You are an options market-structure advisor. Return only JSON: {\"sentiment\": \"bullish\"|\"bearish\"|\"highVol\"|\"lowVol\", \"rationale\": string up to 200 characters, \"confidence\": number 0-1}. Do not mention execution or use markdown.",
          },
          { role: "user", content: JSON.stringify({ market: input }) },
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
    const sentiment = typeof parsed.sentiment === "string" ? SENTIMENT_BY_TOKEN.get(normalize(parsed.sentiment)) : undefined;
    const confidence = Number(parsed.confidence);
    if (!sentiment || !Number.isFinite(confidence)) return null;
    return {
      sentiment,
      strategyId: STRATEGY_FOR_SENTIMENT[sentiment],
      rationale: String(parsed.rationale ?? "").slice(0, 200),
      confidence: Math.min(1, Math.max(0, confidence)),
      source: "gonka",
      model: MODEL,
    };
  } catch {
    return null;
  }
}

export async function getAiStrategySuggestion(input: MarketInput): Promise<AiStrategySuggestion> {
  const key = cacheKey(input);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const pending = inflight.get(key);
  if (pending) return pending;
  const request = callGonka(input).then((result) => result ?? deterministicSuggestion(input));
  inflight.set(key, request);
  try {
    const result = await request;
    if (result.source === "gonka") cache.set(key, { at: Date.now(), value: result });
    return result;
  } finally {
    inflight.delete(key);
  }
}
