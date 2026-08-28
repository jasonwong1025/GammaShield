import { getMarketSnapshot } from "@/lib/snapshot";

export async function GET() {
  try {
    const snapshot = await getMarketSnapshot();
    return Response.json(snapshot, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "snapshot failed";
    return Response.json({ error: message }, { status: 502 });
  }
}
