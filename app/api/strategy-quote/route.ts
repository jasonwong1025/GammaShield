import { resolveStrategyQuote } from "@/lib/strategyQuote";
import { getStrategy } from "@/lib/strategy";
import { isOptionsAsset, type Asset } from "@/lib/assets";
import { TRADE_PERIODS, type TradePeriod } from "@/lib/tradePeriods";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const asset = params.get("asset") as Asset | null;
  const strategyId = params.get("strategyId");
  const contracts = Number(params.get("contracts") ?? "0");
  const period = Number(params.get("period") ?? "7") as TradePeriod;

  if (!asset || !isOptionsAsset(asset)) {
    return Response.json({ error: "asset must have a live options book" }, { status: 400 });
  }
  if (!strategyId || !getStrategy(strategyId)) {
    return Response.json({ error: "unknown strategyId" }, { status: 400 });
  }
  if (!Number.isFinite(contracts) || contracts <= 0 || contracts > 1e6) {
    return Response.json({ error: "invalid contracts" }, { status: 400 });
  }
  if (!TRADE_PERIODS.includes(period)) {
    return Response.json({ error: `period must be one of ${TRADE_PERIODS.join(", ")}` }, { status: 400 });
  }

  try {
    const quote = await resolveStrategyQuote(asset, strategyId, contracts, period);
    return Response.json(quote, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "strategy quote failed";
    return Response.json({ error: message }, { status: 502 });
  }
}
