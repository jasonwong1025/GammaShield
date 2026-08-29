// AI second opinion on a trade's amplification-risk impact (lib/aiRisk.ts).
// Takes the impact block the client already got from /api/quote — no need to
// re-fetch the book here — and asks GonkaRouter for a model read, server-side
// cached so repeated calls for the same bucketed state don't hit the API.

import { getAiAmplificationRisk, type AiRiskInput } from "@/lib/aiRisk";
import { isOptionsAsset, type Asset } from "@/lib/assets";
import type { TradeSide } from "@/lib/trade";

type Body = Partial<AiRiskInput>;

export async function POST(request: Request) {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { asset, side, strike, expiryTs, contracts, spot, greeks } = body;
  const { scoreBefore, scoreAfter, netGexBefore, netGexAfter, regimeBefore, regimeAfter } = body;

  if (!asset || !isOptionsAsset(asset as Asset)) {
    return Response.json({ error: "asset must have a live options book" }, { status: 400 });
  }
  if (side !== "call" && side !== "put") {
    return Response.json({ error: "side must be call or put" }, { status: 400 });
  }
  const numericFields = [strike, expiryTs, contracts, spot, scoreBefore, scoreAfter, netGexBefore, netGexAfter];
  if (!numericFields.every((v) => typeof v === "number" && Number.isFinite(v))) {
    return Response.json({ error: "invalid trade/impact fields" }, { status: 400 });
  }
  if (typeof regimeBefore !== "string" || typeof regimeAfter !== "string") {
    return Response.json({ error: "invalid regime fields" }, { status: 400 });
  }
  if (
    greeks != null &&
    (typeof greeks !== "object" ||
      !["delta", "gamma", "theta", "vega", "rho", "iv"].every(
        (k) => typeof (greeks as Record<string, unknown>)[k] === "number" && Number.isFinite((greeks as Record<string, unknown>)[k]),
      ))
  ) {
    return Response.json({ error: "invalid greeks" }, { status: 400 });
  }

  try {
    const assessment = await getAiAmplificationRisk({
      asset: asset as Asset,
      side: side as TradeSide,
      strike: strike!,
      expiryTs: expiryTs!,
      contracts: contracts!,
      spot: spot!,
      scoreBefore: scoreBefore!,
      scoreAfter: scoreAfter!,
      netGexBefore: netGexBefore!,
      netGexAfter: netGexAfter!,
      regimeBefore: regimeBefore!,
      regimeAfter: regimeAfter!,
      greeks: greeks ?? null,
    });
    if (!assessment) {
      return Response.json({ error: "AI risk read unavailable" }, { status: 502 });
    }
    return Response.json(assessment, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI risk read failed";
    return Response.json({ error: message }, { status: 502 });
  }
}
