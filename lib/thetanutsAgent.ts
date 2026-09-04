import "server-only";

import { ethers } from "ethers";
import { mandateAccountAbi } from "@/lib/generated/contracts";
import { getMarketSnapshot, type MarketSnapshot } from "@/lib/snapshot";
import { getTradeQuote } from "@/lib/trade";
import { TRADE_PERIODS } from "@/lib/tradePeriods";
import { getPolicyUserOperationReceipt, submitPolicyUserOperation } from "@/lib/policyAgent4337";
import { discoverPolicyAccounts } from "@/lib/policyAgentDiscovery";
import { getPositionMark, getThetanutsPositions } from "@/lib/positions";
import { readAgentActions } from "@/lib/autonomous/actions";
import { proposeAgentAction } from "@/lib/autonomous/proposal";
import {
  agentActionAvailability,
  isActionArmed,
  resolveAgentAction,
  type AgentLimits,
  type OpenPosition,
} from "@/lib/autonomous/policy";
import { decide, intentOf, type ManagedPosition } from "@/lib/autonomous/decision";
import { computePositionRisk, positionRiskBps } from "@/lib/autonomous/positionRisk";
import { riskTrendFrom } from "@/lib/autonomous/trend";
import { evaluateTriggers, type TriggerObservation } from "@/lib/autonomous/triggers";
import { evaluateThesis, readThesisRecord, targetReached, thesisFor } from "@/lib/autonomous/thesis";
import { positionHealthOf, type AutonomousDecision, type PositionHealth } from "@/lib/autonomous/types";

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const RISK_LIFETIME_SECONDS = 120;
const RISK_REFRESH_SECONDS = 90;
const BASE_OPTION_BOOK = "0x1bDff855d6811728acaDC00989e79143a2bdfDed";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FILL_ABI = ["function fillOrder((address maker,uint256 orderExpiryTimestamp,address collateral,bool isCall,address priceFeed,address implementation,bool isLong,uint256 maxCollateralUsable,uint256[] strikes,uint256 expiry,uint256 price,uint256 numContracts,bytes extraOptionData),bytes signature,address referrer) returns (address)"] as const;
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"] as const;

type Mandate = { agent: string; optionBook: string; collateral: string; asset: "BTC" | "ETH"; side: number; maxPremiumPerFill: bigint; maxPremiumTotal: bigint; maxContractsPerFill: bigint; minTenorSeconds: bigint; maxTenorSeconds: bigint; riskThresholdBps: bigint; positionRiskThresholdBps: bigint; persistenceSeconds: bigint; minExecutionIntervalSeconds: bigint; expiresAt: bigint };
type Control = { spentPremium: bigint; lastExecutionAt: bigint };
type RiskState = { scoreBps: bigint; eligibleSince: bigint; validUntil: bigint };
export type ThetanutsAgentResult = {
  account: string;
  mandateHash?: string;
  score?: number;
  threshold?: number;
  /** "recommendation" is mainnet-only: an exit this venue cannot execute. */
  outcome: "pending-user-operation" | "risk-below-threshold" | "risk-reset-submitted" | "risk-reset-simulated" | "risk-persistence-pending" | "gas-unfunded" | "risk-observation-submitted" | "risk-observation-simulated" | "quote-unavailable" | "fill-submitted" | "fill-simulated" | "holding" | "recommendation";
  userOpHash?: string;
  detail?: string;
  decision?: AutonomousDecision;
  health?: PositionHealth;
};

export async function runThetanutsAgents(options: { pendingAccounts?: Iterable<string>; knownAccounts?: Iterable<string>; discoveryFromBlock?: number } = {}) {
  const config = runtimeConfig();
  const provider = baseProvider(config.rpcUrl);
  const agent = new ethers.Wallet(config.privateKey);
  const factory = new ethers.Contract(config.factory, ["event AccountCreated(address indexed account,address indexed owner,bytes32 indexed salt)"], provider);
  const latestBlock = await provider.getBlockNumber();
  const discoveryFromBlock = Math.max(config.deploymentBlock, options.discoveryFromBlock ?? config.deploymentBlock);
  const discoveredAccounts = await discoverPolicyAccounts(factory, discoveryFromBlock, latestBlock);
  const knownAccounts = [...(options.knownAccounts ?? [])].filter((account): account is string => typeof account === "string" && ethers.isAddress(account)).map(ethers.getAddress);
  const accounts = [...new Set([...knownAccounts, ...discoveredAccounts])];
  const pendingAccounts = new Set([...(options.pendingAccounts ?? [])].filter((account): account is string => typeof account === "string" && ethers.isAddress(account)).map((account) => ethers.getAddress(account).toLowerCase()));
  const snapshot = await getMarketSnapshot({ fresh: true });
  const results: ThetanutsAgentResult[] = [];
  for (const account of accounts) {
    if (pendingAccounts.has(account.toLowerCase())) {
      results.push({ account, outcome: "pending-user-operation", detail: "The external worker is waiting for this account's prior UserOperation receipt." });
      continue;
    }
    const result = await runThetanutsAgent(account, config, provider, agent, snapshot);
    if (result) results.push(result);
  }
  return { results, accounts, scannedToBlock: latestBlock };
}

export async function getThetanutsUserOperationReceipt(userOpHash: string) {
  return getPolicyUserOperationReceipt(8453, runtimeConfig().pimlicoApiKey, userOpHash);
}

async function runThetanutsAgent(accountAddress: string, config: ReturnType<typeof runtimeConfig>, provider: ethers.Provider, agent: ethers.Wallet, snapshot: MarketSnapshot): Promise<ThetanutsAgentResult | null> {
  const account = new ethers.Contract(accountAddress, mandateAccountAbi, provider);
  const policy = await readPolicy(account, agent.address);
  if (!policy) return null;
  const score = snapshot.assets[policy.mandate.asset].score;
  const scoreBps = Math.round(score * 100);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const state = riskState(await account.riskStates(policy.hash));
  const base = { account: accountAddress, mandateHash: policy.hash, score, threshold: Number(policy.mandate.riskThresholdBps) / 100 };

  // The subject position, priced. Read before the attestation, which now
  // carries the position's own per-contract risk score.
  const nowSeconds = Number(now);
  const openPositions = await getThetanutsPositions(accountAddress).catch(() => []);
  const candidates = openPositions.filter(
    (position) => position.asset === policy.mandate.asset && !position.isCall && position.expiryTs > nowSeconds,
  );
  const subject = [...candidates].sort((a, b) => a.expiryTs - b.expiryTs)[0] ?? null;
  const mark = subject ? await getPositionMark(subject) : null;
  const spot = snapshot.prices[policy.mandate.asset];
  const managed: ManagedPosition | null = subject
    ? {
        id: subject.id,
        asset: policy.mandate.asset,
        isCall: subject.isCall,
        strike: subject.strike,
        expiryTs: subject.expiryTs,
        contracts: subject.contracts,
        // The indexer reports PnL, not the premium paid per contract.
        entryPremiumUsd: null,
        markUsd: mark?.bidUsd ?? mark?.markUsd ?? null,
        askUsd: mark?.askUsd ?? null,
        pnlUsd: subject.pnlUsd,
        // A mainnet OptionBook position is the user's own directional
        // exposure, not cover this agent opened, so a calmer book is not by
        // itself a reason to exit it.
        role: "directional",
      }
    : null;
  const positionRisk = managed
    ? computePositionRisk({ position: managed, spot, nowSec: nowSeconds, marketScore: score, contractDepthUsd: null })
    : null;

  const risk = { mandateHash: policy.hash, riskScoreBps: scoreBps, positionRiskScoreBps: positionRiskBps(positionRisk), observedAt: now, validUntil: now + BigInt(RISK_LIFETIME_SECONDS), persistenceSeconds: policy.mandate.persistenceSeconds };
  const riskSignature = await agent.signTypedData({ name: "GammaShield Risk", version: "1", chainId: 8453, verifyingContract: accountAddress }, { RiskAttestation: [{ name: "mandateHash", type: "bytes32" }, { name: "riskScoreBps", type: "uint16" }, { name: "positionRiskScoreBps", type: "uint16" }, { name: "observedAt", type: "uint64" }, { name: "validUntil", type: "uint64" }, { name: "persistenceSeconds", type: "uint64" }] }, risk);
  if (scoreBps < Number(policy.mandate.riskThresholdBps)) {
    if (state.scoreBps < policy.mandate.riskThresholdBps || state.validUntil < now) return { ...base, outcome: "risk-below-threshold" };
    return submitRisk(account, policy.hash, risk, riskSignature, provider, agent, accountAddress, config, config.dryRun ? "risk-reset-simulated" : "risk-reset-submitted", base);
  }
  if ((await provider.getBalance(accountAddress)) === 0n) return { ...base, outcome: "gas-unfunded", detail: "Fund the policy account with Base ETH before scheduling agent runs." };
  const persistent = state.eligibleSince !== 0n && state.scoreBps >= policy.mandate.riskThresholdBps && state.validUntil >= now && now >= state.eligibleSince + policy.mandate.persistenceSeconds;
  if (state.eligibleSince === 0n || state.scoreBps < policy.mandate.riskThresholdBps || state.validUntil <= now + BigInt(RISK_LIFETIME_SECONDS - RISK_REFRESH_SECONDS)) {
    return submitRisk(account, policy.hash, risk, riskSignature, provider, agent, accountAddress, config, config.dryRun ? "risk-observation-simulated" : "risk-observation-submitted", base);
  }
  if (!persistent) return { ...base, outcome: "risk-persistence-pending" };

  // Base mainnet executes exactly one of the three actions. The other two are
  // reported unavailable with a reason rather than silently skipped, and the
  // owner's stored switches can still narrow what is left.
  const [stored, thesisRecord, history] = await Promise.all([
    readAgentActions("mainnet", accountAddress),
    readThesisRecord("mainnet", accountAddress),
    account.getRiskHistory(policy.hash).catch(() => []),
  ]);
  const limits: AgentLimits = { asset: policy.mandate.asset, maxLossUsd: 0, maxTradeNotionalUsd: 0, actions: stored.actions };
  const availability = agentActionAvailability(limits, "mainnet", null);
  // The indexer's ids are opaque strings, so index them positionally. Nothing
  // on mainnet acts on a position id — only close and roll would, and neither
  // has an adapter here — but collapsing distinct ids to 0 would be a trap.
  const positions: OpenPosition[] = candidates.map((position, index) => ({
    positionId: index,
    expiryTs: position.expiryTs,
    contracts: position.contracts,
  }));
  const subjectPosition = managed
    ? positions[candidates.findIndex((position) => position.id === managed.id)] ?? null
    : null;

  const trend = riskTrendFrom(
    (history as { observedAt: bigint; bookScoreBps: number; positionScoreBps: number }[]).map((sample) => ({
      observedAt: Number(sample.observedAt),
      bookScoreBps: Number(sample.bookScoreBps),
      positionScoreBps: Number(sample.positionScoreBps),
    })),
    managed ? "position" : "book",
    nowSeconds,
  );
  const thesis = thesisFor(thesisRecord, managed?.id ?? null);
  const thesisVerdict = evaluateThesis(thesis, spot, nowSeconds);

  // Whether anything moved enough to warrant a fresh AI assessment. The
  // previous observation is the newest sample the account already retains, so
  // no extra store is needed — which also means the spot, implied-vol and
  // position-value triggers stay quiet here rather than comparing against a
  // value that would have to be invented.
  const samples = (history as { observedAt: bigint; bookScoreBps: number; positionScoreBps: number }[]).map((sample) => ({
    observedAt: Number(sample.observedAt),
    bookScoreBps: Number(sample.bookScoreBps),
    positionScoreBps: Number(sample.positionScoreBps),
  }));
  const newest = samples.length ? samples.reduce((a, b) => (b.observedAt > a.observedAt ? b : a)) : null;
  const previousObservation: TriggerObservation | null = newest
    ? {
        at: newest.observedAt,
        bookRiskScore: newest.bookScoreBps / 100,
        positionRiskScore: newest.positionScoreBps ? newest.positionScoreBps / 100 : null,
        spot,
        avgIv: null,
        regime: snapshot.assets[policy.mandate.asset].regime,
        positionValueUsd: null,
      }
    : null;
  const triggers = evaluateTriggers({
    previous: previousObservation,
    current: {
      at: nowSeconds,
      bookRiskScore: score,
      positionRiskScore: positionRisk?.score ?? null,
      spot,
      avgIv: snapshot.assets[policy.mandate.asset].avgIv,
      regime: snapshot.assets[policy.mandate.asset].regime,
      positionValueUsd: managed?.markUsd != null ? managed.markUsd * managed.contracts : null,
    },
    trend,
    daysToExpiry: managed ? (managed.expiryTs - nowSeconds) / 86_400 : null,
  });

  const maxContracts = Math.min(1, Number(policy.mandate.maxContractsPerFill) / 1e6);
  const decision = decide({
    position: managed,
    bookRiskScore: score,
    bookThreshold: base.threshold,
    bookPersistenceMet: true,
    positionRiskScore: positionRisk?.score ?? null,
    positionThreshold: Number(policy.mandate.positionRiskThresholdBps) / 100,
    trend,
    thesis: thesisVerdict,
    objective: thesis?.objective ?? null,
    targetReached: targetReached(thesis, spot),
    availability,
    maxContracts,
    // A hedge is quoted below, in the fill path. Weighing one here would mean
    // two quotes per tick for a number the fill path re-fetches anyway.
    quotedPremiumUsd: null,
    lossBudgetUsd: Number(policy.mandate.maxPremiumTotal) / 1e6,
    spentPremiumUsd: Number(policy.control.spentPremium) / 1e6,
    // Only a hedge executes here. Close and roll have no adapter on mainnet,
    // so a decision to exit becomes a priced recommendation for the user.
    executable: false,
    nowSec: nowSeconds,
  });
  const health = positionHealthOf(decision.riskBefore, trend);
  const intent = intentOf(decision, subjectPosition);
  const closeArmed = isActionArmed(availability, "close");
  // Two gates on the model call, in order: has anything changed, and is there
  // an action it could legally ask for.
  const worthAsking = triggers.triggered && (intent.action !== "hold" || (closeArmed && subjectPosition !== null));
  const proposal = !worthAsking
    ? null
    : await proposeAgentAction({
        asset: policy.mandate.asset,
        action: intent.action === "hold" ? "close" : intent.action,
        maxContracts,
        riskScore: score,
        threshold: base.threshold,
        regime: snapshot.assets[policy.mandate.asset].regime,
        netGexUsd: snapshot.assets[policy.mandate.asset].netGexUsd,
        spot,
        openPositions: candidates.map((position) => ({ strike: position.strike, expiryTs: position.expiryTs, contracts: position.contracts, pnlUsd: position.pnlUsd })),
        positionRiskScore: positionRisk?.score ?? null,
        positionThreshold: Number(policy.mandate.positionRiskThresholdBps) / 100,
        trend: { oneHour: trend.oneHour, sixHours: trend.sixHours, twentyFourHours: trend.twentyFourHours },
        thesis: thesis && {
          direction: thesis.direction,
          objective: thesis.objective,
          targetPrice: thesis.targetPrice,
          referenceSpot: thesis.referenceSpot,
          horizonEndsAt: thesis.horizonEndsAt,
          note: thesis.note,
          deterministicVerdict: thesisVerdict.reason,
        },
        closeArmed,
      }).catch(() => null);
  const resolved = resolveAgentAction({ intent, availability, maxContracts, proposal });
  const decisionDetail = [
    decision.explanation,
    ...resolved.notes.slice(1),
    triggers.triggered
      ? `Reassessed because ${triggers.reasons[0]}.`
      : "Nothing moved enough to reassess, so the previous reading stands.",
    resolved.aiRationale ? `AI: ${resolved.aiRationale}` : null,
  ].filter(Boolean).join(" ");
  const report = { ...base, decision, health };

  // Mainnet cannot exit or roll a live Thetanuts position: `BaseOption.close()`
  // is bilateral, the OptionBook exposes no maker-order creation to end users,
  // and RFQ mints new options rather than buying back existing ones. So an
  // exit decision is surfaced, priced at the maker's current bid, for the user
  // to act on — never executed here.
  if (decision.action === "CLOSE" || decision.action === "ROLL") {
    const proceeds = managed?.markUsd !== null && managed?.markUsd !== undefined ? managed.markUsd * managed.contracts : null;
    return {
      ...report,
      outcome: "recommendation",
      detail: [
        decisionDetail,
        proceeds === null
          ? "No market-maker bid is available to price the exit."
          : `A market maker currently bids about $${proceeds.toLocaleString("en-US", { maximumFractionDigits: 2 })} for this position.`,
      ].join(" "),
    };
  }
  if (resolved.action !== "hedge") return { ...report, outcome: "holding", detail: decisionDetail };

  const period = TRADE_PERIODS.find((days) => BigInt(days * 86400) >= policy.mandate.minTenorSeconds && BigInt(days * 86400) <= policy.mandate.maxTenorSeconds);
  if (!period) return { ...base, outcome: "quote-unavailable", detail: "No supported Thetanuts tenor fits this mandate." };
  const contracts = resolved.contracts;
  if (!Number.isFinite(contracts) || contracts < 0.001) return { ...base, outcome: "quote-unavailable", detail: "Mandate contract cap is below the executable minimum." };
  const quote = await getTradeQuote(policy.mandate.asset, "put", contracts, period, {
    fresh: true,
    maxPremiumUsd: Number(policy.mandate.maxPremiumPerFill) / 1e6,
  });
  if (quote.source !== "book" || !quote.txs) return { ...base, outcome: "quote-unavailable", detail: "No fresh listed Thetanuts order is eligible; RFQ estimates are never auto-filled." };
  if (quote.txs.fill.to.toLowerCase() !== BASE_OPTION_BOOK.toLowerCase()) return { ...base, outcome: "quote-unavailable", detail: "SDK fill targets an unrecognized OptionBook." };
  const decoded = new ethers.Interface(FILL_ABI).decodeFunctionData("fillOrder", quote.txs.fill.data);
  const order = decoded[0];
  const premium = BigInt(order.price) * BigInt(order.numContracts) / 100_000_000n;
  const tenor = BigInt(order.expiry) - now;
  if (order.isCall || order.isLong || String(decoded[2]).toLowerCase() !== ethers.ZeroAddress || premium <= 0n || premium > policy.mandate.maxPremiumPerFill || BigInt(order.numContracts) > policy.mandate.maxContractsPerFill || tenor < policy.mandate.minTenorSeconds || tenor > policy.mandate.maxTenorSeconds || BigInt(order.orderExpiryTimestamp) <= now) return { ...base, outcome: "quote-unavailable", detail: "The fresh SDK preview does not satisfy the signed policy." };
  // The mandate caps contracts; the user set a notional limit. Check the real
  // strike here, where it is finally known, rather than trusting the conversion.
  const fillNotionalUsd = (Number(order.numContracts) / 1e6) * (Number(order.strikes[0]) / 1e8);
  const signedNotionalCap = (Number(policy.mandate.maxContractsPerFill) / 1e6) * (Number(order.strikes[0]) / 1e8);
  if (fillNotionalUsd > signedNotionalCap + 1e-9) return { ...base, outcome: "quote-unavailable", detail: "The fill's notional exceeds the signed per-trade limit at this strike." };
  if (policy.control.spentPremium + premium > policy.mandate.maxPremiumTotal) return { ...base, outcome: "quote-unavailable", detail: "The signed mandate's total premium cap is exhausted." };
  if (policy.control.lastExecutionAt !== 0n && now < policy.control.lastExecutionAt + policy.mandate.minExecutionIntervalSeconds) return { ...base, outcome: "quote-unavailable", detail: "The signed mandate's execution cooldown is active." };
  if ((await new ethers.Contract(BASE_USDC, ERC20_ABI, provider).balanceOf(accountAddress)) < premium) return { ...base, outcome: "quote-unavailable", detail: "Policy account lacks enough USDC for the exact SDK preview." };
  const signedQuote = { mandateHash: policy.hash, fillCalldataHash: ethers.keccak256(quote.txs.fill.data), premium, contracts: BigInt(order.numContracts), observedAt: now, validUntil: now + BigInt(RISK_LIFETIME_SECONDS) };
  const quoteSignature = await agent.signTypedData({ name: "GammaShield Thetanuts Quote", version: "1", chainId: 8453, verifyingContract: accountAddress }, { ThetanutsQuote: [{ name: "mandateHash", type: "bytes32" }, { name: "fillCalldataHash", type: "bytes32" }, { name: "premium", type: "uint256" }, { name: "contracts", type: "uint256" }, { name: "observedAt", type: "uint64" }, { name: "validUntil", type: "uint64" }] }, signedQuote);
  const callData = account.interface.encodeFunctionData("executeThetanuts", [policy.hash, risk, riskSignature, signedQuote, quoteSignature, quote.txs.fill.data]);
  const userOpHash = await submitPolicyUserOperation({ chainId: 8453, provider, agent, sender: accountAddress, callData, pimlicoApiKey: config.pimlicoApiKey, dryRun: config.dryRun });
  return config.dryRun ? { ...base, outcome: "fill-simulated", detail: "Pimlico accepted the UserOperation estimate; it was not broadcast." } : { ...base, outcome: "fill-submitted", userOpHash: userOpHash ?? undefined };
}

async function submitRisk(account: ethers.Contract, hash: string, risk: Record<string, bigint | number | string>, riskSignature: string, provider: ethers.Provider, agent: ethers.Wallet, sender: string, config: ReturnType<typeof runtimeConfig>, outcome: "risk-reset-submitted" | "risk-reset-simulated" | "risk-observation-submitted" | "risk-observation-simulated", base: Omit<ThetanutsAgentResult, "outcome" | "userOpHash">) {
  if ((await provider.getBalance(sender)) === 0n) return { ...base, outcome: "gas-unfunded" as const, detail: "Fund the policy account with Base ETH before the agent can update risk evidence." };
  const callData = account.interface.encodeFunctionData("recordRisk", [hash, risk, riskSignature]);
  const userOpHash = await submitPolicyUserOperation({ chainId: 8453, provider, agent, sender, callData, pimlicoApiKey: config.pimlicoApiKey, dryRun: config.dryRun });
  return config.dryRun ? { ...base, outcome, detail: "Pimlico accepted the UserOperation estimate; it was not broadcast." } : { ...base, outcome, userOpHash: userOpHash ?? undefined };
}

async function readPolicy(account: ethers.Contract, agentAddress: string) {
  const [entryPoint, riskAttester, hash] = await Promise.all([account.entryPoint(), account.riskAttester(), account.activeMandateHash()]);
  if (entryPoint.toLowerCase() !== ENTRY_POINT.toLowerCase() || riskAttester.toLowerCase() !== agentAddress.toLowerCase() || hash === ethers.ZeroHash) return null;
  const [raw, control] = await Promise.all([account.getMandate(hash), account.controls(hash)]);
  const mandate: Mandate = { agent: ethers.getAddress(raw.agent), optionBook: ethers.getAddress(raw.optionBook), collateral: ethers.getAddress(raw.collateral), asset: ethers.decodeBytes32String(raw.asset) as "BTC" | "ETH", side: Number(raw.side), maxPremiumPerFill: BigInt(raw.maxPremiumPerFill), maxPremiumTotal: BigInt(raw.maxPremiumTotal), maxContractsPerFill: BigInt(raw.maxContractsPerFill), minTenorSeconds: BigInt(raw.minTenorSeconds), maxTenorSeconds: BigInt(raw.maxTenorSeconds), riskThresholdBps: BigInt(raw.riskThresholdBps), positionRiskThresholdBps: BigInt(raw.positionRiskThresholdBps), persistenceSeconds: BigInt(raw.persistenceSeconds), minExecutionIntervalSeconds: BigInt(raw.minExecutionIntervalSeconds), expiresAt: BigInt(raw.expiresAt) };
  if (!["BTC", "ETH"].includes(mandate.asset) || mandate.side !== 1 || mandate.agent.toLowerCase() !== agentAddress.toLowerCase() || mandate.optionBook.toLowerCase() !== BASE_OPTION_BOOK.toLowerCase() || mandate.collateral.toLowerCase() !== BASE_USDC.toLowerCase() || control.paused || control.revoked || BigInt(Math.floor(Date.now() / 1000)) >= mandate.expiresAt) return null;
  return { hash: hash as string, mandate, control: { spentPremium: BigInt(control.spentPremium), lastExecutionAt: BigInt(control.lastExecutionAt) } satisfies Control };
}

function riskState(raw: { scoreBps: bigint; eligibleSince: bigint; validUntil: bigint }): RiskState {
  return { scoreBps: BigInt(raw.scoreBps), eligibleSince: BigInt(raw.eligibleSince), validUntil: BigInt(raw.validUntil) };
}

function runtimeConfig() {
  const rpcUrl = process.env.BASE_RPC_URL;
  const privateKey = process.env.BASE_AGENT_PRIVATE_KEY;
  const pimlicoApiKey = process.env.PIMLICO_API_KEY;
  const factory = process.env.NEXT_PUBLIC_BASE_MANDATE_FACTORY_ADDRESS;
  const deploymentBlock = process.env.BASE_MANDATE_FACTORY_DEPLOYMENT_BLOCK;
  if (!rpcUrl || !privateKey || !pimlicoApiKey || !factory || !deploymentBlock || !/^\d+$/.test(deploymentBlock) || !ethers.isAddress(factory)) throw new Error("Base-mainnet agent configuration is incomplete");
  return { rpcUrl, privateKey: privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`, pimlicoApiKey, factory: ethers.getAddress(factory), deploymentBlock: Number(deploymentBlock), dryRun: process.env.BASE_AGENT_DRY_RUN !== "false" };
}

function baseProvider(rpcUrl: string): ethers.Provider {
  const primary = new ethers.JsonRpcProvider(rpcUrl, 8453, { staticNetwork: true });
  const fallbackUrl = "https://mainnet.base.org";
  if (rpcUrl.replace(/\/$/, "") === fallbackUrl) return primary;
  return new ethers.FallbackProvider([
    { provider: primary, priority: 1, stallTimeout: 750 },
    { provider: new ethers.JsonRpcProvider(fallbackUrl, 8453, { staticNetwork: true }), priority: 2 },
  ], 8453, { quorum: 1 });
}
