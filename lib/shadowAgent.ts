// Server-only Base Sepolia runner. It reads the signed policy and risk state
// from chain, then submits a policy-bound ERC-4337 UserOperation through Pimlico.

import { ethers } from "ethers";
import { mandateAccountAbi } from "@/lib/generated/contracts";
import { getMarketSnapshot, type MarketSnapshot } from "@/lib/snapshot";
import { getShadowBookVersion, getShadowPositions, getShadowQuote, type ShadowPosition } from "@/lib/shadow";
import { signShadowClose, isRefusal } from "@/lib/autonomous/exit";
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
import {
  positionHealthOf,
  type AutonomousDecision,
  type PositionHealth,
  type RiskTrend,
  type ThesisVerdict,
  type TradingThesis,
} from "@/lib/autonomous/types";
import { TRADE_PERIODS } from "@/lib/tradePeriods";
import { getPolicyUserOperationReceipt, submitPolicyUserOperation } from "@/lib/policyAgent4337";
import { discoverPolicyAccounts } from "@/lib/policyAgentDiscovery";

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const RISK_LIFETIME_SECONDS = 120;
const RISK_REFRESH_SECONDS = 90;
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"] as const;
const FILL_ABI = [
  "function fillShadow((bytes32 fillId,bytes32 sourceHash,bytes32 asset,address buyer,bool isCall,uint128 strikeE8,uint64 expiry,uint64 validUntil,uint128 contractsE6,uint128 premiumUsdc),bytes)",
] as const;

type Mandate = {
  agent: string;
  optionBook: string;
  collateral: string;
  asset: string;
  side: number;
  maxPremiumPerFill: bigint;
  maxPremiumTotal: bigint;
  maxContractsPerFill: bigint;
  minTenorSeconds: bigint;
  maxTenorSeconds: bigint;
  riskThresholdBps: bigint;
  positionRiskThresholdBps: bigint;
  persistenceSeconds: bigint;
  minExecutionIntervalSeconds: bigint;
  expiresAt: bigint;
};
type Control = { spentPremium: bigint; lastExecutionAt: bigint };
type RiskState = { scoreBps: bigint; positionScoreBps: bigint; eligibleSince: bigint; observedAt: bigint; validUntil: bigint };

export type ShadowAgentResult = {
  account: string;
  mandateHash?: string;
  score?: number;
  threshold?: number;
  outcome: "pending-user-operation" | "risk-below-threshold" | "risk-reset-submitted" | "risk-persistence-pending" | "gas-unfunded" | "risk-observation-submitted" | "quote-unavailable" | "fill-submitted" | "close-submitted" | "roll-submitted" | "holding";
  userOpHash?: string;
  detail?: string;
  /** The full assessment behind the outcome: what was chosen, what was
   *  rejected and why. Absent on the bookkeeping-only outcomes, which happen
   *  before any decision is reached. */
  decision?: AutonomousDecision;
  health?: PositionHealth;
};

export async function runShadowAgents(options: { pendingAccounts?: Iterable<string>; knownAccounts?: Iterable<string>; discoveryFromBlock?: number } = {}) {
  const config = runtimeConfig();
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const agent = new ethers.Wallet(config.privateKey);
  const factory = new ethers.Contract(config.factory, ["event AccountCreated(address indexed account,address indexed owner,bytes32 indexed salt)"], provider);
  // ponytail: scans this single demo factory; add an indexed event store before serving enough accounts to make this expensive.
  const latestBlock = await provider.getBlockNumber();
  const discoveryFromBlock = Math.max(config.deploymentBlock, options.discoveryFromBlock ?? config.deploymentBlock);
  const discovery = await discoverPolicyAccounts(factory, discoveryFromBlock, latestBlock);
  const knownAccounts = [...(options.knownAccounts ?? [])].filter((account): account is string => typeof account === "string" && ethers.isAddress(account)).map((account) => ethers.getAddress(account));
  const accounts = [...new Set([...knownAccounts, ...discovery.accounts])];
  const pendingAccounts = new Set([...(options.pendingAccounts ?? [])].filter((account): account is string => typeof account === "string" && ethers.isAddress(account)).map((account) => ethers.getAddress(account).toLowerCase()));
  const snapshot = await getMarketSnapshot({ fresh: true });
  const results: ShadowAgentResult[] = [];
  for (const account of accounts) {
    if (pendingAccounts.has(account.toLowerCase())) {
      results.push({ account, outcome: "pending-user-operation", detail: "The external worker is waiting for this account's prior UserOperation receipt." });
      continue;
    }
    const result = await runShadowAgent(account, config, provider, agent, snapshot);
    if (result) results.push(result);
  }
  return { results, accounts, scannedToBlock: discovery.scannedToBlock };
}

export async function getShadowUserOperationReceipt(userOpHash: string) {
  const config = runtimeConfig();
  return getPolicyUserOperationReceipt(84532, config.pimlicoApiKey, userOpHash);
}

async function runShadowAgent(accountAddress: string, config: ReturnType<typeof runtimeConfig>, provider: ethers.JsonRpcProvider, agent: ethers.Wallet, snapshot: MarketSnapshot): Promise<ShadowAgentResult | null> {
  const account = new ethers.Contract(accountAddress, mandateAccountAbi, provider);
  const policy = await readPolicy(account, accountAddress, agent.address, config);
  if (!policy) return null;
  const asset = policy.mandate.asset as "BTC" | "ETH";
  const score = snapshot.assets[asset].score;
  const scoreBps = Math.round(score * 100);
  const base = { account: accountAddress, mandateHash: policy.hash, score, threshold: Number(policy.mandate.riskThresholdBps) / 100 };
  const now = BigInt(Math.floor(Date.now() / 1000));
  const nowSeconds = Number(now);
  const state = riskState(await account.riskStates(policy.hash));
  const threshold = policy.mandate.riskThresholdBps;
  // Everything the decision needs, read before the attestation is built: the
  // attestation now carries the position's own risk score, so the position has
  // to be priced first.
  const [stored, bookVersion, receipts, thesisRecord, history] = await Promise.all([
    readAgentActions("sepolia", accountAddress),
    getShadowBookVersion().catch(() => 1),
    getShadowPositions(accountAddress).catch(() => []),
    readThesisRecord("sepolia", accountAddress),
    account.getRiskHistory(policy.hash).catch(() => []),
  ]);
  const limits: AgentLimits = { asset, maxLossUsd: 0, maxTradeNotionalUsd: 0, actions: stored.actions };
  const availability = agentActionAvailability(limits, "sepolia", bookVersion);
  const open = receipts.filter((receipt) => !receipt.closedAt && receipt.expiryTs > nowSeconds);
  const positions: OpenPosition[] = open.map((receipt) => ({ positionId: receipt.id, expiryTs: receipt.expiryTs, contracts: receipt.contracts }));

  // The agent manages one position at a time, so the nearest expiry is the
  // subject. Everything the shadow book holds was opened by the agent itself,
  // which makes it cover rather than a directional view of the user's own.
  const subject = [...open].sort((a, b) => a.expiryTs - b.expiryTs)[0] ?? null;
  const spot = snapshot.prices[asset];
  const managed: ManagedPosition | null = subject
    ? {
        id: String(subject.id),
        asset,
        isCall: subject.isCall,
        strike: subject.strike,
        expiryTs: subject.expiryTs,
        contracts: subject.contracts,
        entryPremiumUsd: subject.contracts > 0 ? subject.premiumUsd / subject.contracts : null,
        markUsd: subject.mark && subject.contracts > 0 ? subject.mark.valueUsd / subject.contracts : null,
        // The shadow book is a receipt book with a single modelled mark, so
        // there is no separate ask to quote a round trip against.
        askUsd: null,
        pnlUsd: subject.mark?.pnlUsd ?? null,
        role: "cover",
      }
    : null;
  const positionRisk = managed
    ? computePositionRisk({
        position: managed,
        spot,
        nowSec: nowSeconds,
        marketScore: score,
        contractDepthUsd: null,
      })
    : null;
  const positionScore = positionRisk?.score ?? null;
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

  // Whether anything moved enough to be worth a fresh AI assessment. The
  // previous observation is the newest sample the account already retains, so
  // this needs no extra store — but that means the spot, implied-vol and
  // position-value triggers cannot fire here, only the risk-based ones.
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
        // Not retained on-chain, so the triggers that need them stay quiet
        // rather than comparing against a value we would have to invent.
        spot,
        avgIv: null,
        regime: snapshot.assets[asset].regime,
        positionValueUsd: null,
      }
    : null;
  const triggers = evaluateTriggers({
    previous: previousObservation,
    current: {
      at: nowSeconds,
      bookRiskScore: score,
      positionRiskScore: positionScore,
      spot,
      avgIv: snapshot.assets[asset].avgIv,
      regime: snapshot.assets[asset].regime,
      positionValueUsd: managed?.markUsd != null ? managed.markUsd * managed.contracts : null,
    },
    trend,
    daysToExpiry: managed ? (managed.expiryTs - nowSeconds) / 86_400 : null,
  });

  const risk = {
    mandateHash: policy.hash,
    riskScoreBps: scoreBps,
    positionRiskScoreBps: positionRiskBps(positionRisk),
    observedAt: now,
    validUntil: now + BigInt(RISK_LIFETIME_SECONDS),
    persistenceSeconds: policy.mandate.persistenceSeconds,
  };
  const riskSignature = await agent.signTypedData(
    { name: "GammaShield Risk", version: "1", chainId: 84532, verifyingContract: accountAddress },
    { RiskAttestation: [
      { name: "mandateHash", type: "bytes32" }, { name: "riskScoreBps", type: "uint16" },
      { name: "positionRiskScoreBps", type: "uint16" }, { name: "observedAt", type: "uint64" },
      { name: "validUntil", type: "uint64" }, { name: "persistenceSeconds", type: "uint64" },
    ] },
    risk,
  );

  /** Everything the decision engine needs that does not change between the
   *  cold and the hot path. `bookPersistenceMet` is supplied per call site. */
  const decisionBase = {
    position: managed,
    bookRiskScore: score,
    bookThreshold: base.threshold,
    positionRiskScore: positionScore,
    positionThreshold: Number(policy.mandate.positionRiskThresholdBps) / 100,
    trend,
    thesis: thesisVerdict,
    objective: thesis?.objective ?? null,
    targetReached: targetReached(thesis, spot),
    availability,
    lossBudgetUsd: Number(policy.mandate.maxPremiumTotal) / 1e6,
    spentPremiumUsd: Number(policy.control.spentPremium) / 1e6,
    executable: true,
    nowSec: nowSeconds,
  };

  // --- risk evidence bookkeeping, before any action depends on it ---
  if (scoreBps < Number(threshold)) {
    const staleEvidence = state.scoreBps < threshold || state.validUntil < now;
    if (!staleEvidence) {
      if ((await provider.getBalance(accountAddress)) === 0n) {
        return { ...base, outcome: "gas-unfunded", detail: "Fund the policy account with Base Sepolia ETH before the agent can reset an active risk observation." };
      }
      const callData = account.interface.encodeFunctionData("recordRisk", [policy.hash, risk, riskSignature]);
      return { ...base, outcome: "risk-reset-submitted", userOpHash: (await submitPolicyUserOperation({ chainId: 84532, provider, agent, sender: accountAddress, callData, pimlicoApiKey: config.pimlicoApiKey })) ?? undefined };
    }
    // Risk has cooled. The only action that makes sense now is an exit.
    const cold = decide({ ...decisionBase, bookPersistenceMet: false, maxContracts: 0, quotedPremiumUsd: null });
    return await act({ base, decision: cold, intent: intentOf(cold, subjectIntent(managed, positions)), availability, maxContracts: 0, account, accountAddress, policy, provider, agent, config, snapshot, asset, open, risk, riskSignature, now, trend, triggers, positionScore, thesis, thesisVerdict, closeArmed: isActionArmed(availability, "close") });
  }

  if ((await provider.getBalance(accountAddress)) === 0n) {
    return { ...base, outcome: "gas-unfunded", detail: "Fund the policy account with Base Sepolia ETH before scheduling agent runs." };
  }

  const persistent = state.eligibleSince !== 0n && state.scoreBps >= threshold && state.validUntil >= now &&
    now >= state.eligibleSince + policy.mandate.persistenceSeconds;
  const refreshAt = BigInt(RISK_LIFETIME_SECONDS - RISK_REFRESH_SECONDS);
  const needsObservation = state.eligibleSince === 0n || state.scoreBps < threshold || state.validUntil <= now + refreshAt;
  if (needsObservation) {
    const callData = account.interface.encodeFunctionData("recordRisk", [policy.hash, risk, riskSignature]);
    return { ...base, outcome: "risk-observation-submitted", userOpHash: (await submitPolicyUserOperation({ chainId: 84532, provider, agent, sender: accountAddress, callData, pimlicoApiKey: config.pimlicoApiKey })) ?? undefined };
  }
  if (!persistent) return { ...base, outcome: "risk-persistence-pending" };

  const maxContracts = Math.min(1, Number(policy.mandate.maxContractsPerFill) / 1e6);
  // The premium the engine weighs a buy against. Priced here rather than
  // guessed: a buy with no quote is refused, never estimated.
  const quotedPremiumUsd = await quoteCoverPremium(policy, accountAddress, maxContracts).catch(() => null);
  const hot = decide({ ...decisionBase, bookPersistenceMet: true, maxContracts, quotedPremiumUsd });
  return await act({ base, decision: hot, intent: intentOf(hot, subjectIntent(managed, positions)), availability, maxContracts, account, accountAddress, policy, provider, agent, config, snapshot, asset, open, risk, riskSignature, now, trend, triggers, positionScore, thesis, thesisVerdict, closeArmed: isActionArmed(availability, "close") });
}

type ActContext = {
  base: { account: string; mandateHash: string; score: number; threshold: number };
  decision: AutonomousDecision;
  intent: ReturnType<typeof intentOf>;
  availability: ReturnType<typeof agentActionAvailability>;
  maxContracts: number;
  account: ethers.Contract;
  accountAddress: string;
  policy: NonNullable<Awaited<ReturnType<typeof readPolicy>>>;
  provider: ethers.JsonRpcProvider;
  agent: ethers.Wallet;
  config: ReturnType<typeof runtimeConfig>;
  snapshot: MarketSnapshot;
  asset: "BTC" | "ETH";
  open: ShadowPosition[];
  risk: Record<string, bigint | number | string>;
  riskSignature: string;
  now: bigint;
  trend: RiskTrend;
  triggers: { triggered: boolean; reasons: string[] };
  positionScore: number | null;
  thesis: TradingThesis | null;
  thesisVerdict: ThesisVerdict;
  closeArmed: boolean;
};

/** The OpenPosition the decision's subject corresponds to, so the guard and
 *  the executor act on the same receipt the engine reasoned about. */
function subjectIntent(managed: ManagedPosition | null, positions: OpenPosition[]): OpenPosition | null {
  if (!managed) return null;
  return positions.find((position) => String(position.positionId) === managed.id) ?? null;
}

/**
 * What cover would cost right now, so the decision weighs a real premium
 * rather than an assumed one. Returns null when nothing is quotable, which
 * blocks the buy instead of estimating it.
 *
 * hedge() re-quotes before it fills. That is deliberate duplication: this
 * number informs a decision, and the one that reaches the chain must be fresh.
 */
async function quoteCoverPremium(
  policy: NonNullable<Awaited<ReturnType<typeof readPolicy>>>,
  accountAddress: string,
  contracts: number,
): Promise<number | null> {
  if (!Number.isFinite(contracts) || contracts < 0.001) return null;
  const period = TRADE_PERIODS.find((days) => {
    const tenor = BigInt(days * 86400);
    return tenor >= policy.mandate.minTenorSeconds && tenor <= policy.mandate.maxTenorSeconds;
  });
  if (!period) return null;
  const quote = await getShadowQuote(
    policy.mandate.asset,
    accountAddress,
    policy.mandate.side === 0 ? "call" : "put",
    contracts,
    period,
    false,
    Number(policy.mandate.maxPremiumPerFill) / 1e6,
  );
  return quote.source.premiumUsd;
}

/** Ask the AI to narrow the cleared action, then execute whatever survives. */
async function act(context: ActContext): Promise<ShadowAgentResult> {
  const { base, decision, intent, availability, maxContracts, asset, snapshot, open } = context;
  const health = positionHealthOf(decision.riskBefore, context.trend);
  const report = { ...base, decision, health };

  // The model is consulted even when the gate cleared nothing, because a
  // thesis break is the one thing it may raise on its own. It is not consulted
  // when close is unarmed and the gate cleared nothing — there is then no
  // action it could legally ask for.
  // Two gates on the model call, in order: has anything changed, and is there
  // an action it could legally ask for. A quiet cycle keeps the deterministic
  // decision and does not spend a model call to re-confirm it.
  const worthAsking =
    context.triggers.triggered && (intent.action !== "hold" || (context.closeArmed && intent.position !== null));
  const proposal = !worthAsking
    ? null
    : await proposeAgentAction({
        asset,
        action: intent.action === "hold" ? "close" : intent.action,
        maxContracts: intent.action === "close" ? (intent.position?.contracts ?? 0) : maxContracts,
        riskScore: base.score,
        threshold: base.threshold,
        regime: snapshot.assets[asset].regime,
        netGexUsd: snapshot.assets[asset].netGexUsd,
        spot: snapshot.prices[asset],
        openPositions: open.map((receipt) => ({ strike: receipt.strike, expiryTs: receipt.expiryTs, contracts: receipt.contracts, pnlUsd: receipt.mark?.pnlUsd ?? null })),
        positionRiskScore: context.positionScore,
        positionThreshold: Number(context.policy.mandate.positionRiskThresholdBps) / 100,
        trend: { oneHour: context.trend.oneHour, sixHours: context.trend.sixHours, twentyFourHours: context.trend.twentyFourHours },
        thesis: context.thesis && {
          direction: context.thesis.direction,
          objective: context.thesis.objective,
          targetPrice: context.thesis.targetPrice,
          referenceSpot: context.thesis.referenceSpot,
          horizonEndsAt: context.thesis.horizonEndsAt,
          note: context.thesis.note,
          deterministicVerdict: context.thesisVerdict.reason,
        },
        closeArmed: context.closeArmed,
      }).catch(() => null);

  const resolved = resolveAgentAction({ intent, availability, maxContracts, proposal });
  const detail = [
    decision.explanation,
    ...resolved.notes.slice(1),
    context.triggers.triggered
      ? `Reassessed because ${context.triggers.reasons[0]}.`
      : "Nothing moved enough to reassess, so the previous reading stands.",
    resolved.aiRationale ? `AI: ${resolved.aiRationale}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  if (resolved.aiInitiated) report.decision = { ...decision, action: "CLOSE", aiInitiated: true, reason: resolved.aiRationale ?? decision.reason };
  if (resolved.action === "hold") return { ...report, outcome: "holding", detail };
  if (resolved.action === "close" || resolved.action === "roll") return await exit(context, resolved, detail);
  return await hedge(context, resolved.contracts, detail);
}

async function hedge(context: ActContext, contracts: number, detail: string): Promise<ShadowAgentResult> {
  const { base, account, accountAddress, policy, provider, agent, config, now } = context;
  if (!Number.isFinite(contracts) || contracts < 0.001) return { ...base, outcome: "quote-unavailable", detail: "Mandate contract cap is below the executable minimum." };
  const period = TRADE_PERIODS.find((days) => {
    const tenor = BigInt(days * 86400);
    return tenor >= policy.mandate.minTenorSeconds && tenor <= policy.mandate.maxTenorSeconds;
  });
  if (!period) return { ...base, outcome: "quote-unavailable", detail: "No supported Thetanuts tenor fits this mandate." };

  const quote = await getShadowQuote(
    policy.mandate.asset,
    accountAddress,
    policy.mandate.side === 0 ? "call" : "put",
    contracts,
    period,
    true,
    Number(policy.mandate.maxPremiumPerFill) / 1e6,
  );
  if (quote.source.liquidity !== "book") return { ...base, outcome: "quote-unavailable", detail: "No fresh listed Thetanuts order is eligible; RFQ estimates are never auto-filled." };
  const fill = new ethers.Interface(FILL_ABI).decodeFunctionData("fillShadow", quote.txs.fill.data);
  const signedQuote = fill[0];
  const premium = BigInt(signedQuote.premiumUsdc);
  const tenor = BigInt(signedQuote.expiry) - now;
  if (
    signedQuote.buyer.toLowerCase() !== accountAddress.toLowerCase() || premium > policy.mandate.maxPremiumPerFill ||
    BigInt(signedQuote.contractsE6) > policy.mandate.maxContractsPerFill || tenor < policy.mandate.minTenorSeconds ||
    tenor > policy.mandate.maxTenorSeconds || BigInt(signedQuote.validUntil) < now
  ) return { ...base, outcome: "quote-unavailable", detail: "Fresh quote does not satisfy the signed policy." };
  if (policy.control.spentPremium + premium > policy.mandate.maxPremiumTotal) {
    return { ...base, outcome: "quote-unavailable", detail: "The signed maximum loss is exhausted." };
  }
  if (policy.control.lastExecutionAt !== 0n && now < policy.control.lastExecutionAt + policy.mandate.minExecutionIntervalSeconds) {
    return { ...base, outcome: "quote-unavailable", detail: "The signed mandate's execution cooldown is active." };
  }
  const usdc = new ethers.Contract(policy.mandate.collateral, ERC20_ABI, provider);
  if ((await usdc.balanceOf(accountAddress)) < premium) return { ...base, outcome: "quote-unavailable", detail: "Policy account lacks enough test USDC for the exact quote." };

  const callData = account.interface.encodeFunctionData("executeShadow", [policy.hash, context.risk, context.riskSignature, signedQuote, fill[1]]);
  return { ...base, outcome: "fill-submitted", detail, userOpHash: (await submitPolicyUserOperation({ chainId: 84532, provider, agent, sender: accountAddress, callData, pimlicoApiKey: config.pimlicoApiKey })) ?? undefined };
}

/** A close, or a roll — a close and a replacement fill in one atomic call. */
async function exit(context: ActContext, resolved: ReturnType<typeof resolveAgentAction>, detail: string): Promise<ShadowAgentResult> {
  const { base, account, accountAddress, policy, provider, agent, config, open, now } = context;
  const receipt = open.find((value) => value.id === resolved.position?.positionId);
  if (!receipt) return { ...base, outcome: "quote-unavailable", detail: "The receipt this exit targets is no longer open." };

  const usdc = new ethers.Contract(policy.mandate.collateral, ERC20_ABI, provider);
  const signed = await signShadowClose({
    position: receipt,
    mandateHash: policy.hash,
    account: accountAddress,
    chainId: 84532,
    optionBook: policy.mandate.optionBook,
    bookBalanceUsdc: await usdc.balanceOf(policy.mandate.optionBook),
    agent,
  });
  if (isRefusal(signed)) return { ...base, outcome: "quote-unavailable", detail: signed.reason };

  if (resolved.action === "close") {
    const callData = account.interface.encodeFunctionData("executeShadowClose", [policy.hash, signed.attestation, signed.attestationSignature, signed.close, signed.closeSignature]);
    return { ...base, outcome: "close-submitted", detail, userOpHash: (await submitPolicyUserOperation({ chainId: 84532, provider, agent, sender: accountAddress, callData, pimlicoApiKey: config.pimlicoApiKey })) ?? undefined };
  }

  // Roll: the replacement leg is quoted and bounded exactly like a fresh hedge.
  const period = TRADE_PERIODS.find((days) => {
    const tenor = BigInt(days * 86400);
    return tenor >= policy.mandate.minTenorSeconds && tenor <= policy.mandate.maxTenorSeconds;
  });
  if (!period) return { ...base, outcome: "quote-unavailable", detail: "No supported Thetanuts tenor fits this mandate for the replacement leg." };
  const quote = await getShadowQuote(
    policy.mandate.asset,
    accountAddress,
    policy.mandate.side === 0 ? "call" : "put",
    resolved.contracts,
    period,
    true,
    Number(policy.mandate.maxPremiumPerFill) / 1e6,
  );
  if (quote.source.liquidity !== "book") return { ...base, outcome: "quote-unavailable", detail: "No fresh listed order is eligible for the replacement leg." };
  const fill = new ethers.Interface(FILL_ABI).decodeFunctionData("fillShadow", quote.txs.fill.data);
  const replacement = fill[0];
  const premium = BigInt(replacement.premiumUsdc);
  const tenor = BigInt(replacement.expiry) - now;
  if (
    replacement.buyer.toLowerCase() !== accountAddress.toLowerCase() || premium > policy.mandate.maxPremiumPerFill ||
    BigInt(replacement.contractsE6) > policy.mandate.maxContractsPerFill || tenor < policy.mandate.minTenorSeconds ||
    tenor > policy.mandate.maxTenorSeconds || BigInt(replacement.validUntil) < now
  ) return { ...base, outcome: "quote-unavailable", detail: "The replacement leg does not satisfy the signed policy." };
  // The exit credit lands first, so the cap is measured against the net figure.
  const credited = signed.close.proceedsUsdc > policy.control.spentPremium ? policy.control.spentPremium : signed.close.proceedsUsdc;
  if (policy.control.spentPremium - credited + premium > policy.mandate.maxPremiumTotal) {
    return { ...base, outcome: "quote-unavailable", detail: "The replacement leg would breach the signed maximum loss." };
  }

  const request = {
    risk: context.risk,
    riskSignature: context.riskSignature,
    attestation: signed.attestation,
    attestationSignature: signed.attestationSignature,
    close: signed.close,
    closeSignature: signed.closeSignature,
    quote: replacement,
    quoteSignature: fill[1],
  };
  const callData = account.interface.encodeFunctionData("executeShadowRoll", [policy.hash, request]);
  return { ...base, outcome: "roll-submitted", detail, userOpHash: (await submitPolicyUserOperation({ chainId: 84532, provider, agent, sender: accountAddress, callData, pimlicoApiKey: config.pimlicoApiKey })) ?? undefined };
}

function riskState(raw: { scoreBps: bigint; positionScoreBps: bigint; eligibleSince: bigint; observedAt: bigint; validUntil: bigint }): RiskState {
  return {
    scoreBps: BigInt(raw.scoreBps), positionScoreBps: BigInt(raw.positionScoreBps),
    eligibleSince: BigInt(raw.eligibleSince), observedAt: BigInt(raw.observedAt), validUntil: BigInt(raw.validUntil),
  };
}

async function readPolicy(account: ethers.Contract, accountAddress: string, agentAddress: string, config: ReturnType<typeof runtimeConfig>) {
  const [entryPoint, riskAttester, hash] = await Promise.all([account.entryPoint(), account.riskAttester(), account.activeMandateHash()]);
  if (entryPoint.toLowerCase() !== ENTRY_POINT.toLowerCase() || riskAttester.toLowerCase() !== agentAddress.toLowerCase() || hash === ethers.ZeroHash) {
    return null;
  }
  const [raw, control] = await Promise.all([account.getMandate(hash), account.controls(hash)]);
  const mandate: Mandate = {
    agent: ethers.getAddress(raw.agent), optionBook: ethers.getAddress(raw.optionBook), collateral: ethers.getAddress(raw.collateral),
    asset: ethers.decodeBytes32String(raw.asset), side: Number(raw.side), maxPremiumPerFill: BigInt(raw.maxPremiumPerFill), maxPremiumTotal: BigInt(raw.maxPremiumTotal),
    maxContractsPerFill: BigInt(raw.maxContractsPerFill), minTenorSeconds: BigInt(raw.minTenorSeconds), maxTenorSeconds: BigInt(raw.maxTenorSeconds),
    riskThresholdBps: BigInt(raw.riskThresholdBps), positionRiskThresholdBps: BigInt(raw.positionRiskThresholdBps),
    persistenceSeconds: BigInt(raw.persistenceSeconds),
    minExecutionIntervalSeconds: BigInt(raw.minExecutionIntervalSeconds), expiresAt: BigInt(raw.expiresAt),
  };
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (
    !["BTC", "ETH"].includes(mandate.asset) || ![0, 1].includes(mandate.side) || mandate.agent.toLowerCase() !== agentAddress.toLowerCase() ||
    mandate.optionBook.toLowerCase() !== config.optionBook.toLowerCase() || mandate.collateral.toLowerCase() !== config.usdc.toLowerCase() ||
    control.paused || control.revoked || now >= mandate.expiresAt ||
    // A zero close/roll trigger would arm those actions permanently. The
    // account rejects such a mandate at registration; refuse to act on one
    // here too, rather than trusting registration alone.
    mandate.positionRiskThresholdBps === 0n || mandate.positionRiskThresholdBps > 10_000n
  ) return null;
  return { hash: hash as string, mandate, control: { spentPremium: BigInt(control.spentPremium), lastExecutionAt: BigInt(control.lastExecutionAt) } satisfies Control };
}

function runtimeConfig() {
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL;
  const privateKey = process.env.SHADOW_QUOTE_SIGNER_PRIVATE_KEY;
  const pimlicoApiKey = process.env.PIMLICO_API_KEY;
  const optionBook = process.env.SHADOW_OPTION_BOOK_ADDRESS;
  const usdc = process.env.SHADOW_USDC_ADDRESS;
  const factory = process.env.NEXT_PUBLIC_BASE_SEPOLIA_MANDATE_FACTORY_ADDRESS;
  const deploymentBlock = process.env.BASE_SEPOLIA_MANDATE_FACTORY_DEPLOYMENT_BLOCK;
  if (!rpcUrl || !privateKey || !pimlicoApiKey || !optionBook || !usdc || !factory || !deploymentBlock || !/^\d+$/.test(deploymentBlock) || !ethers.isAddress(optionBook) || !ethers.isAddress(usdc) || !ethers.isAddress(factory)) {
    throw new Error("Base Sepolia agent configuration is incomplete");
  }
  return {
    rpcUrl, privateKey: privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`, pimlicoApiKey,
    optionBook: ethers.getAddress(optionBook), usdc: ethers.getAddress(usdc), factory: ethers.getAddress(factory), deploymentBlock: Number(deploymentBlock),
  };
}
