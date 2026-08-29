import { NextRequest, NextResponse } from "next/server";
import { executeLiveHedge, getWalletStatus, type HedgeRequest } from "@/lib/hedge";

export async function GET() {
  try {
    const status = await getWalletStatus();
    return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to get wallet status" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { asset, targetStrike, amountUsdc } = body;

    const requestParams: HedgeRequest = {
      asset: asset || "ETH",
      targetStrike: targetStrike ? Number(targetStrike) : undefined,
      amountUsdc: amountUsdc ? Number(amountUsdc) : 1,
    };

    const result = await executeLiveHedge(requestParams);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Hedging execution failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
