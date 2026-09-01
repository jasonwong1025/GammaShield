// Shared asset registry. "Options" assets have a live Thetanuts book on Base
// and get the full risk stack; the rest are spot charts only until an
// on-chain options market exists for them.

export type Asset = "BTC" | "ETH";
export type OptionsAsset = "BTC" | "ETH";

export const ASSET_META: Record<Asset, { name: string; options: boolean }> = {
  BTC: { name: "Bitcoin", options: true },
  ETH: { name: "Ethereum", options: true },
};

export const ALL_ASSETS = Object.keys(ASSET_META) as Asset[];

export function isOptionsAsset(a: Asset): a is OptionsAsset {
  return ASSET_META[a].options;
}
