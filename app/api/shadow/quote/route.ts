import { NextRequest, NextResponse } from "next/server";
import { getShadowQuote } from "@/lib/shadow";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  try {
    const side = searchParams.get("side");
    if (side !== "call" && side !== "put") throw new Error("invalid option side");
    const quote = await getShadowQuote(
      searchParams.get("asset") ?? "",
      searchParams.get("buyer") ?? "",
      side,
      Number(searchParams.get("contracts") ?? "1"),
      Number(searchParams.get("period") ?? "7"),
    );
    return NextResponse.json(quote, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "failed to prepare shadow quote" },
      { status: 400 },
    );
  }
}
