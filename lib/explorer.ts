import { isAddress, isHash } from "viem";

export type ExecutionNetwork = "mainnet" | "sepolia";
export type ExplorerResource = "address" | "tx";

export const EXECUTION_NETWORK = {
  mainnet: {
    chainId: 8453,
    label: "Base mainnet",
    shortLabel: "Base",
    explorerUrl: process.env.NEXT_PUBLIC_BASE_EXPLORER_URL ?? "https://basescan.org",
  },
  sepolia: {
    chainId: 84532,
    label: "Base Sepolia",
    shortLabel: "Sepolia",
    explorerUrl: process.env.NEXT_PUBLIC_BASE_SEPOLIA_EXPLORER_URL ?? "https://sepolia-explorer.base.org",
  },
} as const;

export function executionNetworkForChainId(chainId: number | undefined): ExecutionNetwork | null {
  if (chainId === EXECUTION_NETWORK.mainnet.chainId) return "mainnet";
  if (chainId === EXECUTION_NETWORK.sepolia.chainId) return "sepolia";
  return null;
}

export function explorerHref(network: ExecutionNetwork, resource: ExplorerResource, value: string): string | null {
  if (resource === "address" ? !isAddress(value) : !isHash(value)) return null;
  return `${EXECUTION_NETWORK[network].explorerUrl}/${resource}/${value}`;
}
