// AI second opinion on a trade's amplification-risk impact, via GonkaRouter's
// OpenAI-compatible chat/completions API. The book moves every second — we
// can't afford a model call per quote tick, so reads are cached per rounded
// (asset, side, tenor, book-state) bucket for AI_CACHE_MS, and concurrent
// requests for the same bucket share one in-flight call. lib/engine.ts stays
// the deterministic, always-available heuristic; this only ever supplements
// it. On any failure (no key, timeout, bad JSON) this returns null so callers
// fall back cleanly — never fabricate an AI read that didn't happen.

import type { Asset } from "./assets";

export type AiRiskLabel = "low" | "moderate" | "elevated" | "severe";

export type AiRiskAssessment = {
  score: number; // 0-100, the model's own read of amplification risk after the fill
  label: AiRiskLabel;
  rationale: string;
  confidence: number; // 0-1
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

const API_KEY = process.env.GONKAROUTER_API_KEY || process.env.GONKA_API_KEY;
const BASE_URL = process.env.GONKAROUTER_BASE_URL ?? process.env.GONKA_BASE_URL ?? "https://api.gonkarouter.io/v1";
const MODEL = process.env.GONKAROUTER_MODEL ?? "deepseek-ai/DeepSeek-V4-Flash-0731";

const AI_CACHE_MS = 45_000;
// GonkaRouter latency is inconsistent (observed ~0.5-8s+); this read is
// background/supplementary (see TradePanel.tsx) so a generous timeout costs
// nothing but reduces spurious "unavailable" reads.
const AI_TIMEOUT_MS = 20_000;
const LABELS: AiRiskLabel[] = ["low", "moderate", "elevated", "severe"];

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
    // Per-contract greeks for the position being bought. Delta/gamma/theta/
    // vega come straight from the Thetanuts pricing API when the fill is
    // against a listed maker order; rho isn't in that API and is always
    // Black-Scholes-derived (see lib/modelBook.ts). Null when neither a live
    // order nor a modeled IV was available.
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
        temperature: 0.2,
        max_tokens: 220,
        messages: [
          {
            role: "system",
            content:
              "You are a derivatives market-structure risk analyst for a dealer-gamma dashboard. " +
              "Given a proposed options trade — including its own delta/gamma/theta/vega/rho — and " +
              "the dealer book's amplification-risk state before and after that fill, respond with " +
              "ONLY a JSON object — no prose, no markdown fences — matching: " +
              '{"score": number 0-100, "label": "low"|"moderate"|"elevated"|"severe", ' +
              '"rationale": string (<=200 chars), "confidence": number 0-1}. score reflects how much ' +
              "this trade pushes the market toward a feedback-loop-prone (dealer short-gamma) state. " +
              "Weigh the position's own greeks as primary signal — gamma magnitude (convexity the " +
              "dealer now must hedge), vega and theta (how fast that exposure decays or swings with " +
              "IV, i.e. how transient vs. persistent the risk is), delta (directional hedge flow), and " +
              "rho (rate sensitivity, usually minor for short-dated crypto options) — alongside net " +
              "GEX direction/magnitude, regime, and strike/expiry proximity. Don't just restate the " +
              "heuristic score/regime numbers; use them as context, not the answer.",
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
    const content: string | undefined = data?.choices?.[0]?.message?.content;
    if (!content) return null;

    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);

    const score = Number(parsed.score);
    const confidence = Number(parsed.confidence);
    const label = parsed.label;
    if (!Number.isFinite(score) || !Number.isFinite(confidence) || !LABELS.includes(label)) {
      return null;
    }

    return {
      score: Math.round(Math.min(100, Math.max(0, score))),
      label,
      rationale: String(parsed.rationale ?? "").slice(0, 220),
      confidence: Math.min(1, Math.max(0, confidence)),
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
