// Server-only Base Sepolia runner. It reads the signed policy and risk state
// from chain, then submits a policy-bound ERC-4337 UserOperation through Pimlico.

import { ethers } from "ethers";
import { mandateAccountAbi } from "@/lib/generated/contracts";
import { getMarketSnapshot, type MarketSnapshot } from "@/lib/snapshot";
import { getShadowQuote } from "@/lib/shadow";
import { TRADE_PERIODS } from "@/lib/tradePeriods";
import { getPolicyUserOperationReceipt, submitPolicyUserOperation } from "@/lib/policyAgent4337";

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
  persistenceSeconds: bigint;
  minExecutionIntervalSeconds: bigint;
  expiresAt: bigint;
};
type Control = { spentPremium: bigint; lastExecutionAt: bigint };
type RiskState = { scoreBps: bigint; eligibleSince: bigint; observedAt: bigint; validUntil: bigint };

export type ShadowAgentResult = {
  account: string;
  mandateHash?: string;
  score?: number;
  threshold?: number;
  outcome: "pending-user-operation" | "risk-below-threshold" | "risk-reset-submitted" | "risk-persistence-pending" | "gas-unfunded" | "risk-observation-submitted" | "quote-unavailable" | "fill-submitted";
  userOpHash?: string;
  detail?: string;
};

export async function runShadowAgents(options: { pendingAccounts?: Iterable<string>; knownAccounts?: Iterable<string>; discoveryFromBlock?: number } = {}) {
  const config = runtimeConfig();
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const agent = new ethers.Wallet(config.privateKey);
  const factory = new ethers.Contract(config.factory, ["event AccountCreated(address indexed account,address indexed owner,bytes32 indexed salt)"], provider);
  // ponytail: scans this single demo factory; add an indexed event store before serving enough accounts to make this expensive.
  const latestBlock = await provider.getBlockNumber();
  const discoveryFromBlock = Math.max(config.deploymentBlock, options.discoveryFromBlock ?? config.deploymentBlock);
  const events = await accountCreatedEvents(factory, discoveryFromBlock, latestBlock);
  const knownAccounts = [...(options.knownAccounts ?? [])].filter((account): account is string => typeof account === "string" && ethers.isAddress(account)).map((account) => ethers.getAddress(account));
  const accounts = [...new Set([...knownAccounts, ...events.flatMap((event) => "args" in event && event.args?.account ? [ethers.getAddress(event.args.account)] : [])])];
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
  return { results, accounts, scannedToBlock: latestBlock };
}

async function accountCreatedEvents(factory: ethers.Contract, fromBlock: number, toBlock: number): Promise<Array<{ args?: { account?: string } }>> {
  if (fromBlock > toBlock) return [];
  const events: Array<{ args?: { account?: string } }> = [];
  for (let start = fromBlock; start <= toBlock; start += 10_000) {
    events.push(...await factory.queryFilter(factory.filters.AccountCreated(), start, Math.min(start + 9_999, toBlock)) as Array<{ args?: { account?: string } }>);
  }
  return events;
}

export async function getShadowUserOperationReceipt(userOpHash: string) {
  const config = runtimeConfig();
  return getPolicyUserOperationReceipt(84532, config.pimlicoApiKey, userOpHash);
}

async function runShadowAgent(accountAddress: string, config: ReturnType<typeof runtimeConfig>, provider: ethers.JsonRpcProvider, agent: ethers.Wallet, snapshot: MarketSnapshot): Promise<ShadowAgentResult | null> {
  const account = new ethers.Contract(accountAddress, mandateAccountAbi, provider);
  const policy = await readPolicy(account, accountAddress, agent.address, config);
  if (!policy) return null;
  const score = snapshot.assets[policy.mandate.asset as "BTC" | "ETH"].score;
  const scoreBps = Math.round(score * 100);
  const base = { account: accountAddress, mandateHash: policy.hash, score, threshold: Number(policy.mandate.riskThresholdBps) / 100 };
  const now = BigInt(Math.floor(Date.now() / 1000));
  const state = riskState(await account.riskStates(policy.hash));
  const threshold = policy.mandate.riskThresholdBps;
  const risk = {
    mandateHash: policy.hash,
    riskScoreBps: scoreBps,
    observedAt: now,
    validUntil: now + BigInt(RISK_LIFETIME_SECONDS),
    persistenceSeconds: policy.mandate.persistenceSeconds,
  };
  const riskSignature = await agent.signTypedData(
    { name: "GammaShield Risk", version: "1", chainId: 84532, verifyingContract: accountAddress },
    { RiskAttestation: [
      { name: "mandateHash", type: "bytes32" }, { name: "riskScoreBps", type: "uint16" }, { name: "observedAt", type: "uint64" },
      { name: "validUntil", type: "uint64" }, { name: "persistenceSeconds", type: "uint64" },
    ] },
    risk,
  );

  if (scoreBps < Number(threshold)) {
    if (state.scoreBps < threshold || state.validUntil < now) return { ...base, outcome: "risk-below-threshold" };
    if ((await provider.getBalance(accountAddress)) === 0n) {
      return { ...base, outcome: "gas-unfunded", detail: "Fund the policy account with Base Sepolia ETH before the agent can reset an active risk observation." };
    }
    const callData = account.interface.encodeFunctionData("recordRisk", [policy.hash, risk, riskSignature]);
    return { ...base, outcome: "risk-reset-submitted", userOpHash: await submitPolicyUserOperation({ chainId: 84532, provider, agent, sender: accountAddress, callData, pimlicoApiKey: config.pimlicoApiKey }) };
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
    return { ...base, outcome: "risk-observation-submitted", userOpHash: await submitPolicyUserOperation({ chainId: 84532, provider, agent, sender: accountAddress, callData, pimlicoApiKey: config.pimlicoApiKey }) };
  }
  if (!persistent) return { ...base, outcome: "risk-persistence-pending" };

  const period = TRADE_PERIODS.find((days) => {
    const tenor = BigInt(days * 86400);
    return tenor >= policy.mandate.minTenorSeconds && tenor <= policy.mandate.maxTenorSeconds;
  });
  if (!period) return { ...base, outcome: "quote-unavailable", detail: "No supported Thetanuts tenor fits this mandate." };
  const contracts = Math.min(1, Number(policy.mandate.maxContractsPerFill) / 1e6);
  if (!Number.isFinite(contracts) || contracts < 0.001) return { ...base, outcome: "quote-unavailable", detail: "Mandate contract cap is below the executable minimum." };

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
    return { ...base, outcome: "quote-unavailable", detail: "The signed mandate's total premium cap is exhausted." };
  }
  if (policy.control.lastExecutionAt !== 0n && now < policy.control.lastExecutionAt + policy.mandate.minExecutionIntervalSeconds) {
    return { ...base, outcome: "quote-unavailable", detail: "The signed mandate's execution cooldown is active." };
  }
  const usdc = new ethers.Contract(policy.mandate.collateral, ERC20_ABI, provider);
  if ((await usdc.balanceOf(accountAddress)) < premium) return { ...base, outcome: "quote-unavailable", detail: "Policy account lacks enough test USDC for the exact quote." };

  const callData = account.interface.encodeFunctionData("executeShadow", [policy.hash, risk, riskSignature, signedQuote, fill[1]]);
  return { ...base, outcome: "fill-submitted", userOpHash: await submitPolicyUserOperation({ chainId: 84532, provider, agent, sender: accountAddress, callData, pimlicoApiKey: config.pimlicoApiKey }) };
}

function riskState(raw: { scoreBps: bigint; eligibleSince: bigint; observedAt: bigint; validUntil: bigint }): RiskState {
  return { scoreBps: BigInt(raw.scoreBps), eligibleSince: BigInt(raw.eligibleSince), observedAt: BigInt(raw.observedAt), validUntil: BigInt(raw.validUntil) };
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
    riskThresholdBps: BigInt(raw.riskThresholdBps), persistenceSeconds: BigInt(raw.persistenceSeconds),
    minExecutionIntervalSeconds: BigInt(raw.minExecutionIntervalSeconds), expiresAt: BigInt(raw.expiresAt),
  };
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (
    !["BTC", "ETH"].includes(mandate.asset) || ![0, 1].includes(mandate.side) || mandate.agent.toLowerCase() !== agentAddress.toLowerCase() ||
    mandate.optionBook.toLowerCase() !== config.optionBook.toLowerCase() || mandate.collateral.toLowerCase() !== config.usdc.toLowerCase() ||
    control.paused || control.revoked || now >= mandate.expiresAt
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
