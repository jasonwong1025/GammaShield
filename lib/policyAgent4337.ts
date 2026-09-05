import "server-only";

import { ethers } from "ethers";
import { toPackedUserOperation, type UserOperation as ViemUserOperation } from "viem/account-abstraction";

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const INITIAL_GAS = { callGasLimit: 300_000n, verificationGasLimit: 600_000n, preVerificationGas: 100_000n };
const ENTRY_POINT_ABI = [
  "function getNonce(address sender,uint192 key) view returns (uint256)",
  "function getUserOpHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp) view returns (bytes32)",
] as const;

type Gas = { callGasLimit: bigint; verificationGasLimit: bigint; preVerificationGas: bigint };
type UserOperation = {
  sender: string; nonce: string; callData: string; callGasLimit: string; verificationGasLimit: string; preVerificationGas: string;
  maxPriorityFeePerGas: string; maxFeePerGas: string; paymaster: null; paymasterVerificationGasLimit: null;
  paymasterPostOpGasLimit: null; paymasterData: null; signature: string;
};

export async function submitPolicyUserOperation({ chainId, provider, agent, sender, callData, pimlicoApiKey, dryRun = false }: { chainId: 8453 | 84532; provider: ethers.Provider; agent: ethers.Wallet; sender: string; callData: string; pimlicoApiKey: string; dryRun?: boolean }) {
  const entryPoint = new ethers.Contract(ENTRY_POINT, ENTRY_POINT_ABI, provider);
  const nonce = BigInt(await entryPoint.getNonce(sender, 0));
  const endpoint = `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${encodeURIComponent(pimlicoApiKey)}`;
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
  if (dryRun) return null;
  return pimlicoRpc<string>(endpoint, "eth_sendUserOperation", [final, ENTRY_POINT]);
}

export async function getPolicyUserOperationReceipt(chainId: 8453 | 84532, pimlicoApiKey: string, userOpHash: string) {
  if (!ethers.isHexString(userOpHash, 32)) throw new Error("invalid UserOperation hash");
  return pimlicoRpc<unknown>(`https://api.pimlico.io/v2/${chainId}/rpc?apikey=${encodeURIComponent(pimlicoApiKey)}`, "eth_getUserOperationReceipt", [userOpHash]);
}

async function signUserOperation(entryPoint: ethers.Contract, agent: ethers.Wallet, sender: string, nonce: bigint, callData: string, gas: Gas, maxFeePerGas: bigint, maxPriorityFeePerGas: bigint): Promise<UserOperation> {
  const unsigned = userOperation(sender, nonce, callData, gas, maxFeePerGas, maxPriorityFeePerGas, "0x");
  const hash = await entryPoint.getUserOpHash(packUserOperation(unsigned));
  return { ...unsigned, signature: agent.signingKey.sign(hash).serialized };
}

function userOperation(sender: string, nonce: bigint, callData: string, gas: Gas, maxFeePerGas: bigint, maxPriorityFeePerGas: bigint, signature: string): UserOperation {
  return { sender, nonce: ethers.toBeHex(nonce), callData, callGasLimit: ethers.toBeHex(gas.callGasLimit), verificationGasLimit: ethers.toBeHex(gas.verificationGasLimit), preVerificationGas: ethers.toBeHex(gas.preVerificationGas), maxFeePerGas: ethers.toBeHex(maxFeePerGas), maxPriorityFeePerGas: ethers.toBeHex(maxPriorityFeePerGas), paymaster: null, paymasterVerificationGasLimit: null, paymasterPostOpGasLimit: null, paymasterData: null, signature };
}

function packUserOperation(op: UserOperation) {
  return toPackedUserOperation({ sender: op.sender as `0x${string}`, nonce: BigInt(op.nonce), callData: op.callData as `0x${string}`, callGasLimit: BigInt(op.callGasLimit), verificationGasLimit: BigInt(op.verificationGasLimit), preVerificationGas: BigInt(op.preVerificationGas), maxPriorityFeePerGas: BigInt(op.maxPriorityFeePerGas), maxFeePerGas: BigInt(op.maxFeePerGas), signature: op.signature as `0x${string}` } satisfies ViemUserOperation<"0.7">);
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
