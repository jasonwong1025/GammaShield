// Server-side view of real, open OptionBook positions from the Thetanuts indexer.

import type { Position } from "@thetanuts-finance/thetanuts-client";
import { type OptionsAsset } from "./assets";
import { getClient } from "./snapshot";

export type ThetanutsPosition = {
  id: string;
  asset: OptionsAsset;
  isCall: boolean;
  strike: number;
  expiryTs: number;
  contracts: number;
  status: string;
  entryTxHash: string | null;
  pnlUsd: number | null;
};

function assetFor(underlying: string): OptionsAsset | null {
  const value = underlying.toUpperCase();
  return value.includes("BTC") ? "BTC" : value.includes("ETH") ? "ETH" : null;
}

function usd8(value: string | null | undefined): number | null {
  if (!value || !/^-?\d+$/.test(value)) return null;
  const amount = Number(BigInt(value)) / 1e8;
  return Number.isFinite(amount) ? amount : null;
}

function normalize(position: Position): ThetanutsPosition | null {
  const asset = assetFor(position.option.underlying);
  const strike = position.option.strikes[0];
  if (!asset || strike == null) return null;

  return {
    id: position.id,
    asset,
    isCall: position.option.optionType === 0,
    strike: Number(strike) / 1e8,
    expiryTs: position.option.expiry,
    contracts: Number(position.amount) / 1e6,
    status: position.status || "open",
    entryTxHash: position.entryTxHash || null,
    pnlUsd: usd8(position.pnlUsd),
  };
}

export async function getThetanutsPositions(address: string): Promise<ThetanutsPosition[]> {
  const positions = await getClient().api.getUserPositionsFromIndexer(address);
  return positions.flatMap((position) => {
    const normalized = normalize(position);
    return normalized ? [normalized] : [];
  });
}
