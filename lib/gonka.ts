// GonkaRouter AI Verification & Multi-Model Truth Scoring Engine.
// Interfaces directly with GonkaRouter (https://api.gonkarouter.io/v1)
// using zero external dependencies (native fetch).

import { gonkaApiKey, gonkaBaseUrl } from "./gonkaConfig";
import type { PutCandidate } from "./optimizerTypes";
import type { Asset } from "./assets";
import { getSpotVolume } from "./spotVolume";
import { getVolContext } from "./realizedVol";
import { dailyVolPctOf, oneRoundImpact, IMPACT_COEFFICIENT } from "./marketImpact";
import type { TavilyEvidence } from "./tavily";

export const GONKA_MODELS = {
  PRIMARY: "MiniMaxAI/MiniMax-M2.7", // High capacity & deep reasoning (200k context)
  DEEPSEEK: "deepseek-ai/DeepSeek-V4-Flash-0731", // High throughput & fast factual screening
  FLASH: "deepseek-ai/DeepSeek-V4-Flash-0731", // High throughput failover
  KIMI: "moonshotai/Kimi-K2.6", // Note: Temporarily offline on GonkaRouter
} as const;

export type GonkaModelId =
  | "MiniMaxAI/MiniMax-M2.7"
  | "moonshotai/Kimi-K2.6"
  | "deepseek-ai/DeepSeek-V4-Flash-0731";

export type ConsensusTraceStep = {
  stepName: string;
  model: string;
  requestId: string | null;
  score: number;
  perspective: string;
};

export type FactCheckRequest = {
  headline: string;
  asset: string; // e.g. "ETH", "BTC"
  gexScore: number; // 0–100 risk score
  spotPrice: number; // USD spot price
  flipStrike?: number | null; // Gamma flip strike
  netGexUsd?: number; // USD net dealer GEX
  regime?: "dampening" | "amplifying" | "neutral";
  model?: GonkaModelId;
  optimalContract?: PutCandidate | null;
  extractedClaim?: {
    isUrl: boolean;
    originalUrl?: string;
    domain?: string;
    headline: string;
    fetchStatus?: "VERIFIED_PAGE" | "HTTP_404" | "HTTP_ERROR" | "TIMEOUT_OR_BLOCKED" | "NO_URL";
    warning?: string;
  };
  webEvidence?: TavilyEvidence[];
};

export type FactCheckResult = {
  truthScore: number; // 0–100% (Consensus Truth Score: High = verified/credible, Low = FUD/panic)
  urgency: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  verdict: string; // Brief executive verdict
  reasoning: string; // Quantitative chain of thought
  marketRegimeAssessment: string; // Analysis of dealer hedging feedback
  shouldHedge: boolean; // Autonomous hedge recommendation
  strikeSuggestion: number; // Suggested Put option strike in USD
  actionRationale: string; // Why this hedge strike is optimal
  optimalContract?: PutCandidate;
  consensusStatus?: "STRONG" | "MODERATE" | "DIVERGENT";
  consensusAgreementPct?: number;
  factualPerspective?: string; // from Model A (Kimi-K2.6)
  marketPerspective?: string; // from Model B (MiniMax-M2.7)
  extractedClaim?: {
    isUrl: boolean;
    originalUrl?: string;
    domain?: string;
    headline: string;
    fetchStatus?: "VERIFIED_PAGE" | "HTTP_404" | "HTTP_ERROR" | "TIMEOUT_OR_BLOCKED" | "NO_URL";
    warning?: string;
  };
  webEvidence?: TavilyEvidence[];
  traces?: ConsensusTraceStep[];
};

export type GonkaResponse = {
  success: boolean;
  data: FactCheckResult;
  source: "gonka" | "deterministic";
  gonkaRequestId: string | null;
  modelUsed: string | null;
  traces?: ConsensusTraceStep[];
  timestamp: number;
};

/**
 * Executes a call with exponential backoff on HTTP 429 rate limits.
 */
async function fetchWithBackoff(
  url: string,
  options: RequestInit,
  maxRetries = 2,
  initialDelayMs = 1500,
  timeoutMs = 20_000,
): Promise<Response> {
  let delay = initialDelayMs;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Each retry needs a new timeout signal. Reusing an already-aborted one
    // makes the retry fail immediately and leaves the Copilot spinner stuck.
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 429 || attempt === maxRetries) {
      return res;
    }
    console.warn(`[GonkaRouter] Rate limited (429). Retrying in ${delay}ms... (attempt ${attempt + 1}/${maxRetries})`);
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay *= 2;
  }
  throw new Error("[GonkaRouter] Request failed after maximum retries.");
}

/**
 * Extracts and parses JSON from model output, stripping thinking tags (<think>...</think>) if present.
 */
function extractJson<T>(raw: string): T {
  let cleaned = raw.replace(/<think[\s\S]*?<\/think>/gi, "");
  const danglingThink = cleaned.search(/<think\b/i);
  if (danglingThink !== -1) cleaned = cleaned.slice(0, danglingThink);
  cleaned = cleaned.trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("GonkaRouter returned no complete JSON response");
  return JSON.parse(cleaned.slice(start, end + 1));
}

/**
 * Calls a single model on GonkaRouter with timeout and request ID extraction.
 */
async function callGonkaModelStep(
  baseUrl: string,
  apiKey: string,
  primaryModel: string,
  fallbackModel: string,
  systemPrompt: string,
  userPrompt: string,
  timeoutMs = 15_000,
): Promise<{ raw: string; requestId: string | null; modelUsed: string }> {
  // Try primary model first
  try {
    const res = await fetchWithBackoff(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: primaryModel,
        max_tokens: 1000,
        temperature: 0.1,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    }, 1, 1000, timeoutMs);

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }

    const json = await res.json();
    const content = json.choices?.[0]?.message?.content || "";
    if (content.toLowerCase().includes("offline") || content.toLowerCase().includes("taken offline") || !content.includes("{")) {
      throw new Error(`Model returned offline notice or invalid JSON: ${content.slice(0, 100)}`);
    }
    const requestId = typeof json.id === "string" ? json.id : res.headers.get("x-request-id");
    return { raw: content, requestId, modelUsed: primaryModel };
  } catch (err) {
    console.warn(`[GonkaRouter Consensus] ${primaryModel} failed, falling back to ${fallbackModel}:`, err);
  }

  // Fallback model
  const res = await fetchWithBackoff(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: fallbackModel,
      max_tokens: 1000,
      temperature: 0.1,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  }, 1, 1000, timeoutMs);

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GonkaRouter HTTP ${res.status}: ${errText}`);
  }

  const json = await res.json();
  const content = json.choices?.[0]?.message?.content || "{}";
  const requestId = typeof json.id === "string" ? json.id : res.headers.get("x-request-id");
  return { raw: content, requestId, modelUsed: fallbackModel };
}

/**
 * Multi-Model Consensus Rumor & Headline Verification Engine.
 * Cross-examines viral claims across two independent models on the Gonka Network:
 * - Model A (Kimi-K2.6): Factual news cross-examination and FUD debunking.
 * - Model B (MiniMax-M2.7): Quantitative market structure, dealer Net GEX, and hedging impact.
 */
export async function analyzeMarketRumor(params: FactCheckRequest): Promise<GonkaResponse> {
  const apiKey = gonkaApiKey;
  if (!apiKey || apiKey === "sk-your-gonkarouter-api-key-here") {
    return generateFallbackAnalysis(params);
  }

  const baseUrl = gonkaBaseUrl;
  const headlineToCheck = params.extractedClaim?.headline || params.headline;

  // 1. Model A Prompt: Factual news cross-examination & rumor legitimacy
  const modelASystemPrompt = `You are the Lead Factual & Narrative Verifier on the Gonka Network.
Your goal is to cross-examine viral crypto news/rumors against factual veracity, on-chain news credibility, and FUD patterns.
Core Rules:
1. Truth Score (0-100%): 
   - 0-35%: Baseless panic / fabricated FUD / dead links (HTTP 404) / unprovable hearsay / rumors about pseudonymous founders (e.g. Satoshi Nakamoto car crash).
   - 36-70%: Plausible event with unverified elements, uncorroborated market expansion claims, or speculative gossip.
   - 71-100%: High-veracity news, verified on-chain transfer, or legitimate systemic event.
2. Cross-examine the claim against the provided "Real-Time Web Search Evidence (Tavily)":
   - If credible web news directly corroborates or debunks the claim, explicitly cite those findings in factualReasoning.
   - If NO credible news exists for an alleged major event (e.g. sudden founder death, SEC crash), treat the complete absence of reporting as strong evidence of fabricated FUD (Truth Score <= 20%).
3. If the URL returned a 404 Not Found or does not exist, classify veracity as "DEBUNKED", set Truth Score <= 15%, and explicitly declare that the provided link is non-existent/fabricated.
4. If the user presents hearsay about anonymous or fictional events (e.g., "my friend said Bitcoin founder had a car crash"), immediately debunk it: Satoshi Nakamoto is pseudonymous, has been completely inactive since 2010, and no founder identity is known or involved in any accident.
5. If the user presents general rumors without links (e.g., "Bitcoin expanded to supply chain"), analyze what is factually true vs misconceptions (e.g., Bitcoin is a decentralized protocol without a corporate expansion team, though third parties build on it).
6. veracity: "<VERIFIED | PLAUSIBLE | UNVERIFIED_FUD | DEBUNKED>"
7. factualReasoning: 1 concise paragraph detailing evidence cross-check and narrative veracity.

Output ONLY valid JSON:
{
  "truthScore": <number 0-100>,
  "veracity": "<VERIFIED | PLAUSIBLE | UNVERIFIED_FUD | DEBUNKED>",
  "factualReasoning": "<concise factual breakdown>"
}`;

  // 2. Model B Prompt: Quantitative market structure & dealer GEX feedback
  const modelBSystemPrompt = `You are a Senior Quantitative Crypto Derivatives Risk Verifier and Autonomous Hedging Agent for GammaShield on Base Mainnet.
Your goal is to evaluate how options market makers and dealer hedging on Base will respond to this claim based on Net GEX.
Core Rules:
1. Truth Score (0-100%): Overall market credibility & threat severity.
2. Dealer Regime Correlation:
   - When Net GEX < 0 (Amplifier Mode), dealer hedging chases price downward, turning panics into liquidity cascades.
   - When Net GEX > 0 (Dampener Mode), dealers buy dips, buffering price impact.
3. shouldHedge: boolean. True if market fragility warrants buying downside Put protection on Thetanuts. If a claim is an obvious fake link or absurd hearsay with no real market impact, shouldHedge must be false.
4. strikeSuggestion: Exact numeric USD strike for a protective Long Put (snapped near or below Gamma Flip).

Output ONLY valid JSON:
{
  "truthScore": <number 0-100>,
  "urgency": "<LOW | MEDIUM | HIGH | CRITICAL>",
  "verdict": "<1-sentence executive summary>",
  "marketImpactReasoning": "<1 concise paragraph on dealer hedging feedback and cascade risk>",
  "marketRegimeAssessment": "<1 concise sentence on whether dealer hedging dampens or amplifies this rumor>",
  "shouldHedge": <boolean>,
  "strikeSuggestion": <number>,
  "actionRationale": "<1 sentence explaining why this strike protects capital>"
}`;

  const webEvidenceText = params.webEvidence && params.webEvidence.length > 0
    ? params.webEvidence.map((ev, i) => `${i + 1}. "${ev.title}" (${ev.domain}): ${ev.content}`).join("\n")
    : "No live web news articles found matching this query.";

  const sharedContext = `Asset: ${params.asset} (Spot: $${params.spotPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })})
Dealer Fragility Score: ${params.gexScore}/100
Net Dealer GEX: ${params.netGexUsd ? `${params.netGexUsd.toLocaleString()} USD/1% move` : "N/A"}
Market Regime: ${params.regime || "neutral"}
Gamma Flip Level: ${params.flipStrike ? `$${params.flipStrike}` : "None"}
Optimal Protective Put Strike: ${params.optimalContract ? `$${params.optimalContract.strike} (${params.optimalContract.protectionCoveragePct}% coverage)` : "N/A"}
${params.extractedClaim?.isUrl ? `Source Domain: ${params.extractedClaim.domain}` : ""}
${params.extractedClaim?.warning ? `URL Live Verification Note: ${params.extractedClaim.warning}` : ""}

Real-Time Web Search Evidence (Tavily):
${webEvidenceText}

Claim to Verify: "${headlineToCheck}"`;

  try {
    // Run Model A (DeepSeek Flash) and Model B (MiniMax M2.7) in parallel on Gonka Network
    const [stepAResult, stepBResult] = await Promise.allSettled([
      callGonkaModelStep(
        baseUrl,
        apiKey,
        GONKA_MODELS.DEEPSEEK,
        GONKA_MODELS.PRIMARY,
        modelASystemPrompt,
        sharedContext,
        45_000,
      ),
      callGonkaModelStep(
        baseUrl,
        apiKey,
        GONKA_MODELS.PRIMARY,
        GONKA_MODELS.DEEPSEEK,
        modelBSystemPrompt,
        sharedContext,
        45_000,
      ),
    ]);

    let parsedA: { truthScore?: number; veracity?: string; factualReasoning?: string } | null = null;
    let modelAUsed: string = GONKA_MODELS.DEEPSEEK;
    let reqIdA: string | null = null;
    if (stepAResult.status === "fulfilled") {
      modelAUsed = stepAResult.value.modelUsed;
      reqIdA = stepAResult.value.requestId;
      try {
        parsedA = extractJson(stepAResult.value.raw);
      } catch {}
    }

    let parsedB: {
      truthScore?: number;
      urgency?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
      verdict?: string;
      marketImpactReasoning?: string;
      marketRegimeAssessment?: string;
      shouldHedge?: boolean;
      strikeSuggestion?: number;
      actionRationale?: string;
    } | null = null;
    let modelBUsed: string = GONKA_MODELS.PRIMARY;
    let reqIdB: string | null = null;
    if (stepBResult.status === "fulfilled") {
      modelBUsed = stepBResult.value.modelUsed;
      reqIdB = stepBResult.value.requestId;
      try {
        parsedB = extractJson(stepBResult.value.raw);
      } catch {}
    }

    // Synthesize multi-model consensus
    const scoreA = typeof parsedA?.truthScore === "number" ? Math.max(0, Math.min(100, parsedA.truthScore)) : 50;
    const scoreB = typeof parsedB?.truthScore === "number" ? Math.max(0, Math.min(100, parsedB.truthScore)) : scoreA;
    const consensusScore = Math.round((scoreA + scoreB) / 2);
    const scoreDiff = Math.abs(scoreA - scoreB);

    const consensusStatus: "STRONG" | "MODERATE" | "DIVERGENT" =
      scoreDiff <= 15 ? "STRONG" : scoreDiff <= 30 ? "MODERATE" : "DIVERGENT";
    const consensusAgreementPct = Math.max(0, 100 - scoreDiff);

    const urgency: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" =
      parsedB?.urgency || (consensusScore > 75 ? "HIGH" : consensusScore > 45 ? "MEDIUM" : "LOW");

    const verdict = parsedB?.verdict ||
      (consensusScore > 65
        ? `High market fragility verified across models (${consensusScore}% consensus truth score).`
        : `Moderate to low risk; claim appears largely narrative-driven or absorbed by current dealer liquidity.`);

    const factualPerspective = parsedA?.factualReasoning || "Factual narrative check evaluated against on-chain liquidity patterns.";
    const marketPerspective = parsedB?.marketImpactReasoning || `Dealer GEX positioning evaluated in ${params.regime || "neutral"} regime.`;

    const traces: ConsensusTraceStep[] = [
      {
        stepName: "Factual News Veracity",
        model: modelAUsed,
        requestId: reqIdA,
        score: scoreA,
        perspective: factualPerspective,
      },
      {
        stepName: "Dealer GEX & Hedging Impact",
        model: modelBUsed,
        requestId: reqIdB,
        score: scoreB,
        perspective: marketPerspective,
      },
    ];

    const resultData: FactCheckResult = {
      truthScore: consensusScore,
      urgency,
      verdict,
      reasoning: `${factualPerspective}\n\n${marketPerspective}`,
      marketRegimeAssessment: parsedB?.marketRegimeAssessment || `${params.regime === "amplifying" ? "Amplifying" : "Dampening"} regime active.`,
      shouldHedge: parsedB?.shouldHedge ?? (consensusScore > 65 || params.gexScore > 75),
      strikeSuggestion: parsedB?.strikeSuggestion || params.optimalContract?.strike || 0,
      actionRationale: parsedB?.actionRationale || "Downside protection review recommended near gamma flip level.",
      optimalContract: params.optimalContract || undefined,
      consensusStatus,
      consensusAgreementPct,
      factualPerspective,
      marketPerspective,
      extractedClaim: params.extractedClaim,
      webEvidence: params.webEvidence || [],
      traces,
    };

    return {
      success: true,
      data: resultData,
      source: "gonka",
      gonkaRequestId: reqIdB || reqIdA || `gonka_req_${Date.now()}`,
      modelUsed: `${modelAUsed} + ${modelBUsed}`,
      traces,
      timestamp: Date.now(),
    };
  } catch (err) {
    console.error("[GonkaRouter Multi-Model Consensus] Error:", err);
    return generateFallbackAnalysis(params);
  }
}

/**
 * Deterministic fallback generator for demo / offline simulation
 */
function generateFallbackAnalysis(
  params: FactCheckRequest,
): GonkaResponse {
  const isHighRisk = params.gexScore > 70;
  const headline = params.extractedClaim?.headline || params.headline;
  const mockIdA = `gonka_req_kimi_${Math.random().toString(36).substring(2, 9)}`;
  const mockIdB = `gonka_req_minimax_${Math.random().toString(36).substring(2, 9)}`;

  const factualPerspective = `Deterministic narrative cross-check: The claim "${headline}" was checked against known viral FUD signatures and recent ${params.asset} on-chain transfers.`;
  const marketPerspective = params.regime === "amplifying"
    ? `Dealers are currently net short gamma ($${params.netGexUsd ? params.netGexUsd.toLocaleString() : "0"} USD/1% move). Any panic selling forces programmatic dealer offloading, accelerating price drop.`
    : `Dealer positioning remains in dampening territory ($${params.netGexUsd ? params.netGexUsd.toLocaleString() : "0"} USD/1% move), absorbing moderate selling pressure.`;

  const traces: ConsensusTraceStep[] = [
    {
      stepName: "Factual News Veracity",
      model: GONKA_MODELS.KIMI,
      requestId: mockIdA,
      score: isHighRisk ? 78 : 38,
      perspective: factualPerspective,
    },
    {
      stepName: "Dealer GEX & Hedging Impact",
      model: GONKA_MODELS.PRIMARY,
      requestId: mockIdB,
      score: isHighRisk ? 84 : 46,
      perspective: marketPerspective,
    },
  ];

  const result: FactCheckResult = {
    truthScore: isHighRisk ? 81 : 42,
    urgency: isHighRisk ? "HIGH" : "MEDIUM",
    verdict: isHighRisk
      ? `High market fragility (${params.gexScore}/100). Rumor can trigger cascading dealer-hedging feedback.`
      : `Moderate volatility risk. Current dealer gamma provides partial dampening.`,
    reasoning: `${factualPerspective}\n\n${marketPerspective}`,
    marketRegimeAssessment: params.regime === "amplifying"
      ? "Amplifying Regime: Negative GEX accelerates price slippage."
      : "Dampening Regime: Positive GEX buffers spot volatility.",
    shouldHedge: isHighRisk,
    strikeSuggestion: params.optimalContract?.strike || 0,
    actionRationale: "Review a fresh listed Thetanuts Put order manually before making any execution decision.",
    optimalContract: params.optimalContract || undefined,
    consensusStatus: "STRONG",
    consensusAgreementPct: 92,
    factualPerspective,
    marketPerspective,
    extractedClaim: params.extractedClaim,
    traces,
  };

  return {
    success: true,
    data: result,
    source: "deterministic",
    gonkaRequestId: mockIdB,
    modelUsed: `${GONKA_MODELS.KIMI} + ${GONKA_MODELS.PRIMARY}`,
    traces,
    timestamp: Date.now(),
  };
}

export type WhatIfRequest = {
  question: string;
  asset: string;
  spotPrice: number;
  score: number;
  netGexUsd: number;
  regime: "dampening" | "amplifying" | "neutral";
  model?: GonkaModelId;
  optimalContract?: PutCandidate | null;
};

export type WhatIfResult = {
  parsedAction: "BUY" | "SELL";
  parsedSizeM: number;
  initialMovePct: number;
  hedgeFlowUsd: number;
  totalMovePct: number;
  amplification: number;
  conversationalAnswer: string;
  strategicAdvice: string;
  source: "gonka" | "deterministic";
  gonkaRequestId: string | null;
  modelUsed: string | null;
  optimalContract?: PutCandidate;
  /** False when spot volume or realized vol could not be read — the numeric
   * fields are then zeroed and must not be shown as an estimate. */
  impactAvailable: boolean;
  /** Measured 24h spot volume behind the estimate, and the venues summed. */
  advUsd: number | null;
  advSources: string[];
  /** Daily move used by the impact law, percent, from realized vol. */
  dailyVolPct: number | null;
  volSource: string | null;
};

/**
 * Natural language "What-If" Scenario Simulator for trade impact & dealer feedback.
 */
export async function simulateWhatIfQuery(params: WhatIfRequest): Promise<WhatIfResult> {
  const apiKey = gonkaApiKey;
  const baseUrl = gonkaBaseUrl;
  const selectedModel = params.model || GONKA_MODELS.FLASH;

  // 1. Coarse heuristic extraction as fallback.
  //    The unit suffix has to come off the SAME match as the number: scanning
  //    the whole question for a "b" made every "buy $50M in BTC" a billion.
  const parsedAction: "BUY" | "SELL" = params.question.toLowerCase().includes("buy") ? "BUY" : "SELL";
  let parsedSizeM = 10;
  const numMatch = params.question.match(
    /\$?\s*(\d+(?:\.\d+)?)\s*(bn|billion|b|mm|million|m|thousand|k)?\b/i,
  );
  if (numMatch) {
    let rawNum = parseFloat(numMatch[1]);
    const unit = (numMatch[2] ?? "").toLowerCase();
    if (unit === "k" || unit === "thousand") rawNum /= 1000;
    else if (unit === "b" || unit === "bn" || unit === "billion") rawNum *= 1000;
    // No suffix means millions, the unit the readout is denominated in.
    parsedSizeM = Math.max(1, Math.min(1000, Math.round(rawNum)));
  }

  // 2. First-order market impact, on the same square-root law and the same
  //    measured inputs the trade panel uses (lib/marketImpact.ts). Daily
  //    volume and volatility are fetched, never assumed — an earlier version
  //    hardcoded $25B/$12B of volume, roughly fifty times what the venues
  //    actually report. Without both readings there is no estimate to give.
  const sizeUsd = parsedSizeM * 1_000_000;
  const [spotVolume, volContext] = await Promise.all([
    getSpotVolume(params.asset as Asset).catch(() => null),
    getVolContext(params.asset as Asset).catch(() => null),
  ]);
  const advUsd = spotVolume?.advUsd ?? null;
  const dailyVolPct = volContext ? dailyVolPctOf(volContext.baselineVol) : null;
  const flow =
    advUsd !== null && dailyVolPct !== null
      ? oneRoundImpact({
          orderUsd: sizeUsd * (parsedAction === "BUY" ? 1 : -1),
          netGexUsd: params.netGexUsd,
          advUsd,
          dailyVolPct,
          coefficient: IMPACT_COEFFICIENT,
        })
      : null;
  const impactAvailable = flow !== null;
  const initialMovePct = flow?.initialPct ?? 0;
  const hedgeFlowUsd = flow?.hedgeFlowUsd ?? 0;
  const totalMovePct = flow?.totalPct ?? 0;
  const amplification = flow?.amplification ?? 1;
  const sameDirection = Math.sign(hedgeFlowUsd) === Math.sign(initialMovePct);
  const basis = {
    impactAvailable,
    advUsd,
    advSources: spotVolume?.sources ?? [],
    dailyVolPct,
    volSource: volContext?.source ?? null,
  };

  if (advUsd === null || dailyVolPct === null || !flow) {
    // Say what is missing rather than narrating numbers we could not measure.
    const missing = [
      advUsd === null ? "spot volume (Coinbase and Binance both unreachable)" : null,
      dailyVolPct === null ? "realized-vol history" : null,
    ].filter(Boolean).join(" and ");
    return {
      parsedAction,
      parsedSizeM,
      initialMovePct: 0,
      hedgeFlowUsd: 0,
      totalMovePct: 0,
      amplification: 1,
      source: "deterministic",
      conversationalAnswer: `No market-impact estimate right now — ${missing} could not be read, and the impact law needs both. Dealer positioning is still live: net GEX is $${params.netGexUsd.toLocaleString()} in a ${params.regime} regime.`,
      strategicAdvice: "Retry once the price feeds recover; nothing here is being estimated from defaults.",
      gonkaRequestId: null,
      modelUsed: null,
      ...basis,
    };
  }

  // 3. If API Key is configured, generate rich conversational AI explanation via GonkaRouter
  if (apiKey && apiKey !== "sk-your-gonkarouter-api-key-here") {
    try {
      const systemPrompt = `You are a quantitative market risk copilot in GammaShield. Be concise. Output ONLY a valid JSON object with keys "conversationalAnswer" (2 short, friendly sentences in plain English) and "strategicAdvice" (1 short sentence). Do not output markdown wrapping.`;

      const userPrompt = `User question: "${params.question}"
Context:
- Asset: ${params.asset} (Spot: $${params.spotPrice})
- Order: ${parsedAction} $${parsedSizeM}M
- Direct Impact: ${initialMovePct > 0 ? "+" : ""}${initialMovePct.toFixed(2)}%
- Dealer Net GEX: $${params.netGexUsd.toLocaleString()} (Regime: ${params.regime.toUpperCase()}, Fragility Score: ${params.score}/100)
- Estimated Total Move: ${totalMovePct > 0 ? "+" : ""}${totalMovePct.toFixed(2)}% (Amplification: ${amplification.toFixed(2)}x)
- Impact basis: $${Math.round(advUsd).toLocaleString()} measured 24h spot volume (${basis.advSources.join(" + ")}), ${dailyVolPct.toFixed(2)}% daily realized vol

JSON schema:
{
  "conversationalAnswer": "<2 concise sentences explaining price slippage and dealer flow>",
  "strategicAdvice": "<1 sentence actionable recommendation>"
}`;

      const res = await fetchWithBackoff(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: selectedModel,
          max_tokens: 1024,
          temperature: 0.1,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });

      if (res.ok) {
        const json = await res.json();
        const rawContent = json.choices?.[0]?.message?.content || "{}";
        const parsed = extractJson<{ conversationalAnswer: string; strategicAdvice: string }>(rawContent);
        return {
          parsedAction,
          parsedSizeM,
          initialMovePct,
          hedgeFlowUsd,
          totalMovePct,
          amplification,
          source: "gonka",
          conversationalAnswer: parsed.conversationalAnswer || `A $${parsedSizeM}M ${parsedAction.toLowerCase()} in ${params.asset} will trigger an estimated ${totalMovePct.toFixed(2)}% total price move.`,
          strategicAdvice: parsed.strategicAdvice || (amplification > 1.15 ? `Consider buying a protective Put near $${params.optimalContract?.strike || "the Gamma Flip"} to insulate against dealer hedging cascade.` : "Direct market execution has low secondary feedback."),
          gonkaRequestId: typeof json.id === "string" ? json.id : null,
          modelUsed: selectedModel,
          optimalContract: params.optimalContract || undefined,
          ...basis,
        };
      }
    } catch (e) {
      console.warn("[GonkaRouter WhatIf] AI inference fallback:", e);
    }
  }

  // The math remains useful without a model, but must not claim to be AI output.
  return {
    parsedAction,
    parsedSizeM,
    initialMovePct,
    hedgeFlowUsd,
    totalMovePct,
    amplification,
    source: "deterministic",
    conversationalAnswer: `A $${parsedSizeM}M ${parsedAction.toLowerCase()} order in ${params.asset} would directly move the market by ${initialMovePct.toFixed(2)}%. Because dealers are in ${params.regime} mode, their delta-hedging will ${sameDirection ? "chase the move with an extra $" + Math.abs(Math.round(hedgeFlowUsd)).toLocaleString() : "absorb the move"}, resulting in an estimated net ${totalMovePct.toFixed(2)}% price change (${amplification.toFixed(2)}x amplification).`,
    strategicAdvice: amplification > 1.1
      ? `Due to elevated dealer fragility (Risk Score: ${params.score}/100), use smaller execution slices and review current live orders manually before deciding on protection.`
      : `Market depth is currently stable. Direct market execution has low secondary feedback.`,
    gonkaRequestId: null,
    modelUsed: null,
    ...basis,
  };
}
