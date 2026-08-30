// Catalog of Hegic-style multi-leg option strategies. Kept dependency-free
// (no SDK, no ethers) so client components can import it directly, mirroring
// lib/tradePeriods.ts / lib/collateral.ts.
//
// Each leg's strike is expressed as a signed step on the nearest-listed-strike
// grid at the strategy's resolved expiry, relative to the ATM strike (0 = ATM,
// positive = higher strikes, negative = lower strikes) — see
// lib/strategyQuote.ts for how that resolves against the real book.
//
// `executable` is true only when every leg is a "buy": the live Thetanuts
// OptionBook/RFQ only support the taker going long, so a strategy with any
// "sell" leg can be priced and displayed but not actually filled on-chain yet
// (see AGENTS.md "Honesty about data" — it's labeled "Simulated" in the UI,
// never silently treated as tradable).

export type SentimentBucket = "bullish" | "bearish" | "highVol" | "lowVol";

export type StrategyLeg = {
  side: "call" | "put";
  action: "buy" | "sell";
  /** Signed step on the nearest-listed-strike grid, relative to ATM (0 = ATM). */
  strikeOffset: number;
  /** Relative weight within the strategy, e.g. Strap's 2x call. */
  qty: number;
};

export type StrategyDef = {
  id: string;
  name: string;
  sentiment: SentimentBucket;
  description: string;
  legs: StrategyLeg[];
  /** Derived: true iff every leg is a "buy" — no short leg to fill. */
  executable: boolean;
};

const catalog: Omit<StrategyDef, "executable">[] = [
  {
    id: "call",
    name: "Call",
    sentiment: "bullish",
    description: "High profits if the price rises sharply.",
    legs: [{ side: "call", action: "buy", strikeOffset: 0, qty: 1 }],
  },
  {
    id: "strap",
    name: "Strap",
    sentiment: "bullish",
    description: "High profits if the price rises sharply, reasonable profits if it falls.",
    legs: [
      { side: "call", action: "buy", strikeOffset: 0, qty: 2 },
      { side: "put", action: "buy", strikeOffset: 0, qty: 1 },
    ],
  },
  {
    id: "bull-call-spread",
    name: "Bull Call Spread",
    sentiment: "bullish",
    description: "Low cost, decent profits if the price rises to a certain level.",
    legs: [
      { side: "call", action: "buy", strikeOffset: 0, qty: 1 },
      { side: "call", action: "sell", strikeOffset: 1, qty: 1 },
    ],
  },
  {
    id: "bull-put-spread",
    name: "Bull Put Spread",
    sentiment: "bullish",
    description: "Low cost, decent profits if the price stays at a certain level or rises.",
    legs: [
      { side: "put", action: "sell", strikeOffset: 0, qty: 1 },
      { side: "put", action: "buy", strikeOffset: -1, qty: 1 },
    ],
  },
  {
    id: "put",
    name: "Put",
    sentiment: "bearish",
    description: "High profits if the price falls sharply.",
    legs: [{ side: "put", action: "buy", strikeOffset: 0, qty: 1 }],
  },
  {
    id: "strip",
    name: "Strip",
    sentiment: "bearish",
    description: "High profits if the price falls sharply, reasonable profits if it rises.",
    legs: [
      { side: "call", action: "buy", strikeOffset: 0, qty: 1 },
      { side: "put", action: "buy", strikeOffset: 0, qty: 2 },
    ],
  },
  {
    id: "bear-put-spread",
    name: "Bear Put Spread",
    sentiment: "bearish",
    description: "Low cost, decent profits if the price falls to a certain level.",
    legs: [
      { side: "put", action: "buy", strikeOffset: 0, qty: 1 },
      { side: "put", action: "sell", strikeOffset: -1, qty: 1 },
    ],
  },
  {
    id: "bear-call-spread",
    name: "Bear Call Spread",
    sentiment: "bearish",
    description: "Low cost, decent profits if the price stays at a certain level or falls.",
    legs: [
      { side: "call", action: "sell", strikeOffset: 0, qty: 1 },
      { side: "call", action: "buy", strikeOffset: 1, qty: 1 },
    ],
  },
  {
    id: "straddle",
    name: "Straddle",
    sentiment: "highVol",
    description: "High profits if the price rises or falls sharply during the period of holding.",
    legs: [
      { side: "call", action: "buy", strikeOffset: 0, qty: 1 },
      { side: "put", action: "buy", strikeOffset: 0, qty: 1 },
    ],
  },
  {
    id: "strangle",
    name: "Strangle",
    sentiment: "highVol",
    description: "Low cost, very high profits if the price rises or falls significantly.",
    legs: [
      { side: "call", action: "buy", strikeOffset: 1, qty: 1 },
      { side: "put", action: "buy", strikeOffset: -1, qty: 1 },
    ],
  },
  {
    id: "long-butterfly",
    name: "Long Butterfly",
    sentiment: "lowVol",
    description: "Low cost, high profits if the price stays about a strike price.",
    legs: [
      { side: "call", action: "buy", strikeOffset: -1, qty: 1 },
      { side: "call", action: "sell", strikeOffset: 0, qty: 2 },
      { side: "call", action: "buy", strikeOffset: 1, qty: 1 },
    ],
  },
  {
    id: "long-condor",
    name: "Long Condor",
    sentiment: "lowVol",
    description: "Decent profits if the price changes slightly.",
    legs: [
      { side: "call", action: "buy", strikeOffset: -2, qty: 1 },
      { side: "call", action: "sell", strikeOffset: -1, qty: 1 },
      { side: "call", action: "sell", strikeOffset: 1, qty: 1 },
      { side: "call", action: "buy", strikeOffset: 2, qty: 1 },
    ],
  },
];

export const STRATEGY_CATALOG: StrategyDef[] = catalog.map((s) => ({
  ...s,
  executable: s.legs.every((l) => l.action === "buy"),
}));

export const SENTIMENTS: { id: SentimentBucket; label: string }[] = [
  { id: "bullish", label: "Bullish" },
  { id: "bearish", label: "Bearish" },
  { id: "highVol", label: "High Vol" },
  { id: "lowVol", label: "Low Vol" },
];

export function strategiesBySentiment(sentiment: SentimentBucket): StrategyDef[] {
  return STRATEGY_CATALOG.filter((s) => s.sentiment === sentiment);
}

export function getStrategy(id: string): StrategyDef | null {
  return STRATEGY_CATALOG.find((s) => s.id === id) ?? null;
}
