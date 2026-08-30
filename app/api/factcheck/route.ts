import { NextRequest, NextResponse } from "next/server";
import { analyzeMarketRumor, type FactCheckRequest } from "@/lib/gonka";
import { getOptimalPutHedge } from "@/lib/optimizer";
import type { Asset } from "@/lib/assets";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { headline, asset, gexScore, spotPrice, flipStrike, netGexUsd, regime, model } = body;

    if (!headline || typeof headline !== "string") {
      return NextResponse.json({ error: "Missing or invalid headline parameter" }, { status: 400 });
    }

    const currentAsset = (asset || "ETH") as Asset;
    const currentSpot = Number(spotPrice) || 2500;

    let optimalContract = null;
    try {
      const optRec = await getOptimalPutHedge(currentAsset, currentSpot);
      optimalContract = optRec.optimalContract;
    } catch {}

    const requestParams: FactCheckRequest = {
      headline: headline.trim(),
      asset: currentAsset,
      gexScore: Number(gexScore) || 50,
      spotPrice: currentSpot,
      flipStrike: flipStrike ? Number(flipStrike) : null,
      netGexUsd: netGexUsd ? Number(netGexUsd) : undefined,
      regime: regime || "neutral",
      model: model || undefined,
      optimalContract,
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
