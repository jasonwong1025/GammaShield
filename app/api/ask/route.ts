import { NextRequest, NextResponse } from "next/server";
import { askOptionsKnowledge, type KnowledgeRequest } from "@/lib/knowledge";
import { ALL_ASSETS, type Asset } from "@/lib/assets";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { question, asset, spotPrice, score, netGexUsd, regime, flipStrike } = body;

    if (typeof question !== "string" || !question.trim() || question.length > 800) {
      return NextResponse.json({ error: "Missing or invalid question parameter" }, { status: 400 });
    }

    const currentAsset: Asset =
      typeof asset === "string" && ALL_ASSETS.includes(asset as Asset)
        ? (asset as Asset)
        : "ETH";

    const currentSpot = typeof spotPrice === "number" && Number.isFinite(spotPrice) ? spotPrice : 2500;
    const currentScore = typeof score === "number" && Number.isFinite(score) ? score : 50;
    const currentNetGex = typeof netGexUsd === "number" && Number.isFinite(netGexUsd) ? netGexUsd : 0;
    const currentRegime =
      regime === "dampening" || regime === "amplifying" || regime === "neutral"
        ? regime
        : "neutral";
    const currentFlipStrike =
      typeof flipStrike === "number" && Number.isFinite(flipStrike) ? flipStrike : null;

    const requestParams: KnowledgeRequest = {
      question: question.trim(),
      asset: currentAsset,
      spotPrice: currentSpot,
      score: currentScore,
      netGexUsd: currentNetGex,
      regime: currentRegime,
      flipStrike: currentFlipStrike,
    };

    const result = await askOptionsKnowledge(requestParams);
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Knowledge inquiry failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
