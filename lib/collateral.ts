// Base-mainnet collateral tokens for Thetanuts vanilla options/RFQs, plus the
// reserve-price rule RFQs use. Kept dependency-free (no SDK import, mirroring
// lib/tradePeriods.ts) so client components can read these without pulling
// lib/rfq.ts's server-only SDK usage into the browser bundle.

import type { OptionsAsset } from "./assets";
import type { TradeSide } from "./trade";

export const COLLATERAL_TOKENS = {
  USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
  WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18 },
  cbBTC: { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8 },
} as const;

export type CollateralSymbol = keyof typeof COLLATERAL_TOKENS;

/** RFQ escrows reservePrice × contracts upfront; this caps makers at ~15% over the MM ask. */
export const RESERVE_BUFFER = 1.15;

export function collateralFor(asset: OptionsAsset, side: TradeSide): CollateralSymbol {
  if (side === "put") return "USDC";
  return asset === "ETH" ? "WETH" : "cbBTC";
}

/** aBasWETH/aBascbBTC/aBasUSDC wrap the same-decimals underlying — strip the prefix to look up decimals. */
export function decimalsForTokenSymbol(symbol: string): number {
  const base = symbol.replace(/^aBas/, "") as CollateralSymbol;
  return COLLATERAL_TOKENS[base]?.decimals ?? 18;
}
