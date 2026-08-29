// Standard periods the Thetanuts tenor grid is built around — no in-between
// days. Kept dependency-free so client components can import the runtime
// constant without pulling in lib/trade.ts's server-only SDK usage.
export const TRADE_PERIODS = [7, 14, 28] as const;
export type TradePeriod = (typeof TRADE_PERIODS)[number];
