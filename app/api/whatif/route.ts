import { NextRequest, NextResponse } from "next/server";
import { simulateWhatIfQuery, type WhatIfRequest } from "@/lib/gonka";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { question, asset, spotPrice, score, netGexUsd, regime, model } = body;

    if (!question || typeof question !== "string") {
      return NextResponse.json({ error: "Missing question parameter" }, { status: 400 });
    }

    const requestParams: WhatIfRequest = {
      question: question.trim(),
      asset: asset || "ETH",
      spotPrice: Number(spotPrice) || 0,
      score: Number(score) || 50,
      netGexUsd: Number(netGexUsd) || 0,
      regime: regime || "neutral",
      model: model || undefined,
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
