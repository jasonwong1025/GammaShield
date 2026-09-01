"use client";

import { terminalPayoff, type ResolvedLeg } from "@/lib/strategyPayoff";

export function StrategyPayoffChart({ legs, netPremiumPerUnit, spot }: { legs: ResolvedLeg[]; netPremiumPerUnit: number; spot: number }) {
  const width = 320;
  const height = 120;
  const pad = 12;
  const prices = Array.from({ length: 61 }, (_, index) => spot * (0.6 + (index * 0.8) / 60));
  const values = prices.map((price) => terminalPayoff(price, legs, netPremiumPerUnit));
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const range = Math.max(max - min, 0.000001);
  const x = (price: number) => pad + ((price - prices[0]) / (prices.at(-1)! - prices[0])) * (width - pad * 2);
  const y = (value: number) => pad + (1 - (value - min) / range) * (height - pad * 2);
  const path = prices.map((price, index) => `${index ? "L" : "M"}${x(price).toFixed(1)},${y(values[index]).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-28 w-full" role="img" aria-label="Strategy payoff at expiry">
      <line x1={pad} x2={width - pad} y1={y(0)} y2={y(0)} stroke="var(--edge-2)" strokeDasharray="4 4" />
      <line x1={x(spot)} x2={x(spot)} y1={pad} y2={height - pad} stroke="var(--edge-2)" strokeDasharray="3 3" />
      <path d={path} fill="none" stroke="var(--blue)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
