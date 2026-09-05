import { NextRequest, NextResponse } from "next/server";
import { analyzeMarketRumor, GONKA_MODELS, type FactCheckRequest } from "@/lib/gonka";
import { getOptimalPutHedge } from "@/lib/optimizer";
import { ALL_ASSETS, type Asset } from "@/lib/assets";
import { extractClaimFromInput } from "@/lib/claimExtractor";
import { searchTavily, type TavilyEvidence } from "@/lib/tavily";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { headline, asset, gexScore, spotPrice, flipStrike, netGexUsd, regime, model } = body;

    if (typeof headline !== "string" || !headline.trim() || headline.length > 1000) {
      return NextResponse.json({ error: "Missing or invalid headline parameter" }, { status: 400 });
    }
    if (typeof asset !== "string" || !ALL_ASSETS.includes(asset as (typeof ALL_ASSETS)[number])) {
      return NextResponse.json({ error: "unsupported asset" }, { status: 400 });
    }
    if (![gexScore, spotPrice, netGexUsd].every((value) => value == null || (typeof value === "number" && Number.isFinite(value)))) {
      return NextResponse.json({ error: "invalid numeric market context" }, { status: 400 });
    }
    if (flipStrike != null && (typeof flipStrike !== "number" || !Number.isFinite(flipStrike))) {
      return NextResponse.json({ error: "invalid flip strike" }, { status: 400 });
    }
    if (regime != null && regime !== "dampening" && regime !== "amplifying" && regime !== "neutral") {
      return NextResponse.json({ error: "invalid regime" }, { status: 400 });
    }
    if (model != null && !Object.values(GONKA_MODELS).includes(model)) {
      return NextResponse.json({ error: "unsupported model" }, { status: 400 });
    }

    const currentAsset = (asset || "ETH") as Asset;
    const currentSpot = Number(spotPrice) || 2500;

    let optimalContract = null;
    try {
      const optRec = await getOptimalPutHedge(currentAsset, currentSpot);
      optimalContract = optRec.optimalContract;
    } catch {}

    // 1. Extract claim from URL or tweet if a link was submitted
    const extractedClaim = await extractClaimFromInput(headline);

    // 2. Real-time Web Search via Tavily:
    // - Always query web for raw text claims.
    // - Always query web for social posts (Twitter / X links), because a tweet is an unverified user statement.
    // - Query web for URLs if the link is dead/404, rate-limited, or blocked.
    // - Conserve credits only for clean news articles where the full metadata was already parsed.
    let webEvidence: TavilyEvidence[] = [];
    const isSocialPost = extractedClaim.domain?.includes("x.com") || extractedClaim.domain?.includes("twitter.com");
    const shouldQueryWeb = !extractedClaim.isUrl || isSocialPost || extractedClaim.fetchStatus !== "VERIFIED_PAGE";
    if (shouldQueryWeb) {
      try {
        const queryTerm = extractedClaim.isUrl ? extractedClaim.headline : headline;
        webEvidence = await searchTavily(queryTerm, 3);
      } catch (err) {
        console.warn("[FactCheck API] Tavily search error:", err);
      }
    }

    const requestParams: FactCheckRequest = {
      headline: extractedClaim.headline,
      asset: currentAsset,
      gexScore: Number(gexScore) || 50,
      spotPrice: currentSpot,
      flipStrike: flipStrike ? Number(flipStrike) : null,
      netGexUsd: netGexUsd ? Number(netGexUsd) : undefined,
      regime: regime || "neutral",
      model: model || undefined,
      optimalContract,
      extractedClaim,
      webEvidence,
    };

    const analysis = await analyzeMarketRumor(requestParams);
    return NextResponse.json(analysis, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Fact-check analysis failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
