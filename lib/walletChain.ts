import type { Connector } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { BaseError } from "viem";

type SupportedChainId = typeof base.id | typeof baseSepolia.id;

export class WalletChainError extends Error {}

export async function ensureWalletChain(targetChainId: SupportedChainId, connector: Connector | undefined, switchChainAsync: (args: { chainId: SupportedChainId }) => Promise<unknown>) {
  if (!connector) throw new WalletChainError("Reconnect your wallet before submitting this transaction.");
  if (await connector.getChainId() === targetChainId) return;
  await switchChainAsync({ chainId: targetChainId });
  const walletChainId = await connector.getChainId();
  if (walletChainId !== targetChainId) throw new WalletChainError(`Your wallet is still on ${chainLabel(walletChainId)}. Switch it to ${chainLabel(targetChainId)} and retry.`);
}

export function chainLabel(chainId: number | undefined) {
  if (chainId === base.id) return "Base Mainnet";
  if (chainId === baseSepolia.id) return "Base Sepolia";
  if (chainId === 1) return "Ethereum Mainnet";
  return chainId == null ? "an unknown network" : `chain ${chainId}`;
}

export function walletActionError(error: unknown, fallback: string) {
  if (error instanceof WalletChainError) return error.message;
  if (error instanceof BaseError && error.shortMessage) return error.shortMessage;
  return fallback;
}
