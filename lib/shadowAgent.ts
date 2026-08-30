// Server-only Base Sepolia runner. It reads the signed policy and risk state
// from chain, then submits a policy-bound ERC-4337 UserOperation through Pimlico.

import { ethers } from "ethers";
import { getMarketSnapshot } from "@/lib/snapshot";
import { getShadowQuote } from "@/lib/shadow";
import { TRADE_PERIODS } from "@/lib/tradePeriods";

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const RISK_LIFETIME_SECONDS = 120;
const INITIAL_GAS = { callGasLimit: 300_000n, verificationGasLimit: 600_000n, preVerificationGas: 100_000n };

const ACCOUNT_ABI = [
  "function entryPoint() view returns (address)",
  "function riskAttester() view returns (address)",
  "function activeMandateHash() view returns (bytes32)",
  "function getMandate(bytes32) view returns ((address owner,address account,address agent,address optionBook,address collateral,bytes32 asset,uint8 side,uint256 maxPremiumPerFill,uint256 maxPremiumTotal,uint256 maxContractsPerFill,uint64 minTenorSeconds,uint64 maxTenorSeconds,uint16 riskThresholdBps,uint64 persistenceSeconds,uint64 minExecutionIntervalSeconds,uint64 validAfter,uint64 expiresAt,uint256 nonce))",
  "function controls(bytes32) view returns (bool paused,bool revoked,uint256 spentPremium,uint64 lastExecutionAt)",
  "function riskStates(bytes32) view returns (uint16 scoreBps,uint64 eligibleSince,uint64 observedAt,uint64 validUntil)",
  "function recordRisk(bytes32,(bytes32 mandateHash,uint16 riskScoreBps,uint64 observedAt,uint64 validUntil,uint64 persistenceSeconds),bytes)",
  "function executeShadow(bytes32,(bytes32 mandateHash,uint16 riskScoreBps,uint64 observedAt,uint64 validUntil,uint64 persistenceSeconds),bytes,(bytes32 fillId,bytes32 sourceHash,bytes32 asset,address buyer,bool isCall,uint128 strikeE8,uint64 expiry,uint64 validUntil,uint128 contractsE6,uint128 premiumUsdc),bytes)",
] as const;
const ENTRY_POINT_ABI = [
  "function getNonce(address sender,uint192 key) view returns (uint256)",
  "function getUserOpHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp) view returns (bytes32)",
] as const;
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
type Gas = { callGasLimit: bigint; verificationGasLimit: bigint; preVerificationGas: bigint };
type UserOperation = {
  sender: string;
  nonce: string;
  callData: string;
  callGasLimit: string;
  verificationGasLimit: string;
  preVerificationGas: string;
  maxPriorityFeePerGas: string;
  maxFeePerGas: string;
  paymaster: null;
  paymasterVerificationGasLimit: null;
  paymasterPostOpGasLimit: null;
  paymasterData: null;
  signature: string;
};

export type ShadowAgentResult = {
  account: string;
  mandateHash: string;
  score: number;
  threshold: number;
  outcome: "risk-below-threshold" | "gas-unfunded" | "risk-observation-submitted" | "quote-unavailable" | "fill-submitted";
  userOpHash?: string;
  detail?: string;
};

export async function runConfiguredShadowAgent(): Promise<ShadowAgentResult> {
  const account = process.env.SHADOW_AGENT_ACCOUNT_ADDRESS;
  if (!account || !ethers.isAddress(account)) throw new Error("SHADOW_AGENT_ACCOUNT_ADDRESS is not configured");
  return runShadowAgent(ethers.getAddress(account));
}

async function runShadowAgent(accountAddress: string): Promise<ShadowAgentResult> {
  const config = runtimeConfig();
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const agent = new ethers.Wallet(config.privateKey);
  const account = new ethers.Contract(accountAddress, ACCOUNT_ABI, provider);
  const policy = await readPolicy(account, accountAddress, agent.address, config);
  const snapshot = await getMarketSnapshot({ fresh: true });
  const score = snapshot.assets[policy.mandate.asset as "BTC" | "ETH"].score;
  const scoreBps = Math.round(score * 100);
  const base = { account: accountAddress, mandateHash: policy.hash, score, threshold: Number(policy.mandate.riskThresholdBps) / 100 };
  if (scoreBps < Number(policy.mandate.riskThresholdBps)) return { ...base, outcome: "risk-below-threshold" };

  if ((await provider.getBalance(accountAddress)) === 0n) {
    return { ...base, outcome: "gas-unfunded", detail: "Fund the policy account with Base Sepolia ETH before scheduling agent runs." };
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
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

  const state = await account.riskStates(policy.hash);
  const persistent = BigInt(state.eligibleSince) !== 0n && BigInt(state.scoreBps) >= policy.mandate.riskThresholdBps &&
    BigInt(state.validUntil) >= now && now >= BigInt(state.eligibleSince) + policy.mandate.persistenceSeconds;
  if (!persistent) {
    const callData = account.interface.encodeFunctionData("recordRisk", [policy.hash, risk, riskSignature]);
    return { ...base, outcome: "risk-observation-submitted", userOpHash: await submitUserOperation(provider, agent, accountAddress, callData, config.pimlicoApiKey) };
  }

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
  return { ...base, outcome: "fill-submitted", userOpHash: await submitUserOperation(provider, agent, accountAddress, callData, config.pimlicoApiKey) };
}

async function readPolicy(account: ethers.Contract, accountAddress: string, agentAddress: string, config: ReturnType<typeof runtimeConfig>) {
  const [entryPoint, riskAttester, hash] = await Promise.all([account.entryPoint(), account.riskAttester(), account.activeMandateHash()]);
  if (entryPoint.toLowerCase() !== ENTRY_POINT.toLowerCase() || riskAttester.toLowerCase() !== agentAddress.toLowerCase() || hash === ethers.ZeroHash) {
    throw new Error("policy account is not configured for this dedicated agent");
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
  ) throw new Error("active mandate is not eligible for shadow execution");
  return { hash: hash as string, mandate, control: { spentPremium: BigInt(control.spentPremium), lastExecutionAt: BigInt(control.lastExecutionAt) } satisfies Control };
}

async function submitUserOperation(provider: ethers.JsonRpcProvider, agent: ethers.Wallet, sender: string, callData: string, apiKey: string) {
  const entryPoint = new ethers.Contract(ENTRY_POINT, ENTRY_POINT_ABI, provider);
  const nonce = BigInt(await entryPoint.getNonce(sender, 0));
  const endpoint = `https://api.pimlico.io/v2/84532/rpc?apikey=${encodeURIComponent(apiKey)}`;
  const prices = await pimlicoRpc<{ fast?: { maxFeePerGas?: string; maxPriorityFeePerGas?: string } }>(endpoint, "pimlico_getUserOperationGasPrice", []);
  const maxFeePerGas = hexBigInt(prices.fast?.maxFeePerGas, "Pimlico max fee");
  const maxPriorityFeePerGas = hexBigInt(prices.fast?.maxPriorityFeePerGas, "Pimlico priority fee");
  const draft = await signUserOperation(entryPoint, agent, sender, nonce, callData, INITIAL_GAS, maxFeePerGas, maxPriorityFeePerGas);
  const estimated = await pimlicoRpc<Record<string, string>>(endpoint, "eth_estimateUserOperationGas", [draft, ENTRY_POINT]);
  const gas: Gas = {
    callGasLimit: hexBigInt(estimated.callGasLimit, "call gas"), verificationGasLimit: hexBigInt(estimated.verificationGasLimit, "verification gas"),
    preVerificationGas: hexBigInt(estimated.preVerificationGas, "pre-verification gas"),
  };
  const final = await signUserOperation(entryPoint, agent, sender, nonce, callData, gas, maxFeePerGas, maxPriorityFeePerGas);
  await pimlicoRpc(endpoint, "eth_estimateUserOperationGas", [final, ENTRY_POINT]);
  return pimlicoRpc<string>(endpoint, "eth_sendUserOperation", [final, ENTRY_POINT]);
}

async function signUserOperation(entryPoint: ethers.Contract, agent: ethers.Wallet, sender: string, nonce: bigint, callData: string, gas: Gas, maxFeePerGas: bigint, maxPriorityFeePerGas: bigint): Promise<UserOperation> {
  const unsigned = userOperation(sender, nonce, callData, gas, maxFeePerGas, maxPriorityFeePerGas, "0x");
  const hash = await entryPoint.getUserOpHash(packUserOperation(unsigned));
  return { ...unsigned, signature: agent.signingKey.sign(hash).serialized };
}

function userOperation(sender: string, nonce: bigint, callData: string, gas: Gas, maxFeePerGas: bigint, maxPriorityFeePerGas: bigint, signature: string): UserOperation {
  return {
    sender, nonce: ethers.toBeHex(nonce), callData, callGasLimit: ethers.toBeHex(gas.callGasLimit), verificationGasLimit: ethers.toBeHex(gas.verificationGasLimit),
    preVerificationGas: ethers.toBeHex(gas.preVerificationGas), maxFeePerGas: ethers.toBeHex(maxFeePerGas), maxPriorityFeePerGas: ethers.toBeHex(maxPriorityFeePerGas),
    paymaster: null, paymasterVerificationGasLimit: null, paymasterPostOpGasLimit: null, paymasterData: null, signature,
  };
}

function packUserOperation(op: UserOperation) {
  return {
    sender: op.sender, nonce: BigInt(op.nonce), initCode: "0x", callData: op.callData,
    accountGasLimits: pack128(BigInt(op.verificationGasLimit), BigInt(op.callGasLimit)), preVerificationGas: BigInt(op.preVerificationGas),
    gasFees: pack128(BigInt(op.maxPriorityFeePerGas), BigInt(op.maxFeePerGas)), paymasterAndData: "0x", signature: op.signature,
  };
}

function pack128(high: bigint, low: bigint) {
  if (high < 0n || low < 0n || high >= 1n << 128n || low >= 1n << 128n) throw new Error("UserOperation gas value is out of range");
  return ethers.concat([ethers.zeroPadValue(ethers.toBeHex(high), 16), ethers.zeroPadValue(ethers.toBeHex(low), 16)]);
}

async function pimlicoRpc<T>(endpoint: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), cache: "no-store" });
  if (!response.ok) throw new Error(`Pimlico request failed (${response.status})`);
  const body = await response.json() as { result?: T; error?: { message?: string } };
  if (body.error || body.result === undefined) throw new Error(body.error?.message ?? `Pimlico ${method} failed`);
  return body.result;
}

function hexBigInt(value: string | undefined, label: string) {
  if (!value || !/^0x[0-9a-f]+$/i.test(value)) throw new Error(`${label} is unavailable`);
  return BigInt(value);
}

function runtimeConfig() {
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL;
  const privateKey = process.env.SHADOW_QUOTE_SIGNER_PRIVATE_KEY;
  const pimlicoApiKey = process.env.PIMLICO_API_KEY;
  const optionBook = process.env.SHADOW_OPTION_BOOK_ADDRESS;
  const usdc = process.env.SHADOW_USDC_ADDRESS;
  if (!rpcUrl || !privateKey || !pimlicoApiKey || !optionBook || !usdc || !ethers.isAddress(optionBook) || !ethers.isAddress(usdc)) {
    throw new Error("Base Sepolia agent configuration is incomplete");
  }
  return { rpcUrl, privateKey: privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`, pimlicoApiKey, optionBook: ethers.getAddress(optionBook), usdc: ethers.getAddress(usdc) };
}
