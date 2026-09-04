// AI second opinion on a trade's amplification-risk impact, via GonkaRouter's
// OpenAI-compatible chat/completions API. The book moves every second — we
// can't afford a model call per quote tick, so reads are cached per rounded
// (asset, side, tenor, book-state) bucket for AI_CACHE_MS, and concurrent
// requests for the same bucket share one in-flight call. lib/engine.ts stays
// the deterministic, always-available heuristic; this only ever supplements
// it. On any failure (no key, timeout, bad JSON) this returns null so callers
// fall back cleanly — never fabricate an AI read that didn't happen.

import type { Asset } from "./assets";
import { gonkaApiKey, gonkaBaseUrl } from "./gonkaConfig";

export type AiRiskLabel = "low" | "moderate" | "elevated" | "severe";

export type AiRiskAssessment = {
  /** Qualitative risk tier: low | moderate | elevated | severe */
  label: AiRiskLabel;
  /** Composite score 0-100 preserved for backwards compatibility */
  score: number;
  /** 1-sentence executive verdict summarizing the fill's risk profile */
  verdict: string;
  /** In-depth qualitative rationale detailing the trade-offs of the Greeks & market structure */
  rationale: string;
  /** Specific structural risk drivers (decay, convexity, regime shift) */
  keyPoints: string[];
  /** Model used */
  model: string;
  generatedAt: number; // unix ms
};

export type AiRiskGreeks = {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  /** Not in the Thetanuts pricing API — derived via Black-Scholes; see lib/modelBook.ts. */
  rho: number;
  iv: number;
};

export type AiRiskInput = {
  asset: Asset;
  side: "call" | "put";
  strike: number;
  expiryTs: number;
  contracts: number;
  spot: number;
  scoreBefore: number;
  scoreAfter: number;
  netGexBefore: number;
  netGexAfter: number;
  regimeBefore: string;
  regimeAfter: string;
  /** Per-contract greeks for the option being bought — the model's primary
   * read on this specific position's risk, not just the aggregate book. */
  greeks: AiRiskGreeks | null;
};

const API_KEY = gonkaApiKey;
const BASE_URL = gonkaBaseUrl;
const MODEL = process.env.GONKAROUTER_MODEL ?? "deepseek-ai/DeepSeek-V4-Flash-0731";

const AI_CACHE_MS = 45_000;
// GonkaRouter latency is inconsistent (observed ~0.5-15s+); this read is
// background/supplementary (see TradePanel.tsx) so a generous timeout costs
// nothing but reduces spurious "unavailable" reads.
const AI_TIMEOUT_MS = 35_000;
const LABELS: AiRiskLabel[] = ["low", "moderate", "elevated", "severe"];

const LABEL_SCORES: Record<AiRiskLabel, number> = {
  low: 25,
  moderate: 45,
  elevated: 70,
  severe: 90,
};

const cache = new Map<string, { at: number; assessment: AiRiskAssessment }>();
const inflight = new Map<string, Promise<AiRiskAssessment | null>>();

function roundSig(n: number, sig: number): number {
  if (n === 0 || !Number.isFinite(n)) return 0;
  const mag = Math.pow(10, sig - Math.ceil(Math.log10(Math.abs(n))));
  return Math.round(n * mag) / mag;
}

// Bucket continuous inputs so near-identical book states within the cache
// window share one AI call instead of each shaving a fresh request off the
// key. A genuinely different book state (score/regime shift) still misses.
function cacheKey(i: AiRiskInput): string {
  const bucket5 = (n: number) => Math.round(n / 5) * 5;
  const nowSec = Math.floor(Date.now() / 1000);
  const expiryDays = Math.round((i.expiryTs - nowSec) / 86400);
  const g = i.greeks;
  return [
    i.asset,
    i.side,
    Math.round(i.strike),
    expiryDays,
    roundSig(Math.max(i.contracts, 0.0001), 2),
    bucket5(i.scoreBefore),
    bucket5(i.scoreAfter),
    i.regimeBefore,
    i.regimeAfter,
    g ? roundSig(g.delta, 2) : "-",
    g ? roundSig(g.gamma, 2) : "-",
    g ? roundSig(g.theta, 2) : "-",
    g ? roundSig(g.vega, 2) : "-",
    g ? roundSig(g.rho, 2) : "-",
  ].join(":");
}

async function callGonkaRouter(input: AiRiskInput): Promise<AiRiskAssessment | null> {
  if (!API_KEY) {
    console.warn("[aiRisk] GONKAROUTER_API_KEY not set — skipping AI risk read");
    return null;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const g = input.greeks;
  const prompt = {
    asset: input.asset,
    side: input.side,
    strike: input.strike,
    spot: input.spot,
    expiryDays: Number(Math.max(0, (input.expiryTs - nowSec) / 86400).toFixed(1)),
    contracts: input.contracts,
    greeks: g && {
      delta: Number(g.delta.toFixed(4)),
      gamma: Number(g.gamma.toFixed(6)),
      theta: Number(g.theta.toFixed(4)),
      vega: Number(g.vega.toFixed(4)),
      rho: Number(g.rho.toFixed(4)),
      iv: Number(g.iv.toFixed(4)),
    },
    dealerGammaRegimeBefore: input.regimeBefore,
    dealerGammaRegimeAfter: input.regimeAfter,
    heuristicScoreBefore: input.scoreBefore,
    heuristicScoreAfter: input.scoreAfter,
    netGexUsdBefore: Math.round(input.netGexBefore),
    netGexUsdAfter: Math.round(input.netGexAfter),
  };

  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.1,
        max_tokens: 450,
        messages: [
          {
            role: "system",
            content:
              "You are a Senior Crypto Derivatives Desk Analyst and Options Risk Explainer for GammaShield on Base. " +
              "Given a proposed options trade and dealer book GEX state before and after the fill, " +
              "provide an institutional qualitative risk analysis. " +
              "Do not merely parrot heuristic score numbers. Instead, explain the trade-offs of the Greeks: " +
              "- Directional delta hedge and spot slippage obligation " +
              "- Convexity (gamma) and dealer rehedging loops " +
              "- Time decay (theta) urgency relative to days to expiry " +
              "- Volatility exposure (vega) and IV sensitivity " +
              "- How this fill interacts with current Net GEX and dealer regime (amplifying vs dampening). " +
              "Respond with ONLY a valid JSON object matching this schema without markdown fences: " +
              "{" +
              '  "label": "low" | "moderate" | "elevated" | "severe",' +
              '  "verdict": "1 concise sentence summarizing the risk profile (<=120 chars)",' +
              '  "rationale": "2-3 concise sentences detailing greek trade-offs and dealer impact (<=320 chars)",' +
              '  "keyPoints": ["point 1 on decay/convexity (<=80 chars)", "point 2 on dealer/market impact (<=80 chars)"]' +
              "}",
          },
          { role: "user", content: JSON.stringify(prompt) },
        ],
      }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.warn(`[aiRisk] GonkaRouter responded ${res.status}`);
      return null;
    }

    const data = await res.json();
    let content: string | undefined = data?.choices?.[0]?.message?.content;
    if (!content) return null;

    content = content.replace(/<think[\s\S]*?<\/think>/gi, "");
    const danglingThink = content.search(/<think\b/i);
    if (danglingThink !== -1) content = content.slice(0, danglingThink);
    content = content.trim();

    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);

    const rawLabel = String(parsed.label ?? "").toLowerCase();
    const label: AiRiskLabel = LABELS.includes(rawLabel as AiRiskLabel) ? (rawLabel as AiRiskLabel) : "moderate";
    const score = Number.isFinite(Number(parsed.score))
      ? Math.round(Math.min(100, Math.max(0, Number(parsed.score))))
      : LABEL_SCORES[label];

    const verdict = String(parsed.verdict ?? "").trim().slice(0, 150) || `${label.toUpperCase()} amplification risk`;
    const rationale = String(parsed.rationale ?? "").trim().slice(0, 350);
    const keyPoints = Array.isArray(parsed.keyPoints)
      ? parsed.keyPoints
          .filter((p: unknown) => typeof p === "string" && (p as string).trim().length > 0)
          .map((p: unknown) => String(p).trim().slice(0, 100))
          .slice(0, 3)
      : [];

    return {
      label,
      score,
      verdict,
      rationale,
      keyPoints,
      model: MODEL,
      generatedAt: Date.now(),
    };
  } catch (error) {
    console.warn("[aiRisk] GonkaRouter call failed:", error instanceof Error ? error.message : error);
    return null;
  }
}


export async function getAiAmplificationRisk(input: AiRiskInput): Promise<AiRiskAssessment | null> {
  const key = cacheKey(input);

  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < AI_CACHE_MS) return cached.assessment;

  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = callGonkaRouter(input).then((assessment) => {
    inflight.delete(key);
    if (assessment) cache.set(key, { at: Date.now(), assessment });
    return assessment;
  });
  inflight.set(key, promise);
  return promise;
}
