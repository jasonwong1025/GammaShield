import "server-only";

import { ethers } from "ethers";
import { mandateAccountAbi } from "@/lib/generated/contracts";
import { getMarketSnapshot, type MarketSnapshot } from "@/lib/snapshot";
import { getTradeQuote } from "@/lib/trade";
import { TRADE_PERIODS } from "@/lib/tradePeriods";
import { getPolicyUserOperationReceipt, submitPolicyUserOperation } from "@/lib/policyAgent4337";
import { discoverPolicyAccounts } from "@/lib/policyAgentDiscovery";

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const RISK_LIFETIME_SECONDS = 120;
const RISK_REFRESH_SECONDS = 90;
const BASE_OPTION_BOOK = "0x1bDff855d6811728acaDC00989e79143a2bdfDed";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FILL_ABI = ["function fillOrder((address maker,uint256 orderExpiryTimestamp,address collateral,bool isCall,address priceFeed,address implementation,bool isLong,uint256 maxCollateralUsable,uint256[] strikes,uint256 expiry,uint256 price,uint256 numContracts,bytes extraOptionData),bytes signature,address referrer) returns (address)"] as const;
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"] as const;

type Mandate = { agent: string; optionBook: string; collateral: string; asset: "BTC" | "ETH"; side: number; maxPremiumPerFill: bigint; maxPremiumTotal: bigint; maxContractsPerFill: bigint; minTenorSeconds: bigint; maxTenorSeconds: bigint; riskThresholdBps: bigint; persistenceSeconds: bigint; minExecutionIntervalSeconds: bigint; expiresAt: bigint };
type Control = { spentPremium: bigint; lastExecutionAt: bigint };
type RiskState = { scoreBps: bigint; eligibleSince: bigint; validUntil: bigint };
export type ThetanutsAgentResult = { account: string; mandateHash?: string; score?: number; threshold?: number; outcome: "pending-user-operation" | "risk-below-threshold" | "risk-reset-submitted" | "risk-persistence-pending" | "gas-unfunded" | "risk-observation-submitted" | "quote-unavailable" | "fill-submitted"; userOpHash?: string; detail?: string };

export async function runThetanutsAgents(options: { pendingAccounts?: Iterable<string>; knownAccounts?: Iterable<string>; discoveryFromBlock?: number } = {}) {
  const config = runtimeConfig();
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
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

async function runThetanutsAgent(accountAddress: string, config: ReturnType<typeof runtimeConfig>, provider: ethers.JsonRpcProvider, agent: ethers.Wallet, snapshot: MarketSnapshot): Promise<ThetanutsAgentResult | null> {
  const account = new ethers.Contract(accountAddress, mandateAccountAbi, provider);
  const policy = await readPolicy(account, agent.address);
  if (!policy) return null;
  const score = snapshot.assets[policy.mandate.asset].score;
  const scoreBps = Math.round(score * 100);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const state = riskState(await account.riskStates(policy.hash));
  const risk = { mandateHash: policy.hash, riskScoreBps: scoreBps, observedAt: now, validUntil: now + BigInt(RISK_LIFETIME_SECONDS), persistenceSeconds: policy.mandate.persistenceSeconds };
  const riskSignature = await agent.signTypedData({ name: "GammaShield Risk", version: "1", chainId: 8453, verifyingContract: accountAddress }, { RiskAttestation: [{ name: "mandateHash", type: "bytes32" }, { name: "riskScoreBps", type: "uint16" }, { name: "observedAt", type: "uint64" }, { name: "validUntil", type: "uint64" }, { name: "persistenceSeconds", type: "uint64" }] }, risk);
  const base = { account: accountAddress, mandateHash: policy.hash, score, threshold: Number(policy.mandate.riskThresholdBps) / 100 };
  if (scoreBps < Number(policy.mandate.riskThresholdBps)) {
    if (state.scoreBps < policy.mandate.riskThresholdBps || state.validUntil < now) return { ...base, outcome: "risk-below-threshold" };
    return submitRisk(account, policy.hash, risk, riskSignature, provider, agent, accountAddress, config, "risk-reset-submitted", base);
  }
  if ((await provider.getBalance(accountAddress)) === 0n) return { ...base, outcome: "gas-unfunded", detail: "Fund the policy account with Base ETH before scheduling agent runs." };
  const persistent = state.eligibleSince !== 0n && state.scoreBps >= policy.mandate.riskThresholdBps && state.validUntil >= now && now >= state.eligibleSince + policy.mandate.persistenceSeconds;
  if (state.eligibleSince === 0n || state.scoreBps < policy.mandate.riskThresholdBps || state.validUntil <= now + BigInt(RISK_LIFETIME_SECONDS - RISK_REFRESH_SECONDS)) {
    return submitRisk(account, policy.hash, risk, riskSignature, provider, agent, accountAddress, config, "risk-observation-submitted", base);
  }
  if (!persistent) return { ...base, outcome: "risk-persistence-pending" };
  const period = TRADE_PERIODS.find((days) => BigInt(days * 86400) >= policy.mandate.minTenorSeconds && BigInt(days * 86400) <= policy.mandate.maxTenorSeconds);
  if (!period) return { ...base, outcome: "quote-unavailable", detail: "No supported Thetanuts tenor fits this mandate." };
  const contracts = Math.min(1, Number(policy.mandate.maxContractsPerFill) / 1e6);
  if (!Number.isFinite(contracts) || contracts < 0.001) return { ...base, outcome: "quote-unavailable", detail: "Mandate contract cap is below the executable minimum." };
  const quote = await getTradeQuote(policy.mandate.asset, "put", contracts, period, true, Number(policy.mandate.maxPremiumPerFill) / 1e6);
  if (quote.source !== "book" || !quote.txs) return { ...base, outcome: "quote-unavailable", detail: "No fresh listed Thetanuts order is eligible; RFQ estimates are never auto-filled." };
  if (quote.txs.fill.to.toLowerCase() !== BASE_OPTION_BOOK.toLowerCase()) return { ...base, outcome: "quote-unavailable", detail: "SDK fill targets an unrecognized OptionBook." };
  const decoded = new ethers.Interface(FILL_ABI).decodeFunctionData("fillOrder", quote.txs.fill.data);
  const order = decoded[0];
  const premium = BigInt(order.price) * BigInt(order.numContracts) / 100_000_000n;
  const tenor = BigInt(order.expiry) - now;
  if (order.isCall || order.isLong || String(decoded[2]).toLowerCase() !== ethers.ZeroAddress || premium <= 0n || premium > policy.mandate.maxPremiumPerFill || BigInt(order.numContracts) > policy.mandate.maxContractsPerFill || tenor < policy.mandate.minTenorSeconds || tenor > policy.mandate.maxTenorSeconds || BigInt(order.orderExpiryTimestamp) <= now) return { ...base, outcome: "quote-unavailable", detail: "The fresh SDK preview does not satisfy the signed policy." };
  if (policy.control.spentPremium + premium > policy.mandate.maxPremiumTotal) return { ...base, outcome: "quote-unavailable", detail: "The signed mandate's total premium cap is exhausted." };
  if (policy.control.lastExecutionAt !== 0n && now < policy.control.lastExecutionAt + policy.mandate.minExecutionIntervalSeconds) return { ...base, outcome: "quote-unavailable", detail: "The signed mandate's execution cooldown is active." };
  if ((await new ethers.Contract(BASE_USDC, ERC20_ABI, provider).balanceOf(accountAddress)) < premium) return { ...base, outcome: "quote-unavailable", detail: "Policy account lacks enough USDC for the exact SDK preview." };
  const signedQuote = { mandateHash: policy.hash, fillCalldataHash: ethers.keccak256(quote.txs.fill.data), premium, contracts: BigInt(order.numContracts), observedAt: now, validUntil: now + BigInt(RISK_LIFETIME_SECONDS) };
  const quoteSignature = await agent.signTypedData({ name: "GammaShield Thetanuts Quote", version: "1", chainId: 8453, verifyingContract: accountAddress }, { ThetanutsQuote: [{ name: "mandateHash", type: "bytes32" }, { name: "fillCalldataHash", type: "bytes32" }, { name: "premium", type: "uint256" }, { name: "contracts", type: "uint256" }, { name: "observedAt", type: "uint64" }, { name: "validUntil", type: "uint64" }] }, signedQuote);
  const callData = account.interface.encodeFunctionData("executeThetanuts", [policy.hash, risk, riskSignature, signedQuote, quoteSignature, quote.txs.fill.data]);
  return { ...base, outcome: "fill-submitted", userOpHash: await submitPolicyUserOperation({ chainId: 8453, provider, agent, sender: accountAddress, callData, pimlicoApiKey: config.pimlicoApiKey }) };
}

async function submitRisk(account: ethers.Contract, hash: string, risk: Record<string, bigint | number | string>, riskSignature: string, provider: ethers.JsonRpcProvider, agent: ethers.Wallet, sender: string, config: ReturnType<typeof runtimeConfig>, outcome: "risk-reset-submitted" | "risk-observation-submitted", base: Omit<ThetanutsAgentResult, "outcome" | "userOpHash">) {
  if ((await provider.getBalance(sender)) === 0n) return { ...base, outcome: "gas-unfunded" as const, detail: "Fund the policy account with Base ETH before the agent can update risk evidence." };
  const callData = account.interface.encodeFunctionData("recordRisk", [hash, risk, riskSignature]);
  return { ...base, outcome, userOpHash: await submitPolicyUserOperation({ chainId: 8453, provider, agent, sender, callData, pimlicoApiKey: config.pimlicoApiKey }) };
}

async function readPolicy(account: ethers.Contract, agentAddress: string) {
  const [entryPoint, riskAttester, hash] = await Promise.all([account.entryPoint(), account.riskAttester(), account.activeMandateHash()]);
  if (entryPoint.toLowerCase() !== ENTRY_POINT.toLowerCase() || riskAttester.toLowerCase() !== agentAddress.toLowerCase() || hash === ethers.ZeroHash) return null;
  const [raw, control] = await Promise.all([account.getMandate(hash), account.controls(hash)]);
  const mandate: Mandate = { agent: ethers.getAddress(raw.agent), optionBook: ethers.getAddress(raw.optionBook), collateral: ethers.getAddress(raw.collateral), asset: ethers.decodeBytes32String(raw.asset) as "BTC" | "ETH", side: Number(raw.side), maxPremiumPerFill: BigInt(raw.maxPremiumPerFill), maxPremiumTotal: BigInt(raw.maxPremiumTotal), maxContractsPerFill: BigInt(raw.maxContractsPerFill), minTenorSeconds: BigInt(raw.minTenorSeconds), maxTenorSeconds: BigInt(raw.maxTenorSeconds), riskThresholdBps: BigInt(raw.riskThresholdBps), persistenceSeconds: BigInt(raw.persistenceSeconds), minExecutionIntervalSeconds: BigInt(raw.minExecutionIntervalSeconds), expiresAt: BigInt(raw.expiresAt) };
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
  return { rpcUrl, privateKey: privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`, pimlicoApiKey, factory: ethers.getAddress(factory), deploymentBlock: Number(deploymentBlock) };
}
