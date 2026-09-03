// Where the AI agent's action toggles live.
//
// The toggles are deliberately NOT part of the signed on-chain mandate: adding
// them would change the EIP-712 type and orphan every policy account already
// deployed. They are an off-chain restriction layered on top, and they can only
// ever subtract — a registered policy already permits every action its network
// supports, and switching one off stops the agent from choosing it.
//
// That still has to be real, not a checkbox in someone's browser. A change is
// accepted only when it carries a signature that recovers to the policy
// account's on-chain `owner()`, and only when it is newer than the stored one,
// so an old payload cannot be replayed to switch an action back on.
//
// The on-chain off switch remains pause/revoke. This file is a preference
// store, and the UI says so.

import "server-only";

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createPublicClient, http, isAddress, recoverMessageAddress, type Address } from "viem";
import { base, baseSepolia } from "viem/chains";
import { AGENT_ACTIONS, type AgentAction, type NetworkKind } from "./policy";

/** A signed payload is only accepted this close to the moment it was signed. */
const FRESHNESS_SECONDS = 600;

export type AgentActionState = { actions: Record<AgentAction, boolean>; updatedAt: number };

export const ALL_ACTIONS_ON: Record<AgentAction, boolean> = { hedge: true, close: true, roll: true };

const statePath = (network: NetworkKind) =>
  join(process.cwd(), network === "mainnet" ? ".base-agent" : ".shadow-agent", "agent-actions.json");

/**
 * The message the owner signs. Deterministic and readable in a wallet prompt,
 * so someone approving it can see exactly which switches they are setting.
 */
export function actionMessage(account: Address, network: NetworkKind, state: AgentActionState): string {
  const actions = AGENT_ACTIONS.map((action) => `${action}=${state.actions[action] ? "on" : "off"}`).join(",");
  return [
    "GammaShield agent actions",
    `account: ${account.toLowerCase()}`,
    `network: ${network}`,
    `actions: ${actions}`,
    `updatedAt: ${state.updatedAt}`,
  ].join("\n");
}

/** Stored toggles for one account. Everything on when nothing has been saved. */
export async function readAgentActions(network: NetworkKind, account: string): Promise<AgentActionState> {
  const all = await readAll(network);
  return all[account.toLowerCase()] ?? { actions: { ...ALL_ACTIONS_ON }, updatedAt: 0 };
}

export async function writeAgentActions(
  network: NetworkKind,
  account: Address,
  state: AgentActionState,
  signature: `0x${string}`,
): Promise<AgentActionState> {
  if (!isAddress(account)) throw new Error("invalid policy account");
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(state.updatedAt) || Math.abs(now - state.updatedAt) > FRESHNESS_SECONDS) {
    throw new Error("this signature is too old to apply; sign the switches again");
  }

  const existing = await readAgentActions(network, account);
  if (state.updatedAt <= existing.updatedAt) throw new Error("a newer setting is already stored");

  const signer = await recoverMessageAddress({ message: actionMessage(account, network, state), signature });
  const owner = await readOwner(network, account);
  if (signer.toLowerCase() !== owner.toLowerCase()) throw new Error("only the policy account owner can change these switches");

  const all = await readAll(network);
  all[account.toLowerCase()] = state;
  const path = statePath(network);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(all, null, 2), "utf8");
  return state;
}

async function readOwner(network: NetworkKind, account: Address): Promise<Address> {
  const rpcUrl = network === "mainnet" ? process.env.BASE_RPC_URL : process.env.BASE_SEPOLIA_RPC_URL;
  const client = createPublicClient({ chain: network === "mainnet" ? base : baseSepolia, transport: http(rpcUrl) });
  return client.readContract({
    address: account,
    abi: [{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
    functionName: "owner",
  });
}

async function readAll(network: NetworkKind): Promise<Record<string, AgentActionState>> {
  try {
    const value: unknown = JSON.parse(await readFile(statePath(network), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => (isState(entry) ? [[key.toLowerCase(), entry]] : [])),
    );
  } catch {
    return {};
  }
}

function isState(value: unknown): value is AgentActionState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as AgentActionState;
  return (
    Number.isSafeInteger(state.updatedAt) &&
    !!state.actions &&
    typeof state.actions === "object" &&
    AGENT_ACTIONS.every((action) => typeof state.actions[action] === "boolean")
  );
}
