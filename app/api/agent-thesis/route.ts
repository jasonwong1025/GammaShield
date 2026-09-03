// Read and set the objective and trading thesis behind an account's positions.
//
// Reads are public: the view is not a secret, and the agent's reasoning is
// meant to be inspectable. Writes require a signature that recovers to the
// account's on-chain owner, so nobody else can rewrite why a position exists —
// which, since a broken thesis can trigger an exit, would otherwise be a way
// to make someone else's agent sell.
//
// See lib/autonomous/thesis.ts for why this is off-chain rather than signed
// into the mandate.

import { isAddress, type Address } from "viem";
import { isThesis, readThesisRecord, writeThesisRecord, type ThesisRecord } from "@/lib/autonomous/thesis";
import type { TradingThesis } from "@/lib/autonomous/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const network = (value: unknown) => (value === "mainnet" || value === "sepolia" ? value : null);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const chain = network(url.searchParams.get("network"));
  const account = url.searchParams.get("account");
  if (!chain || !account || !isAddress(account)) {
    return Response.json({ error: "valid network and account are required" }, { status: 400 });
  }
  const record = await readThesisRecord(chain, account);
  return Response.json(
    { thesis: record.standing, positionTheses: record.positions, updatedAt: record.updatedAt },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request) {
  let body: {
    network?: unknown;
    account?: unknown;
    standing?: unknown;
    positions?: unknown;
    updatedAt?: unknown;
    signature?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const chain = network(body.network);
  const account = body.account;
  const signature = body.signature;
  if (!chain || typeof account !== "string" || !isAddress(account)) {
    return Response.json({ error: "valid network and account are required" }, { status: 400 });
  }
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return Response.json({ error: "an owner signature is required" }, { status: 400 });
  }
  if (!Number.isSafeInteger(body.updatedAt)) {
    return Response.json({ error: "updatedAt is required" }, { status: 400 });
  }
  const standing = body.standing === null || body.standing === undefined ? null : body.standing;
  if (standing !== null && !isThesis(standing)) {
    return Response.json({ error: "the standing view is malformed" }, { status: 400 });
  }
  const positions = parsePositions(body.positions);
  if (!positions) {
    return Response.json({ error: "the per-position views are malformed" }, { status: 400 });
  }

  const record: ThesisRecord = {
    standing: standing as TradingThesis | null,
    positions,
    updatedAt: body.updatedAt as number,
  };
  try {
    const saved = await writeThesisRecord(chain, account as Address, record, signature as `0x${string}`);
    return Response.json(
      { thesis: saved.standing, positionTheses: saved.positions, updatedAt: saved.updatedAt },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "could not save the view" }, { status: 400 });
  }
}

function parsePositions(value: unknown): Record<string, TradingThesis> | null {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([, thesis]) => isThesis(thesis))) return null;
  return Object.fromEntries(entries) as Record<string, TradingThesis>;
}
