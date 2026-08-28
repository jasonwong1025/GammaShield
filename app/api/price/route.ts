import { getLivePrices } from "@/lib/snapshot";

export async function GET() {
  try {
    const ticker = await getLivePrices();
    return Response.json({ ticker, ts: Date.now() }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "price fetch failed";
    return Response.json({ error: message }, { status: 502 });
  }
}
