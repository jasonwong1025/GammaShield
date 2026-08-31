import { isAddress, type Address } from "viem";
import { type ExecutionNetwork, EXECUTION_NETWORK } from "@/lib/explorer";

type PolicyNetworkConfig = {
  chainId: (typeof EXECUTION_NETWORK)[ExecutionNetwork]["chainId"];
  factory: Address | undefined;
  optionBook: Address | undefined;
  collateral: Address | undefined;
  agent: Address | undefined;
  collateralLabel: string;
  autonomousSide: "put" | "call" | "both";
};

const asAddress = (value: string | undefined) => value && isAddress(value) ? value : undefined;

export function policyNetwork(network: ExecutionNetwork): PolicyNetworkConfig {
  if (network === "mainnet") {
    return {
      chainId: EXECUTION_NETWORK.mainnet.chainId,
      factory: asAddress(process.env.NEXT_PUBLIC_BASE_MANDATE_FACTORY_ADDRESS),
      optionBook: "0x1bDff855d6811728acaDC00989e79143a2bdfDed",
      collateral: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      agent: asAddress(process.env.NEXT_PUBLIC_BASE_AGENT_ADDRESS),
      collateralLabel: "USDC",
      autonomousSide: "put",
    };
  }
  return {
    chainId: EXECUTION_NETWORK.sepolia.chainId,
    factory: asAddress(process.env.NEXT_PUBLIC_BASE_SEPOLIA_MANDATE_FACTORY_ADDRESS),
    optionBook: asAddress(process.env.NEXT_PUBLIC_BASE_SEPOLIA_SHADOW_OPTION_BOOK_ADDRESS),
    collateral: asAddress(process.env.NEXT_PUBLIC_BASE_SEPOLIA_SHADOW_USDC_ADDRESS),
    agent: asAddress(process.env.NEXT_PUBLIC_BASE_SEPOLIA_AGENT_ADDRESS),
    collateralLabel: "test USDC",
    autonomousSide: "both",
  };
}
