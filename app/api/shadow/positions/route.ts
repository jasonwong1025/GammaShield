import { NextRequest, NextResponse } from "next/server";
import { getShadowPositions } from "@/lib/shadow";

export async function GET(request: NextRequest) {
  try {
    const buyers = [...new Set(request.nextUrl.searchParams.getAll("buyer").filter(Boolean))];
    if (!buyers.length || buyers.length > 2) return NextResponse.json({ error: "one or two buyer addresses are required" }, { status: 400 });
    const positions = await getShadowPositions(buyers);
    return NextResponse.json({ positions }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load shadow positions";
    const status = message === "invalid buyer address" ? 400 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
