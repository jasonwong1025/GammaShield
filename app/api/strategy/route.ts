// AI strategy suggestion (lib/aiStrategy.ts). Input is the already-computed
// AssetSnapshot fields the client gets from /api/market — no raw book
// internals are sent to the model.

import { getAiStrategySuggestion, type AiStrategyInput } from "@/lib/aiStrategy";
import { isOptionsAsset, type Asset } from "@/lib/assets";

type Body = Partial<AiStrategyInput>;

export async function POST(request: Request) {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { asset, spot, score, regime, netGexUsd, avgIv, flipStrike } = body;

  if (!asset || !isOptionsAsset(asset as Asset)) {
    return Response.json({ error: "asset must have a live options book" }, { status: 400 });
  }
  const numericFields = [spot, score, netGexUsd];
  if (!numericFields.every((v) => typeof v === "number" && Number.isFinite(v))) {
    return Response.json({ error: "invalid market-state fields" }, { status: 400 });
  }
  if (typeof regime !== "string") {
    return Response.json({ error: "invalid regime" }, { status: 400 });
  }
  if (avgIv != null && (typeof avgIv !== "number" || !Number.isFinite(avgIv))) {
    return Response.json({ error: "invalid avgIv" }, { status: 400 });
  }
  if (flipStrike != null && (typeof flipStrike !== "number" || !Number.isFinite(flipStrike))) {
    return Response.json({ error: "invalid flipStrike" }, { status: 400 });
  }

  try {
    const suggestion = await getAiStrategySuggestion({
      asset: asset as Asset,
      spot: spot!,
      score: score!,
      regime: regime!,
      netGexUsd: netGexUsd!,
      avgIv: avgIv ?? null,
      flipStrike: flipStrike ?? null,
    });
    if (!suggestion) {
      return Response.json({ error: "AI strategy suggestion unavailable" }, { status: 502 });
    }
    return Response.json(suggestion, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI strategy suggestion failed";
    return Response.json({ error: message }, { status: 502 });
  }
}
