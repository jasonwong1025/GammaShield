// GonkaRouter AI Verification & Multi-Model Truth Scoring Engine.
// Interfaces directly with GonkaRouter (https://api.gonkarouter.io/v1)
// using zero external dependencies (native fetch).

import { gonkaApiKey, gonkaBaseUrl } from "./gonkaConfig";
import type { PutCandidate } from "./optimizerTypes";
import type { Asset } from "./assets";
import { getSpotVolume } from "./spotVolume";
import { getVolContext } from "./realizedVol";
import { dailyVolPctOf, oneRoundImpact, IMPACT_COEFFICIENT } from "./marketImpact";

export const GONKA_MODELS = {
  PRIMARY: "MiniMaxAI/MiniMax-M2.7", // Recommended agent & reasoning model (200k context)
  KIMI: "moonshotai/Kimi-K2.6",      // High accuracy factual verification
  FLASH: "deepseek-ai/DeepSeek-V4-Flash-0731", // High throughput & fast screening
} as const;

export type GonkaModelId =
  | "MiniMaxAI/MiniMax-M2.7"
  | "moonshotai/Kimi-K2.6"
  | "deepseek-ai/DeepSeek-V4-Flash-0731";

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
};

export type FactCheckResult = {
  truthScore: number; // 0–100% (High = verified/credible, Low = FUD/panic)
  urgency: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  verdict: string; // Brief executive verdict
  reasoning: string; // Quantitative chain of thought
  marketRegimeAssessment: string; // Analysis of dealer hedging feedback
  shouldHedge: boolean; // Autonomous hedge recommendation
  strikeSuggestion: number; // Suggested Put option strike in USD
  actionRationale: string; // Why this hedge strike is optimal
  optimalContract?: PutCandidate;
};

export type GonkaResponse = {
  success: boolean;
  data: FactCheckResult;
  source: "gonka" | "deterministic";
  gonkaRequestId: string | null;
  modelUsed: string | null;
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
 * Analyze a market rumor or viral news headline against real-time options GEX positioning.
 */
export async function analyzeMarketRumor(params: FactCheckRequest): Promise<GonkaResponse> {
  const apiKey = gonkaApiKey;
  if (!apiKey || apiKey === "sk-your-gonkarouter-api-key-here") {
    return generateFallbackAnalysis(params);
  }

  const baseUrl = gonkaBaseUrl;
  const selectedModel = params.model || GONKA_MODELS.PRIMARY;

  const systemPrompt = `You are a Senior Quantitative Crypto Derivatives Risk Verifier and Autonomous Hedging Agent for GammaShield on Base Mainnet.
Your goal is to cross-examine viral crypto news/rumors against deterministic Thetanuts options market mechanics (Dealer Gamma Exposure / Net GEX).

Core Rules:
1. Truth Score (0-100%): 
   - 0-35%: Baseless panic / FUD not supported by orderbook dealer positioning.
   - 36-70%: Plausible narrative with mild market friction.
   - 71-100%: High-veracity systemic risk or verified market shock.
2. Dealer Regime Correlation:
   - When Net GEX < 0 (Amplifier Mode), dealer hedging chases spot price down, turning small panic selloffs into liquidity cascades.
   - When Net GEX > 0 (Dampener Mode), dealers buy dips and sell rallies, buffering price impact.
3. shouldHedge: Mandatory boolean flag. Set true if (TruthScore > 65% OR GexRiskScore > 75%) and the threat warrants buying downside Put protection on Thetanuts.
4. strikeSuggestion: Exact numeric USD strike price for a protective Long Put (snapped near or below the Gamma Flip level).

You MUST output ONLY a valid JSON object matching this schema without any markdown wrapping:
{
  "truthScore": <number 0-100>,
  "urgency": "<LOW | MEDIUM | HIGH | CRITICAL>",
  "verdict": "<1-sentence executive summary>",
  "reasoning": "<1 concise paragraph detailing narrative cross-check and dealer hedging flow>",
  "marketRegimeAssessment": "<1 concise sentence on whether dealer hedging dampens or amplifies this rumor>",
  "shouldHedge": <boolean>,
  "strikeSuggestion": <number>,
  "actionRationale": "<1 sentence explaining why this strike protects capital>"
}`;

  const userPrompt = `Asset: ${params.asset} (Spot: $${params.spotPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })})
Dealer Fragility Score: ${params.gexScore}/100
Net Dealer GEX: ${params.netGexUsd ? `${params.netGexUsd.toLocaleString()} USD/1% move` : "N/A"}
Market Regime: ${params.regime || "neutral"}
Gamma Flip Level: ${params.flipStrike ? `$${params.flipStrike}` : "None"}
Optimal Protective Put Strike: ${params.optimalContract ? `$${params.optimalContract.strike} (${params.optimalContract.protectionCoveragePct}% coverage)` : "N/A"}

Headline to Fact-Check: "${params.headline}"`;

  try {
    const res = await fetchWithBackoff(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: selectedModel,
        max_tokens: 1200,
        temperature: 0.1,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`GonkaRouter HTTP ${res.status}: ${errText}`);
    }

    const json = await res.json();
    const rawContent = json.choices?.[0]?.message?.content || "{}";
    const parsedData: FactCheckResult = extractJson<FactCheckResult>(rawContent);

    // Attach optimizer contract
    if (params.optimalContract) {
      parsedData.optimalContract = params.optimalContract;
      if (!parsedData.strikeSuggestion || parsedData.strikeSuggestion <= 0) {
        parsedData.strikeSuggestion = params.optimalContract.strike;
      }
    }

    return {
      success: true,
      data: parsedData,
      source: "gonka",
      gonkaRequestId: typeof json.id === "string" ? json.id : null,
      modelUsed: selectedModel,
      timestamp: Date.now(),
    };
  } catch (err) {
    console.error("[GonkaRouter] Inference error:", err);
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

  const result: FactCheckResult = {
    truthScore: isHighRisk ? 82 : 45,
    urgency: isHighRisk ? "HIGH" : "MEDIUM",
    verdict: isHighRisk
      ? `High market fragility (${params.gexScore}/100). Rumor can trigger cascading dealer-hedging feedback.`
      : `Moderate volatility risk. Current dealer gamma provides partial dampening.`,
    reasoning: `Deterministic market-structure calculation only; no Gonka model response was used. The headline "${params.headline}" was compared with ${params.asset} spot ($${params.spotPrice}) and current market structure. ${
      params.regime === "amplifying"
        ? "Dealers are currently net short gamma; any spot decline forces programmatic selling, exacerbating downside momentum."
        : "Dealer positioning remains in dampening territory, but localized tail risk exists around out-of-the-money put strikes."
    }`,
    marketRegimeAssessment: params.regime === "amplifying"
      ? "Amplifying Regime: Negative GEX accelerates price slippage."
      : "Dampening Regime: Positive GEX buffers spot volatility.",
    shouldHedge: false,
    strikeSuggestion: 0,
    actionRationale: "This fallback cannot recommend or select a contract. Review a fresh listed Thetanuts order manually before making any decision.",
  };

  return {
    success: true,
    data: result,
    source: "deterministic",
    gonkaRequestId: null,
    modelUsed: null,
    timestamp: Date.now(),
  };
}

/**
 * 30-Second Smoke Test against GonkaRouter API
 */
export async function smokeTestGonka(apiKey?: string): Promise<{ ok: boolean; message: string; id?: string }> {
  const key = apiKey || gonkaApiKey;
  if (!key || key === "sk-your-gonkarouter-api-key-here") {
    return { ok: false, message: "GONKAROUTER_API_KEY not configured" };
  }

  const baseUrl = gonkaBaseUrl;

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: GONKA_MODELS.FLASH,
        max_tokens: 100,
        messages: [{ role: "user", content: "Reply with just: pong" }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      return { ok: false, message: `HTTP ${res.status}: ${err}` };
    }

    const data = await res.json();
    return {
      ok: true,
      message: data.choices?.[0]?.message?.content?.trim() || "pong",
      id: data.id,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Network error" };
  }
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
