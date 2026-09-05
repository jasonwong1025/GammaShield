// DEMO ONLY — a one-click stand-in for `npm run agent:shadow` so a live
// presentation doesn't need a second terminal running the poll loop, and
// works from a deployed Vercel URL where no such terminal exists at all. It
// runs the exact same `runShadowAgents` the worker script calls every tick.
// Nothing about the decision, the mandate guard, or the signature differs
// from the worker script.
//
// The response carries the real results directly, rather than only writing
// them to `.shadow-agent/state.json` for /api/agent-status to read back:
// Vercel's serverless functions have no shared, persistent filesystem across
// invocations, so a later request cannot rely on an earlier one's file write.
// The journal write below is kept as a best-effort local-dev convenience
// (it's what makes the passive Monitoring panel update between clicks when
// running `next dev`) and is not allowed to affect this response either way.
//
// Gated by ALLOW_DEMO_AGENT_TRIGGER rather than NODE_ENV, because Next.js
// sets NODE_ENV=production for every Vercel build (Preview included), which
// would otherwise disable this on the very deployment it's meant to demo
// from. Never enable this on a deployment that also serves real users —
// it lets any caller who can reach this URL spend this deployment's agent
// key's gas and cycle through every registered shadow policy account.
//
// Delete this route (and the button in AgentMonitoringPanel.tsx that calls
// it, and the ALLOW_DEMO_AGENT_TRIGGER env var) once the demo is over.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runShadowAgents, type ShadowAgentResult } from "@/lib/shadowAgent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_PATH = join(process.cwd(), ".shadow-agent", "state.json");

type Journal = {
  version: 1;
  pending: Record<string, { userOpHash: string; submittedAt: string; outcome: string }>;
  recent: unknown[];
  accounts: string[];
  scannedToBlock: number | null;
  latest: Record<string, Record<string, unknown>>;
  lastErrorAt: string | null;
};

export async function POST(request: Request) {
  const allowed = process.env.NODE_ENV !== "production" || process.env.ALLOW_DEMO_AGENT_TRIGGER === "true";
  if (!allowed) {
    return Response.json({ error: "the demo agent trigger is not enabled on this deployment" }, { status: 403 });
  }
  const account = await requestedAccount(request);
  let results: ShadowAgentResult[];
  try {
    const state = await readJournal();

    // Discovery is the expensive half of a tick: it walks the factory's
    // AccountCreated logs ten blocks per eth_getLogs, up to 2,000 blocks — as
    // many as 200 calls. The worker amortises that by resuming from its last
    // scanned block; this route has to do the same, or every click rescans
    // from the factory's deployment block and burns the provider's throughput
    // budget for nothing. Where the journal cannot persist (serverless), it
    // has no progress to resume from, so a caller that already knows which
    // account it wants can name it and skip discovery altogether.
    const resumeFrom = state.scannedToBlock == null ? undefined : state.scannedToBlock + 1;
    const skipDiscovery = account !== null && resumeFrom === undefined;
    const outcome = await runShadowAgents({
      knownAccounts: account ? [account] : state.accounts,
      discoveryFromBlock: skipDiscovery ? Number.MAX_SAFE_INTEGER : resumeFrom,
    });
    results = outcome.results;

    // Best-effort only: Vercel's filesystem for this may be read-only or
    // reset on the next invocation, and either way must never turn a real,
    // successful tick into a reported failure.
    try {
      // A skipped scan reports a `scannedToBlock` past the chain tip, which
      // would tell the worker it had already indexed blocks nobody read.
      if (!skipDiscovery) {
        state.accounts = outcome.accounts;
        state.scannedToBlock = outcome.scannedToBlock;
      }
      state.lastErrorAt = null;
      for (const result of results) applyResult(state, result);
      await writeJournal(state);
    } catch {
      // Ephemeral or read-only filesystem — the response below still carries
      // the real results, so the caller loses nothing.
    }
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "shadow agent tick failed" }, { status: 502 });
  }
  return Response.json({ results }, { headers: { "Cache-Control": "no-store" } });
}

/** The policy account the caller is watching, when it named one. */
async function requestedAccount(request: Request): Promise<string | null> {
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) return null;
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = (body as { account?: unknown }).account;
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) ? value : null;
}

function applyResult(state: Journal, result: ShadowAgentResult) {
  const key = result.account.toLowerCase();
  state.latest[key] = {
    account: result.account,
    outcome: result.outcome,
    detail: result.detail ?? null,
    userOpHash: result.userOpHash ?? null,
    score: result.score ?? null,
    threshold: result.threshold ?? null,
    health: result.health ?? null,
    decision: result.decision ?? null,
    checkedAt: new Date().toISOString(),
  };
  if (result.userOpHash) {
    state.pending[result.account] = { userOpHash: result.userOpHash, submittedAt: new Date().toISOString(), outcome: result.outcome };
  }
}

async function readJournal(): Promise<Journal> {
  try {
    const value = JSON.parse(await readFile(STATE_PATH, "utf8")) as Partial<Journal>;
    return {
      version: 1,
      pending: value.pending && typeof value.pending === "object" ? value.pending : {},
      recent: Array.isArray(value.recent) ? value.recent : [],
      accounts: Array.isArray(value.accounts) ? value.accounts : [],
      scannedToBlock: typeof value.scannedToBlock === "number" ? value.scannedToBlock : null,
      latest: value.latest && typeof value.latest === "object" ? value.latest : {},
      lastErrorAt: null,
    };
  } catch {
    return { version: 1, pending: {}, recent: [], accounts: [], scannedToBlock: null, latest: {}, lastErrorAt: null };
  }
}

async function writeJournal(state: Journal) {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  const temporary = `${STATE_PATH}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, STATE_PATH);
}
