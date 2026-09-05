// DEMO ONLY — a one-click stand-in for `npm run agent:shadow` so a live
// presentation doesn't need a second terminal running the poll loop. It runs
// the exact same `runShadowAgents` the worker script calls every tick; nothing
// about the decision, the mandate guard, or the signature is different.
//
// Refuses outside development so this can never ship reachable from a real
// deployment, and only ever touches the Base Sepolia shadow book — never
// mainnet — regardless of what network the caller claims.
//
// Delete this route (and the button in AgentMonitoringPanel.tsx that calls it)
// after the presentation.

import { runShadowAgents } from "@/lib/shadowAgent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  if (process.env.NODE_ENV === "production") {
    return Response.json({ error: "the demo agent trigger is disabled outside development" }, { status: 403 });
  }
  try {
    return Response.json(await runShadowAgents({}), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "shadow agent tick failed" }, { status: 502 });
  }
}
