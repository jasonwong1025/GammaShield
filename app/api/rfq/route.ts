import { prepareRfq, rfqStatus, prepareSettle } from "@/lib/rfq";
import { getClient } from "@/lib/snapshot";
import { isOptionsAsset, type Asset } from "@/lib/assets";
import { TRADE_PERIODS, type TradePeriod, type TradeSide } from "@/lib/trade";
import { ethers } from "ethers";

type Body = {
  action: "prepare" | "status" | "settle";
  address?: string;
  asset?: Asset;
  side?: TradeSide;
  contracts?: number;
  period?: TradePeriod;
  id?: string;
  offeror?: string;
};

const rfqExecutionEnabled = process.env.ENABLE_RFQ_EXECUTION === "true";

export async function POST(request: Request) {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const address = body.address;
  if (!address || !ethers.isAddress(address)) {
    return Response.json({ error: "valid address required" }, { status: 400 });
  }

  try {
    if (body.action === "prepare") {
      if (!rfqExecutionEnabled) {
        return Response.json({ error: "RFQ execution is disabled pending a separate escrow-flow audit" }, { status: 403 });
      }
      const { asset, side, contracts, period } = body;
      if (!asset || !isOptionsAsset(asset)) {
        return Response.json({ error: "asset must have a live options book" }, { status: 400 });
      }
      if (side !== "call" && side !== "put") {
        return Response.json({ error: "side must be call or put" }, { status: 400 });
      }
      if (!Number.isFinite(contracts) || contracts! <= 0 || contracts! > 1e6) {
        return Response.json({ error: "invalid contracts" }, { status: 400 });
      }
      const resolvedPeriod = period ?? 7;
      if (!TRADE_PERIODS.includes(resolvedPeriod)) {
        return Response.json({ error: `period must be one of ${TRADE_PERIODS.join(", ")}` }, { status: 400 });
      }
      const prepared = await prepareRfq(asset, side, contracts!, resolvedPeriod, address);
      return Response.json(prepared, { headers: { "cache-control": "no-store" } });
    }

    if (body.action === "status") {
      const market = await getClient().api.getMarketData();
      const status = await rfqStatus(address, market.prices);
      return Response.json({ rfq: status }, { headers: { "cache-control": "no-store" } });
    }

    if (body.action === "settle") {
      if (!rfqExecutionEnabled) {
        return Response.json({ error: "RFQ execution is disabled pending a separate escrow-flow audit" }, { status: 403 });
      }
      if (!body.id || !body.offeror || !ethers.isAddress(body.offeror)) {
        return Response.json({ error: "id and offeror required" }, { status: 400 });
      }
      const txs = await prepareSettle(address, body.id, body.offeror);
      return Response.json(txs, { headers: { "cache-control": "no-store" } });
    }

    return Response.json({ error: "unknown action" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "rfq request failed";
    return Response.json({ error: message }, { status: 502 });
  }
}
