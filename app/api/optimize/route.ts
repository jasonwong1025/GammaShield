import { NextRequest, NextResponse } from "next/server";
import { getOptimalPutHedge } from "@/lib/optimizer";
import type { Asset } from "@/lib/assets";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const asset = (searchParams.get("asset") || "ETH") as Asset;
    const spotParam = searchParams.get("spot");
    const customSpot = spotParam ? Number(spotParam) : undefined;

    const recommendation = await getOptimalPutHedge(asset, customSpot);
    return NextResponse.json(recommendation, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Optimization failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const asset = (body.asset || "ETH") as Asset;
    const customSpot = body.spotPrice ? Number(body.spotPrice) : undefined;

    const recommendation = await getOptimalPutHedge(asset, customSpot);
    return NextResponse.json(recommendation, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Optimization failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
