// The multi-leg choices are declarative. Quotes and execution stay in the
// normal Thetanuts SDK path; this catalog never creates calldata.

export type SentimentBucket = "bullish" | "bearish" | "highVol" | "lowVol";

export type StrategyLeg = {
  side: "call" | "put";
  action: "buy" | "sell";
  /** Offset from the nearest real strike at the chosen expiry. */
  strikeOffset: number;
  qty: number;
};

export type StrategyDef = {
  id: string;
  name: string;
  sentiment: SentimentBucket;
  description: string;
  legs: StrategyLeg[];
};

export const STRATEGY_CATALOG: StrategyDef[] = [
  {
    id: "strap",
    name: "Strap",
    sentiment: "bullish",
    description: "Long volatility with more upside exposure.",
    legs: [{ side: "call", action: "buy", strikeOffset: 0, qty: 2 }, { side: "put", action: "buy", strikeOffset: 0, qty: 1 }],
  },
  {
    id: "bull-call-spread",
    name: "Bull Call Spread",
    sentiment: "bullish",
    description: "Defined-risk upside between two strikes.",
    legs: [{ side: "call", action: "buy", strikeOffset: 0, qty: 1 }, { side: "call", action: "sell", strikeOffset: 1, qty: 1 }],
  },
  {
    id: "bull-put-spread",
    name: "Bull Put Spread",
    sentiment: "bullish",
    description: "Defined-risk credit structure below spot.",
    legs: [{ side: "put", action: "sell", strikeOffset: 0, qty: 1 }, { side: "put", action: "buy", strikeOffset: -1, qty: 1 }],
  },
  {
    id: "strip",
    name: "Strip",
    sentiment: "bearish",
    description: "Long volatility with more downside exposure.",
    legs: [{ side: "call", action: "buy", strikeOffset: 0, qty: 1 }, { side: "put", action: "buy", strikeOffset: 0, qty: 2 }],
  },
  {
    id: "bear-put-spread",
    name: "Bear Put Spread",
    sentiment: "bearish",
    description: "Defined-risk downside between two strikes.",
    legs: [{ side: "put", action: "buy", strikeOffset: 0, qty: 1 }, { side: "put", action: "sell", strikeOffset: -1, qty: 1 }],
  },
  {
    id: "bear-call-spread",
    name: "Bear Call Spread",
    sentiment: "bearish",
    description: "Defined-risk credit structure above spot.",
    legs: [{ side: "call", action: "sell", strikeOffset: 0, qty: 1 }, { side: "call", action: "buy", strikeOffset: 1, qty: 1 }],
  },
  {
    id: "straddle",
    name: "Straddle",
    sentiment: "highVol",
    description: "Long volatility at the nearest shared strike.",
    legs: [{ side: "call", action: "buy", strikeOffset: 0, qty: 1 }, { side: "put", action: "buy", strikeOffset: 0, qty: 1 }],
  },
  {
    id: "strangle",
    name: "Strangle",
    sentiment: "highVol",
    description: "Long volatility at separated real strikes.",
    legs: [{ side: "call", action: "buy", strikeOffset: 1, qty: 1 }, { side: "put", action: "buy", strikeOffset: -1, qty: 1 }],
  },
  {
    id: "long-butterfly",
    name: "Long Butterfly",
    sentiment: "lowVol",
    description: "Defined-risk range view around the middle strike.",
    legs: [{ side: "call", action: "buy", strikeOffset: -1, qty: 1 }, { side: "call", action: "sell", strikeOffset: 0, qty: 2 }, { side: "call", action: "buy", strikeOffset: 1, qty: 1 }],
  },
  {
    id: "long-condor",
    name: "Long Condor",
    sentiment: "lowVol",
    description: "Defined-risk range view across four strikes.",
    legs: [{ side: "call", action: "buy", strikeOffset: -2, qty: 1 }, { side: "call", action: "sell", strikeOffset: -1, qty: 1 }, { side: "call", action: "sell", strikeOffset: 1, qty: 1 }, { side: "call", action: "buy", strikeOffset: 2, qty: 1 }],
  },
];

export const SENTIMENTS: { id: SentimentBucket; label: string }[] = [
  { id: "bullish", label: "Bullish" },
  { id: "bearish", label: "Bearish" },
  { id: "highVol", label: "High vol" },
  { id: "lowVol", label: "Low vol" },
];

export function strategiesBySentiment(sentiment: SentimentBucket): StrategyDef[] {
  return STRATEGY_CATALOG.filter((strategy) => strategy.sentiment === sentiment);
}

export function getStrategy(id: string): StrategyDef | null {
  return STRATEGY_CATALOG.find((strategy) => strategy.id === id) ?? null;
}
