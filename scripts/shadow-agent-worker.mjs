import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const config = runtimeConfig();
let stopping = false;

process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

console.log(`${config.label} agent worker started (${config.dryRun ? "dry run" : "broadcast enabled"}); polling every ${config.intervalMs / 1_000}s.`);
await run();

async function run() {
  while (!stopping) {
    const startedAt = Date.now();
    try {
      await tick();
    } catch (error) {
      await recordFailure().catch(() => undefined);
      console.error(`${config.label} agent worker tick failed:`, error instanceof Error ? error.message : error);
    }
    const wait = Math.max(1_000, config.intervalMs - (Date.now() - startedAt));
    await sleep(wait);
  }
}

async function tick() {
  const state = await readState();
  let changed = false;
  for (const [account, pending] of Object.entries(state.pending)) {
    const receipt = await request(`${config.endpoint}?userOpHash=${encodeURIComponent(pending.userOpHash)}`);
    if (receipt.receipt == null) continue;
    delete state.pending[account];
    state.recent.unshift({ account, userOpHash: pending.userOpHash, submittedAt: pending.submittedAt, checkedAt: new Date().toISOString(), status: receipt.receipt?.success === true ? "confirmed" : "reverted", transactionHash: receipt.receipt?.receipt?.transactionHash ?? null });
    state.recent.splice(20);
    changed = true;
  }
  if (state.lastErrorAt) {
    state.lastErrorAt = null;
    changed = true;
  }
  if (changed) await writeState(state);

  const response = await request(config.endpoint, {
    pendingAccounts: Object.keys(state.pending),
    knownAccounts: state.accounts,
    discoveryFromBlock: state.scannedToBlock == null ? undefined : state.scannedToBlock + 1,
  });
  if (!Array.isArray(response.results) || !Array.isArray(response.accounts) || !Number.isSafeInteger(response.scannedToBlock)) throw new Error("shadow-agent endpoint returned an invalid result");
  const accounts = response.accounts.filter((account) => typeof account === "string" && /^0x[0-9a-fA-F]{40}$/.test(account));
  if (accounts.length !== response.accounts.length || accounts.length > 1_000) throw new Error("shadow-agent endpoint returned an invalid account list");
  if (JSON.stringify(accounts) !== JSON.stringify(state.accounts) || state.scannedToBlock !== response.scannedToBlock) {
    state.accounts = accounts;
    state.scannedToBlock = response.scannedToBlock;
    changed = true;
  }
  for (const result of response.results) {
    if (!isResult(result) || state.pending[result.account]) continue;
    const key = result.account.toLowerCase();
    const previous = state.latest[key];
    state.latest[key] = {
      account: result.account,
      outcome: result.outcome,
      detail: typeof result.detail === "string" ? result.detail : null,
      userOpHash: typeof result.userOpHash === "string" ? result.userOpHash : null,
      score: typeof result.score === "number" ? result.score : null,
      threshold: typeof result.threshold === "number" ? result.threshold : null,
      checkedAt: new Date().toISOString(),
    };
    changed = true;
    if (!result.userOpHash) {
      if (previous?.outcome !== result.outcome || previous?.detail !== result.detail) console.log(`${result.account} ${result.outcome}: ${result.detail ?? "waiting"}`);
      continue;
    }
    state.pending[result.account] = { userOpHash: result.userOpHash, submittedAt: new Date().toISOString(), outcome: result.outcome };
    console.log(`${result.account} ${result.outcome}: ${result.userOpHash}`);
  }
  if (changed) await writeState(state);
  if (changed) console.log(`${config.label} agent scan: ${state.accounts.length} policy account${state.accounts.length === 1 ? "" : "s"}; indexed through block ${state.scannedToBlock}.`);
}

async function request(path, body) {
  const response = await fetch(new URL(path, config.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${config.secret}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || typeof payload !== "object") throw new Error(payload?.error ?? `agent endpoint returned ${response.status}`);
  return payload;
}

async function readState() {
  try {
    const value = JSON.parse(await readFile(config.statePath, "utf8"));
    if (!isState(value)) throw new Error("invalid state journal");
    return {
      ...value,
      accounts: Array.isArray(value.accounts) && value.accounts.length <= 1_000 && value.accounts.every((account) => typeof account === "string" && /^0x[0-9a-fA-F]{40}$/.test(account)) ? value.accounts : [],
      scannedToBlock: Number.isSafeInteger(value.scannedToBlock) && value.scannedToBlock >= 0 ? value.scannedToBlock : null,
      latest: isLatest(value.latest) ? value.latest : {},
      lastErrorAt: typeof value.lastErrorAt === "string" ? value.lastErrorAt : null,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
}

async function writeState(state) {
  await mkdir(dirname(config.statePath), { recursive: true });
  const temporary = `${config.statePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, config.statePath);
}

function isState(value) {
  return value && typeof value === "object" && value.version === 1 && value.pending && typeof value.pending === "object" && !Array.isArray(value.pending) && Array.isArray(value.recent) &&
    Object.entries(value.pending).every(([account, pending]) => /^0x[0-9a-fA-F]{40}$/.test(account) && pending && typeof pending === "object" && /^0x[0-9a-fA-F]{64}$/.test(pending.userOpHash) && typeof pending.submittedAt === "string" && typeof pending.outcome === "string");
}

function emptyState() {
  return { version: 1, pending: {}, recent: [], accounts: [], scannedToBlock: null, latest: {}, lastErrorAt: null };
}

function isResult(value) {
  return value && typeof value === "object" && typeof value.account === "string" && /^0x[0-9a-fA-F]{40}$/.test(value.account) && typeof value.outcome === "string" && (value.userOpHash === undefined || /^0x[0-9a-fA-F]{64}$/.test(value.userOpHash));
}

function isLatest(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.entries(value).every(([account, entry]) =>
    /^0x[0-9a-fA-F]{40}$/.test(account) && entry && typeof entry === "object" && typeof entry.account === "string" && typeof entry.outcome === "string" && typeof entry.checkedAt === "string",
  );
}

async function recordFailure() {
  const state = await readState();
  state.lastErrorAt = new Date().toISOString();
  await writeState(state);
}

function runtimeConfig() {
  const thetanuts = process.env.POLICY_AGENT_MODE === "thetanuts";
  const prefix = thetanuts ? "BASE_AGENT" : "SHADOW_AGENT";
  const url = process.env[`${prefix}_URL`];
  const secret = process.env[`${prefix}_CRON_SECRET`];
  const seconds = Number(process.env[`${prefix}_INTERVAL_SECONDS`] ?? "15");
  const maximumSeconds = thetanuts ? 15 : 60;
  if (!url || !secret || !Number.isInteger(seconds) || seconds < 10 || seconds > maximumSeconds) throw new Error(`set ${prefix}_URL, ${prefix}_CRON_SECRET, and a 10-${maximumSeconds} second ${prefix}_INTERVAL_SECONDS`);
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw new Error(`${prefix}_URL must be an http(s) origin without credentials`);
  return { url: parsed, secret, endpoint: thetanuts ? "/api/thetanuts/agent" : "/api/shadow/agent", label: thetanuts ? "Thetanuts" : "Shadow", dryRun: thetanuts && process.env.BASE_AGENT_DRY_RUN !== "false", intervalMs: seconds * 1_000, statePath: resolve(process.cwd(), process.env[`${prefix}_STATE_PATH`] ?? (thetanuts ? ".base-agent/state.json" : ".shadow-agent/state.json")) };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
