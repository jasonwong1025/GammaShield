import { getTradeQuote, type TradeSide } from "@/lib/trade";
import { isOptionsAsset, type Asset } from "@/lib/assets";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const asset = params.get("asset") as Asset | null;
  const side = params.get("side") as TradeSide | null;
  const contracts = Number(params.get("contracts") ?? "0");
  const days = Number(params.get("days") ?? "7");

  if (!asset || !isOptionsAsset(asset)) {
    return Response.json({ error: "asset must have a live options book" }, { status: 400 });
  }
  if (side !== "call" && side !== "put") {
    return Response.json({ error: "side must be call or put" }, { status: 400 });
  }
  if (!Number.isFinite(contracts) || contracts < 0 || contracts > 1e6) {
    return Response.json({ error: "invalid contracts" }, { status: 400 });
  }

  try {
    const quote = await getTradeQuote(asset, side, contracts, days);
    return Response.json(quote, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "quote failed";
    return Response.json({ error: message }, { status: 502 });
  }
}
