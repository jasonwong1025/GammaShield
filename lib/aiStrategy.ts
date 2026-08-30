// AI strategy suggestion via GonkaRouter's OpenAI-compatible chat/completions
// API — same pattern as lib/aiRisk.ts (bucketed cache, in-flight dedup,
// strict-JSON prompt, "any failure → null, never fabricate"). Given the
// current market-structure snapshot, the model picks one of the
// lib/strategy.ts catalog strategies. Manual-trigger only (see
// StrategyBuilder.tsx's "Suggest a Strategy" button) — this never auto-fires
// on a snapshot refresh.

import type { Asset } from "./assets";
import { STRATEGY_CATALOG, type SentimentBucket } from "./strategy";

export type AiStrategyInput = {
  asset: Asset;
  spot: number;
  score: number;
  regime: string;
  netGexUsd: number;
  avgIv: number | null;
  flipStrike: number | null;
};

export type AiStrategySuggestion = {
  sentiment: SentimentBucket;
  strategyId: string;
  rationale: string;
  confidence: number; // 0-1
  /** Up to 2 alternate strategy ids the model also considered. */
  runnerUps: string[];
  model: string;
  generatedAt: number;
};

const API_KEY = process.env.GONKAROUTER_API_KEY;
const BASE_URL = process.env.GONKAROUTER_BASE_URL ?? "https://api.gonkarouter.io/v1";
const MODEL = process.env.GONKAROUTER_MODEL ?? "deepseek-ai/DeepSeek-V4-Flash-0731";

const AI_CACHE_MS = 45_000;
const AI_TIMEOUT_MS = 20_000;
const SENTIMENT_IDS: SentimentBucket[] = ["bullish", "bearish", "highVol", "lowVol"];

// Match the model's answer to a real catalog id/sentiment even if it varies
// case or punctuation ("high_vol", "Bull-Call-Spread") — still only ever
// resolves to one of our own values, never accepts a token outside the
// catalog, so this doesn't loosen the "never fabricate" guarantee below.
function normalizeToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}
const SENTIMENT_BY_NORM = new Map(SENTIMENT_IDS.map((s) => [normalizeToken(s), s]));
const STRATEGY_BY_NORM = new Map(STRATEGY_CATALOG.map((s) => [normalizeToken(s.id), s.id]));

const cache = new Map<string, { at: number; suggestion: AiStrategySuggestion }>();
const inflight = new Map<string, Promise<AiStrategySuggestion | null>>();

function roundSig(n: number, sig: number): number {
  if (n === 0 || !Number.isFinite(n)) return 0;
  const mag = Math.pow(10, sig - Math.ceil(Math.log10(Math.abs(n))));
  return Math.round(n * mag) / mag;
}

function cacheKey(i: AiStrategyInput): string {
  const bucket5 = (n: number) => Math.round(n / 5) * 5;
  return [
    i.asset,
    bucket5(i.score),
    i.regime,
    roundSig(i.netGexUsd, 2),
    i.avgIv != null ? roundSig(i.avgIv, 2) : "-",
    i.flipStrike != null ? Math.round(i.flipStrike) : "-",
  ].join(":");
}

async function callGonkaRouter(input: AiStrategyInput): Promise<AiStrategySuggestion | null> {
  if (!API_KEY) {
    console.warn("[aiStrategy] GONKAROUTER_API_KEY not set — skipping AI strategy suggestion");
    return null;
  }

  const catalogSummary = STRATEGY_CATALOG.map((s) => ({
    id: s.id,
    name: s.name,
    sentiment: s.sentiment,
    description: s.description,
  }));

  const prompt = {
    asset: input.asset,
    spot: input.spot,
    dealerGammaScore: input.score,
    dealerGammaRegime: input.regime,
    netGexUsd: Math.round(input.netGexUsd),
    avgIv: input.avgIv != null ? Number(input.avgIv.toFixed(4)) : null,
    gammaFlipStrike: input.flipStrike,
    availableStrategies: catalogSummary,
  };

  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,
        // GonkaRouter can route to a reasoning model that spends tokens on a
        // <think>...</think> block before the answer — too small a budget
        // truncates mid-thought (finish_reason "length") with no JSON ever
        // emitted. Generous headroom so the final answer always has room.
        max_tokens: 1024,
        messages: [
          {
            role: "system",
            content:
              "You are an options strategy advisor for a dealer-gamma risk dashboard. Given the " +
              "current market-structure state for an asset and a fixed catalog of one-click option " +
              "strategies, pick the single strategy id that best fits the implied sentiment (bullish/" +
              "bearish/high-volatility/low-volatility) suggested by the dealer-gamma regime, net GEX, " +
              "and implied vol level. Respond with ONLY a JSON object — no prose, no markdown fences — " +
              'matching: {"sentiment": "bullish"|"bearish"|"highVol"|"lowVol", "strategyId": one of the ' +
              'given ids, "rationale": string (<=200 chars), "confidence": number 0-1, "runnerUps": ' +
              "array of 0-2 other strategy ids you also considered}. strategyId and every runnerUps " +
              "entry MUST be one of the ids in availableStrategies — never invent a new id.",
          },
          { role: "user", content: JSON.stringify(prompt) },
        ],
      }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.warn(`[aiStrategy] GonkaRouter responded ${res.status}`);
      return null;
    }

    const data = await res.json();
    const content: string | undefined = data?.choices?.[0]?.message?.content;
    if (!content) return null;

    // A reasoning model may wrap its chain-of-thought in <think>...</think>
    // before the answer — search only what comes after it, since the
    // reasoning itself can quote stray "{...}" text (e.g. echoing the schema
    // back) that would otherwise get greedily captured instead of the answer.
    const afterThink = content.includes("</think>")
      ? content.slice(content.lastIndexOf("</think>") + "</think>".length)
      : content;
    const match = afterThink.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);

    const sentiment = typeof parsed.sentiment === "string" ? SENTIMENT_BY_NORM.get(normalizeToken(parsed.sentiment)) : undefined;
    const strategyId = typeof parsed.strategyId === "string" ? STRATEGY_BY_NORM.get(normalizeToken(parsed.strategyId)) : undefined;
    const confidence = Number(parsed.confidence);
    const runnerUpsRaw = Array.isArray(parsed.runnerUps) ? parsed.runnerUps : [];

    // Never fabricate: an unrecognized sentiment/strategyId means the model
    // hallucinated outside the given catalog — treat the whole call as failed.
    if (!sentiment || !strategyId || !Number.isFinite(confidence)) {
      return null;
    }
    const runnerUps = runnerUpsRaw
      .map((id: unknown) => (typeof id === "string" ? STRATEGY_BY_NORM.get(normalizeToken(id)) : undefined))
      .filter((id: string | undefined): id is string => !!id && id !== strategyId)
      .slice(0, 2);

    return {
      sentiment,
      strategyId,
      rationale: String(parsed.rationale ?? "").slice(0, 220),
      confidence: Math.min(1, Math.max(0, confidence)),
      runnerUps,
      model: MODEL,
      generatedAt: Date.now(),
    };
  } catch (error) {
    console.warn("[aiStrategy] GonkaRouter call failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

export async function getAiStrategySuggestion(input: AiStrategyInput): Promise<AiStrategySuggestion | null> {
  const key = cacheKey(input);

  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < AI_CACHE_MS) return cached.suggestion;

  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = callGonkaRouter(input).then((suggestion) => {
    inflight.delete(key);
    if (suggestion) cache.set(key, { at: Date.now(), suggestion });
    return suggestion;
  });
  inflight.set(key, promise);
  return promise;
}
