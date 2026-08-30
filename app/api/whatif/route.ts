import { NextRequest, NextResponse } from "next/server";
import { simulateWhatIfQuery, GONKA_MODELS, type WhatIfRequest } from "@/lib/gonka";
import { ALL_ASSETS } from "@/lib/assets";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { question, asset, spotPrice, score, netGexUsd, regime, model } = body;

    if (typeof question !== "string" || !question.trim() || question.length > 600) {
      return NextResponse.json({ error: "Missing question parameter" }, { status: 400 });
    }
    if (typeof asset !== "string" || !ALL_ASSETS.includes(asset as (typeof ALL_ASSETS)[number])) {
      return NextResponse.json({ error: "unsupported asset" }, { status: 400 });
    }
    if (![spotPrice, score, netGexUsd].every((value) => typeof value === "number" && Number.isFinite(value))) {
      return NextResponse.json({ error: "invalid numeric market context" }, { status: 400 });
    }
    if (regime !== "dampening" && regime !== "amplifying" && regime !== "neutral") {
      return NextResponse.json({ error: "invalid regime" }, { status: 400 });
    }
    if (model != null && !Object.values(GONKA_MODELS).includes(model)) {
      return NextResponse.json({ error: "unsupported model" }, { status: 400 });
    }

    const requestParams: WhatIfRequest = {
      question: question.trim(),
      asset,
      spotPrice,
      score,
      netGexUsd,
      regime,
      model: model ?? undefined,
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
