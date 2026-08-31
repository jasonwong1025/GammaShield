import { isOptionsAsset, type Asset } from "@/lib/assets";
import { getAiStrategySuggestion } from "@/lib/aiStrategy";
import { getMarketSnapshot } from "@/lib/snapshot";

export async function POST(request: Request) {
  let body: { asset?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const asset = body.asset;
  if (typeof asset !== "string" || !isOptionsAsset(asset as Asset)) {
    return Response.json({ error: "asset must have a live options book" }, { status: 400 });
  }
  try {
    const snapshot = await getMarketSnapshot();
    const market = snapshot.assets[asset as Asset];
    const suggestion = await getAiStrategySuggestion({
      asset: asset as Asset,
      spot: market.spot,
      score: market.score,
      regime: market.regime,
      netGexUsd: market.netGexUsd,
      avgIv: market.avgIv,
      flipStrike: market.flipStrike,
    });
    if (!suggestion) return Response.json({ error: "Gonka strategy advisor is unavailable; no AI suggestion was generated." }, { status: 502 });
    return Response.json(suggestion, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "strategy advisor failed";
    return Response.json({ error: message }, { status: 502 });
  }
}
