import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isAddress } from "viem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Network = "mainnet" | "sepolia";
type Latest = { account: string; outcome: string; detail: string | null; userOpHash: string | null; score: number | null; threshold: number | null; checkedAt: string };
type Recent = { account: string; userOpHash: string; submittedAt: string; checkedAt: string; status: "confirmed" | "reverted"; transactionHash: string | null };

export async function GET(request: Request) {
  const url = new URL(request.url);
  const network = url.searchParams.get("network");
  const account = url.searchParams.get("account");
  if ((network !== "mainnet" && network !== "sepolia") || !account || !isAddress(account)) return Response.json({ error: "valid network and account are required" }, { status: 400 });

  const journal = await readJournal(network);
  const key = account.toLowerCase();
  const latest = journal?.latest[key] ?? null;
  const recent = journal?.recent.find((entry) => entry.account.toLowerCase() === key) ?? null;
  const intervalSeconds = pollInterval(network);
  const stale = latest ? Date.now() - Date.parse(latest.checkedAt) > intervalSeconds * 3_000 : false;
  return Response.json({
    mode: network === "mainnet" ? "thetanuts" : "shadow",
    dryRun: network === "mainnet" && process.env.BASE_AGENT_DRY_RUN !== "false",
    command: network === "mainnet" ? "npm run agent:thetanuts" : "npm run agent:shadow",
    worker: journal == null ? "not-reporting" : journal.lastErrorAt ? "error" : stale ? "stale" : latest ? "checking" : "awaiting-first-check",
    latest,
    recent,
  }, { headers: { "Cache-Control": "no-store" } });
}

async function readJournal(network: Network): Promise<{ latest: Record<string, Latest>; recent: Recent[]; lastErrorAt: string | null } | null> {
  try {
    const statePath = network === "mainnet"
      ? join(process.cwd(), ".base-agent", "state.json")
      : join(process.cwd(), ".shadow-agent", "state.json");
    const value: unknown = JSON.parse(await readFile(statePath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const state = value as { latest?: unknown; recent?: unknown; lastErrorAt?: unknown };
    return { latest: latestEntries(state.latest), recent: recentEntries(state.recent), lastErrorAt: typeof state.lastErrorAt === "string" ? state.lastErrorAt : null };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

function latestEntries(value: unknown): Record<string, Latest> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => isLatest(key, entry) ? [[key.toLowerCase(), entry]] : []));
}

function recentEntries(value: unknown): Recent[] {
  return Array.isArray(value) ? value.filter(isRecent) : [];
}

function isLatest(key: string, value: unknown): value is Latest {
  return isAddress(key) && !!value && typeof value === "object" && !Array.isArray(value) &&
    typeof (value as Latest).account === "string" && typeof (value as Latest).outcome === "string" && typeof (value as Latest).checkedAt === "string";
}

function isRecent(value: unknown): value is Recent {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    typeof (value as Recent).account === "string" && typeof (value as Recent).userOpHash === "string" &&
    ((value as Recent).status === "confirmed" || (value as Recent).status === "reverted");
}

function pollInterval(network: Network) {
  const value = Number(process.env[network === "mainnet" ? "BASE_AGENT_INTERVAL_SECONDS" : "SHADOW_AGENT_INTERVAL_SECONDS"] ?? "15");
  return Number.isInteger(value) && value >= 10 && value <= 60 ? value : 15;
}
