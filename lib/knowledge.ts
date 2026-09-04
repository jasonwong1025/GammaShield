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
        14_000,
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
          10_000,
        );
        const parsed = extractJson<Omit<KnowledgeResult, "source" | "modelUsed">>(rawDeepSeek);
        return {
          ...parsed,
          source: "ai",
          modelUsed: "DeepSeek Flash",
        };
      } catch (deepSeekErr) {
        console.warn("[Knowledge Copilot] DeepSeek failover also failed, using local knowledge:", deepSeekErr);
      }
    }
  }

  // 3. Tertiary Local Knowledge Base Fallback
  return generateLocalKnowledgeResponse(params);
}

/**
 * Local deterministic knowledge responder for instant offline answers and zero-failure reliability.
 */
function generateLocalKnowledgeResponse(params: KnowledgeRequest): KnowledgeResult {
  const q = params.question.toLowerCase();
  const spotFormatted = `$${params.spotPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

  // 1. Gamma & Why it is dangerous
  if (q.includes("gamma") || q.includes("danger") || q.includes("accelerat")) {
    return {
      summary: "Gamma measures how fast your option's sensitivity (Delta) speeds up as the underlying price moves.",
      analogy: "Think of Delta as the speedometer of your car, and Gamma as the accelerator pedal. A light press on the gas when Gamma is high makes your speed shoot up rapidly.",
      explanation: "Gamma is dangerous because when market makers are short gamma during a sudden sell-off, they are forced to sell more and more crypto into the decline just to balance their books. This triggers an avalanche effect where selling creates even more selling.",
      takeaway: "Always check the Gamma Flip level. Below the flip strike, market volatility can double or triple in minutes as automated hedging cascades take over.",
      liveContext: `Right now, ${params.asset} is trading at ${spotFormatted} with a Book Risk Score of ${params.score}/100 in a ${params.regime} regime.`,
      source: "deterministic",
      modelUsed: "Knowledge Base",
    };
  }

  // 2. Risk Score meaning (Book vs Contract)
  if (q.includes("risk score") || q.includes("score") || q.includes("meaning") || q.includes("fragility")) {
    return {
      summary: "GammaShield uses two distinct risk scores: a 0–100 Market Fragility Score for the whole book, and a 0–100 Position Risk Score for individual contracts.",
      analogy: "Think of the Market Risk Score as the weather forecast for the whole ocean (stormy or calm), while the Position Risk Score is the condition of your specific boat (solid hull or leaking).",
      explanation: "The Market Fragility Score measures whether options dealers will dampen or amplify price shocks based on net GEX. The Per-Contract Risk Score evaluates a single option based on 6 factors: premium cost, implied volatility, time decay (theta), liquidity, market regime, and time to expiration.",
      takeaway: "A high Market Score (>70) means market moves may snowball violently. A high Position Score means that particular contract is expensive, decaying rapidly, or hard to exit.",
      liveContext: `The current ${params.asset} Market Fragility Score is ${params.score}/100 (${params.regime} regime).`,
      source: "deterministic",
      modelUsed: "Knowledge Base",
    };
  }

  // 3. Gas fees and fluctuation on Base
  if (q.includes("gas") || q.includes("fee") || q.includes("base") || q.includes("cost")) {
    return {
      summary: "A gas fee is the small transaction fee you pay in ETH to submit, approve, or execute an options trade on the Base blockchain.",
      analogy: "Gas fees are like toll booths on an express highway. When traffic is light, the toll is just pennies; when there is a major rush hour or high congestion, the toll temporarily rises.",
      explanation: "Because Base is an Ethereum Layer 2, its gas fees are typically ultra-cheap (often under $0.05). However, when many users trade or mint simultaneously, network congestion can cause fees to spike temporarily until traffic cools down.",
      takeaway: "Always keep a small buffer of native ETH (around $5-$10) in your wallet on Base to cover approvals and trade fills without getting stuck.",
      liveContext: `Executing options orders on ${params.asset} on Base requires gas in native ETH.`,
      source: "deterministic",
      modelUsed: "Knowledge Base",
    };
  }

  // 4. Put vs Call
  if (q.includes("put") || q.includes("call") || q.includes("difference") || q.includes("type")) {
    return {
      summary: "A Call option bets that the price will go up, while a Put option bets that the price will go down or acts as insurance against a crash.",
      analogy: "Buying a Call is like reserving a house at today's price hoping it rises before you close. Buying a Put is like buying car collision insurance—if the market crashes, the insurance pays you out.",
      explanation: "With a Call, you earn profit when the crypto price rises above your strike price. With a Put, you make money (or protect your existing crypto holdings) when the price falls below the strike price.",
      takeaway: "On GammaShield, traders frequently buy protective Puts when dealer gamma is negative to hedge against sudden cascade crashes.",
      liveContext: `${params.asset} is currently at ${spotFormatted}. A Put below this level protects your downside capital.`,
      source: "deterministic",
      modelUsed: "Knowledge Base",
    };
  }

  // 5. General Options & Volatility Fallback
  return {
    summary: `Options are smart contracts that give you the right (without the obligation) to buy or sell ${params.asset} at a locked-in price before a specific date.`,
    analogy: "Think of an option like placing a non-refundable deposit to hold an item at a locked price. If the market price skyrockets, you get a bargain; if it tanks, you only lose your small deposit.",
    explanation: "Unlike spot trading where you simply hold the token, options have an expiration date and their value is driven by spot price, time remaining, and market volatility.",
    takeaway: "Monitor your position's time decay (Theta) closely. Options lose value every day they get closer to expiration unless the market moves in your favor.",
    liveContext: `Current ${params.asset} spot is ${spotFormatted} with market risk at ${params.score}/100.`,
    source: "deterministic",
    modelUsed: "Knowledge Base",
  };
}
