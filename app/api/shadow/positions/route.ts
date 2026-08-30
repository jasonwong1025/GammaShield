import { NextRequest, NextResponse } from "next/server";
import { getShadowPositions } from "@/lib/shadow";

export async function GET(request: NextRequest) {
  try {
    const buyer = request.nextUrl.searchParams.get("buyer");
    if (!buyer) return NextResponse.json({ error: "buyer is required" }, { status: 400 });
    const positions = await getShadowPositions(buyer);
    return NextResponse.json({ positions }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load shadow positions";
    const status = message === "invalid buyer address" ? 400 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
