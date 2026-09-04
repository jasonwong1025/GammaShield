import { createAiMandateDraft } from "@/lib/mandateDraft";

// GonkaRouter's advisory call can legitimately take up to ~45s (see
// lib/mandateDraft.ts); the platform's default function timeout is shorter
// than that, and would kill the request before the Gonka call ever gets a
// chance to complete or fall back cleanly.
export const maxDuration = 60;

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
