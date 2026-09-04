// Where a position's objective and trading thesis live.
//
// Nothing on-chain records why a position was opened. An option contract knows
// its strike, expiry and size; it does not know that someone bought it because
// they expected a rally into month end. So the thesis has to be captured from
// the user and stored here — which means positions opened before this feature,
// or opened outside GammaShield, genuinely have none, and the decision layer
// has to cope with that rather than assume a default view.
//
// Kept off-chain, deliberately, for the same reason as the action toggles: the
// signed mandate is a spending limit, and a target price is a revisable
// opinion. Freezing an opinion into an EIP-712 struct would mean re-signing a
// mandate to change one's mind.
//
// Off-chain does not mean unauthenticated. A write is accepted only with a
// signature recovering to the policy account's on-chain `owner()`, and only
// when newer than what is stored, so a stale payload cannot be replayed to
// restore an abandoned view.
//
// Two scopes, matching how the two are actually used:
//   - a STANDING thesis, set once with the mandate, applying to positions the
//     agent opens for itself;
//   - a PER-POSITION thesis, captured at entry, which overrides it.

import "server-only";

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createPublicClient, http, isAddress, recoverMessageAddress, type Address } from "viem";
import { base, baseSepolia } from "viem/chains";
import type { NetworkKind } from "./policy";
import type { TradingThesis } from "./types";
import { isThesis, thesisMessage } from "./thesisRules";

// Re-exported so callers have one import for "the thesis", store and rules
// alike, without needing to know which half lives where.
export { describeThesis, evaluateThesis, isThesis, targetReached, thesisMessage } from "./thesisRules";

const FRESHNESS_SECONDS = 600;

export type ThesisRecord = {
  /** The standing view, applied to anything without its own. */
  standing: TradingThesis | null;
  /** Per-position overrides, keyed by position id. */
  positions: Record<string, TradingThesis>;
  updatedAt: number;
};

export const EMPTY_THESIS_RECORD: ThesisRecord = { standing: null, positions: {}, updatedAt: 0 };

const statePath = (network: NetworkKind) =>
  join(process.cwd(), network === "mainnet" ? ".base-agent" : ".shadow-agent", "agent-thesis.json");

export async function readThesisRecord(network: NetworkKind, account: string): Promise<ThesisRecord> {
  const all = await readAll(network);
  return all[account.toLowerCase()] ?? { ...EMPTY_THESIS_RECORD, positions: {} };
}

/** The thesis governing one position: its own if it has one, else the standing
 *  view, else null — which the decision layer must treat as "no view", never
 *  as a neutral one. */
export function thesisFor(record: ThesisRecord, positionId: string | null): TradingThesis | null {
  if (positionId && record.positions[positionId]) return record.positions[positionId]!;
  return record.standing;
}

export async function writeThesisRecord(
  network: NetworkKind,
  account: Address,
  record: ThesisRecord,
  signature: `0x${string}`,
): Promise<ThesisRecord> {
  if (!isAddress(account)) throw new Error("invalid policy account");
  if (!isRecord(record)) throw new Error("malformed thesis");
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(record.updatedAt) || Math.abs(now - record.updatedAt) > FRESHNESS_SECONDS) {
    throw new Error("this signature is too old to apply; sign the thesis again");
  }

  const existing = await readThesisRecord(network, account);
  if (record.updatedAt <= existing.updatedAt) throw new Error("a newer thesis is already stored");

  const signer = await recoverMessageAddress({ message: thesisMessage(account, network, record), signature });
  const owner = await readOwner(network, account);
  if (signer.toLowerCase() !== owner.toLowerCase()) throw new Error("only the policy account owner can change the thesis");

  const all = await readAll(network);
  all[account.toLowerCase()] = record;
  const path = statePath(network);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(all, null, 2), "utf8");
  return record;
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

async function readAll(network: NetworkKind): Promise<Record<string, ThesisRecord>> {
  try {
    const value: unknown = JSON.parse(await readFile(statePath(network), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
        isRecord(entry) ? [[key.toLowerCase(), entry]] : [],
      ),
    );
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is ThesisRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as ThesisRecord;
  if (!Number.isSafeInteger(record.updatedAt)) return false;
  if (record.standing !== null && !isThesis(record.standing)) return false;
  if (!record.positions || typeof record.positions !== "object" || Array.isArray(record.positions)) return false;
  return Object.values(record.positions).every(isThesis);
}


