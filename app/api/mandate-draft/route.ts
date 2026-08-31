import { createAiMandateDraft } from "@/lib/mandateDraft";

export async function POST(request: Request) {
  let body: { asset?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (body.asset !== "BTC" && body.asset !== "ETH") {
    return Response.json({ error: "asset must have a live Thetanuts options book" }, { status: 400 });
  }
  try {
    return Response.json({ draft: await createAiMandateDraft(body.asset) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "AI draft failed" }, { status: 502 });
  }
}
