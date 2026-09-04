// Cross-component signal that a wallet just filled an option, on either the
// live Base OptionBook or the Base Sepolia shadow book. TradePanel dispatches
// this on the window; BookFeed listens and routes the detail to whichever
// positions list matches, so a fresh fill can render as a "pending" row
// immediately instead of waiting on the Thetanuts indexer in silence.
import type { Asset } from "./assets";

export const POSITION_CHANGED_EVENT = "thetanuts-position-changed";

export type PositionChangeDetail = {
  network: "mainnet" | "shadow";
  txHash: string;
  asset: Asset;
  // Known for a direct book fill (buy / buyShadow), where the exact terms
  // were just simulated client-side. Null for an RFQ settle, whose final
  // strike/expiry live only in the maker's signed offer — never fabricate
  // them, just refresh faster and let the indexer supply the real row.
  isCall: boolean | null;
  strike: number | null;
  expiryTs: number | null;
  contracts: number | null;
  // Only the shadow book's receipt list renders a premium column — null on
  // every mainnet dispatch, real for a shadow fill (known from its quote).
  premiumUsd: number | null;
};

export function dispatchPositionChanged(detail: PositionChangeDetail) {
  window.dispatchEvent(new CustomEvent<PositionChangeDetail>(POSITION_CHANGED_EVENT, { detail }));
}
