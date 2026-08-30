import { NextRequest, NextResponse } from "next/server";
import { simulateWhatIfQuery, type WhatIfRequest } from "@/lib/gonka";
import { getOptimalPutHedge } from "@/lib/optimizer";
import type { Asset } from "@/lib/assets";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { question, asset, spotPrice, score, netGexUsd, regime, model } = body;

    if (!question || typeof question !== "string") {
      return NextResponse.json({ error: "Missing question parameter" }, { status: 400 });
    }

    const currentAsset = (asset || "ETH") as Asset;
    const currentSpot = Number(spotPrice) || 2500;

    let optimalContract = null;
    try {
      const optRec = await getOptimalPutHedge(currentAsset, currentSpot);
      optimalContract = optRec.optimalContract;
    } catch {}

    const requestParams: WhatIfRequest = {
      question: question.trim(),
      asset: currentAsset,
      spotPrice: currentSpot,
      score: Number(score) || 50,
      netGexUsd: Number(netGexUsd) || 0,
      regime: regime || "neutral",
      model: model || undefined,
      optimalContract,
    };

    const result = await simulateWhatIfQuery(requestParams);
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "What-if simulation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
