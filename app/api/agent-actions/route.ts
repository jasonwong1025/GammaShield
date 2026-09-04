// Read and set the AI agent's action toggles for one policy account.
//
// Reads are public — the switches are not a secret. Writes require a signature
// that recovers to the account's on-chain owner, so nobody else can switch an
// action back on. See lib/agentActionStore.ts for why this is off-chain.

import { isAddress, type Address } from "viem";
import { AGENT_ACTIONS, type AgentAction } from "@/lib/autonomous/policy";
import { readAgentActions, writeAgentActions } from "@/lib/autonomous/actions";

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
  return Response.json(await readAgentActions(chain, account), { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  let body: { network?: unknown; account?: unknown; actions?: unknown; updatedAt?: unknown; signature?: unknown };
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
  const actions = parseActions(body.actions);
  if (!actions || !Number.isSafeInteger(body.updatedAt)) {
    return Response.json({ error: "actions and updatedAt are required" }, { status: 400 });
  }

  try {
    const state = await writeAgentActions(
      chain,
      account as Address,
      { actions, updatedAt: body.updatedAt as number },
      signature as `0x${string}`,
    );
    return Response.json(state, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "could not save the switches" }, { status: 400 });
  }
}

function parseActions(value: unknown): Record<AgentAction, boolean> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (!AGENT_ACTIONS.every((action) => typeof source[action] === "boolean")) return null;
  return Object.fromEntries(AGENT_ACTIONS.map((action) => [action, source[action] as boolean])) as Record<AgentAction, boolean>;
}
