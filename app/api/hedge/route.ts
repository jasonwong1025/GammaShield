import { NextRequest, NextResponse } from "next/server";
import {
  executeLiveHedge,
  setAutopilotEnabled,
  checkAndExecuteAutopilot,
  type HedgeRequest,
} from "@/lib/hedge";
import type { Asset } from "@/lib/assets";

export async function GET() {
  return Response.json({ mode: "user-signed", message: "Use the trade panel to review and sign every mainnet fill." });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { action, enabled, asset, targetStrike, amountUsdc, fragilityScore } = body;

    // Handle Autopilot Toggle
    if (action === "toggleAutopilot") {
      const updatedStatus = setAutopilotEnabled(Boolean(enabled));
      return NextResponse.json({ success: true, autopilot: updatedStatus }, { headers: { "Cache-Control": "no-store" } });
    }

    // Handle Background Autopilot Trigger Check
    if (action === "checkAutopilot") {
      const checkResult = await checkAndExecuteAutopilot((asset || "ETH") as Asset, Number(fragilityScore) || 50);
      return NextResponse.json(checkResult, { headers: { "Cache-Control": "no-store" } });
    }

    // Standard Copilot 1-Click Execution
    const requestParams: HedgeRequest = {
      asset: asset || "ETH",
      targetStrike: targetStrike ? Number(targetStrike) : undefined,
      amountUsdc: amountUsdc ? Number(amountUsdc) : 1,
      isAutopilot: false,
    };

    const result = await executeLiveHedge(requestParams);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Hedging execution failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
