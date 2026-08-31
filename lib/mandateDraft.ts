// Server-side advisory draft. It never returns executable calldata or signs a mandate.

import "server-only";

import { getTradeQuote } from "@/lib/trade";
import { TRADE_PERIODS, type TradePeriod } from "@/lib/tradePeriods";
import type { OptionsAsset } from "@/lib/assets";
import { gonkaApiKey, gonkaBaseUrl } from "@/lib/gonkaConfig";

export type MandateDraftTerms = {
  asset: OptionsAsset;
  side: "put";
  premiumPerFill: string;
  premiumTotal: string;
  contracts: string;
  minTenorDays: string;
  maxTenorDays: string;
  riskScore: string;
  persistenceMinutes: string;
  cooldownMinutes: string;
  validityHours: string;
};

export type AiMandateDraft = {
  terms: MandateDraftTerms;
  source: "gonka" | "deterministic";
  rationale: string;
  quote: { strike: number; expiryTs: number; contracts: number; premiumUsd: number; period: TradePeriod; liquidity: "book" | "mm"; capturedAt: number };
  generatedAt: number;
};

type AiTiming = { riskScore: number; persistenceMinutes: number; cooldownMinutes: number; validityHours: number; rationale: string; source: AiMandateDraft["source"] };

export async function createAiMandateDraft(asset: string): Promise<AiMandateDraft> {
  if (asset !== "BTC" && asset !== "ETH") throw new Error("asset must have a live Thetanuts options book");
  const quote = await findAdvisoryPut(asset);
  const now = Math.floor(Date.now() / 1000);
  const daysToExpiry = Math.max(1, Math.ceil((quote.expiryTs - now) / 86400));
  const timing = await getAiTiming(asset, quote, daysToExpiry);
  const premiumPerFill = usd(quote.totalCostUsd);

  return {
    terms: {
      asset,
      side: "put",
      premiumPerFill,
      premiumTotal: premiumPerFill,
      contracts: quantity(quote.contracts),
      minTenorDays: "1",
      maxTenorDays: String(Math.min(28, Math.max(7, daysToExpiry + 3))),
      riskScore: String(timing.riskScore),
      persistenceMinutes: String(timing.persistenceMinutes),
      cooldownMinutes: String(timing.cooldownMinutes),
      validityHours: String(timing.validityHours),
    },
    source: timing.source,
    rationale: timing.rationale || (quote.source === "book"
      ? "Fresh listed OptionBook quote selected. Review the policy limits before signing."
      : "No listed order is available. This Thetanuts MM estimate is advisory only; the agent still waits for a fresh listed OptionBook order."),
    quote: { strike: quote.strike, expiryTs: quote.expiryTs, contracts: quote.contracts, premiumUsd: quote.totalCostUsd, period: quote.requestedPeriod, liquidity: quote.source, capturedAt: now },
    generatedAt: Date.now(),
  };
}

async function findAdvisoryPut(asset: OptionsAsset) {
  let estimate: Awaited<ReturnType<typeof getTradeQuote>> | null = null;
  for (const period of TRADE_PERIODS) {
    const reference = await getTradeQuote(asset, "put", 1, period, true);
    if (reference.premiumPerContractUsd <= 0) continue;
    const target = Math.min(1, reference.maxContracts ?? 1, Math.max(0.001, Math.floor((2 / reference.premiumPerContractUsd) * 1e6) / 1e6));
    if (target < 0.001) continue;
    const quote = target === 1 ? reference : await getTradeQuote(asset, "put", target, period);
    if (quote.contracts <= 0 || quote.totalCostUsd <= 0) continue;
    if (quote.source === "book" && quote.txs) return quote;
    estimate ??= quote;
  }
  if (estimate) return estimate;
  throw new Error(`no live ${asset} put pricing is available for an AI draft`);
}

async function getAiTiming(asset: OptionsAsset, quote: Awaited<ReturnType<typeof findAdvisoryPut>>, daysToExpiry: number): Promise<AiTiming> {
  const fallback: AiTiming = { riskScore: 75, persistenceMinutes: 10, cooldownMinutes: 60, validityHours: 24, rationale: "", source: "deterministic" };
  if (!gonkaApiKey) return fallback;

  try {
    const response = await fetch(`${gonkaBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${gonkaApiKey}` },
      body: JSON.stringify({
        model: process.env.GONKAROUTER_MODEL ?? "deepseek-ai/DeepSeek-V4-Flash-0731",
        temperature: 0.1,
        // Gonka's reasoning models require room for their internal reasoning before JSON output.
        max_tokens: 1024,
        messages: [
          { role: "system", content: "You draft advisory, user-signed crypto-options execution policies. Do not propose an execution, RFQ, approval, or transfer. Return only JSON: {riskScore:number 50-95,persistenceMinutes:number 1-60,cooldownMinutes:number 5-1440,validityHours:number 1-168,rationale:string <=220 chars}. A MM estimate is not executable; a later agent must use a fresh listed Thetanuts OptionBook order." },
          { role: "user", content: JSON.stringify({ asset, liveQuote: { strike: quote.strike, expiryDays: daysToExpiry, contracts: quote.contracts, premiumUsd: quote.totalCostUsd, source: quote.source === "book" ? "listed OptionBook" : "Thetanuts MM estimate (RFQ-only)" }, marketImpact: quote.impact }) },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return fallback;
    const content: string | undefined = (await response.json())?.choices?.[0]?.message?.content;
    const match = content?.match(/\{[\s\S]*\}/);
    if (!match) return fallback;
    const parsed = JSON.parse(match[0]) as Partial<AiTiming>;
    if (![parsed.riskScore, parsed.persistenceMinutes, parsed.cooldownMinutes, parsed.validityHours].every(Number.isFinite)) return fallback;
    return {
      riskScore: clampInteger(parsed.riskScore!, 50, 95),
      persistenceMinutes: clampInteger(parsed.persistenceMinutes!, 1, 60),
      cooldownMinutes: clampInteger(parsed.cooldownMinutes!, 5, 1440),
      validityHours: clampInteger(parsed.validityHours!, 1, 168),
      rationale: typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 220) : "",
      source: "gonka",
    };
  } catch {
    return fallback;
  }
}

function clampInteger(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function usd(value: number) {
  return (Math.ceil(value * 1e6) / 1e6).toFixed(6).replace(/\.?0+$/, "");
}

function quantity(value: number) {
  return value.toFixed(6).replace(/\.?0+$/, "");
}
