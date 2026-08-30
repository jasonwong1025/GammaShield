// Generic piecewise-linear payoff engine for multi-leg option strategies —
// one implementation for all 12 lib/strategy.ts shapes instead of a
// hand-written max-profit/max-loss/breakeven formula per strategy (easy to
// get a sign wrong on a credit spread). Pure math, no I/O.

export type ResolvedLeg = {
  side: "call" | "put";
  action: "buy" | "sell";
  strike: number;
  qty: number;
};

/** Terminal payoff (USD per unit of the base contract) at spot `S` at expiry. */
export function terminalPayoff(S: number, legs: ResolvedLeg[], netPremium: number): number {
  const intrinsic = legs.reduce((sum, l) => {
    const iv = l.side === "call" ? Math.max(S - l.strike, 0) : Math.max(l.strike - S, 0);
    return sum + (l.action === "buy" ? 1 : -1) * l.qty * iv;
  }, 0);
  return intrinsic - netPremium;
}

export type PayoffAnalysis = {
  maxProfit: number | "unlimited";
  maxLoss: number | "unlimited";
  /** Terminal spot levels where the position crosses zero P&L. */
  breakevens: number[];
};

// Payoff is piecewise-linear with kinks only at each leg's strike; spot is
// bounded below at 0. So: evaluate at 0 and every distinct strike to find the
// bounded extrema, and check the slope of the S→∞ tail (only calls contribute
// there — puts flatten to 0) to see whether profit/loss is actually unbounded
// on the upside.
export function analyzePayoff(legs: ResolvedLeg[], netPremium: number): PayoffAnalysis {
  const strikes = [...new Set(legs.map((l) => l.strike))].sort((a, b) => a - b);
  const points = [0, ...strikes];
  const values = points.map((S) => terminalPayoff(S, legs, netPremium));

  const upsideSlope = legs
    .filter((l) => l.side === "call")
    .reduce((s, l) => s + (l.action === "buy" ? 1 : -1) * l.qty, 0);

  const maxOf = Math.max(...values);
  const minOf = Math.min(...values);

  const maxProfit: PayoffAnalysis["maxProfit"] = upsideSlope > 0 ? "unlimited" : Math.max(0, maxOf);
  const maxLoss: PayoffAnalysis["maxLoss"] = upsideSlope < 0 ? "unlimited" : Math.max(0, -minOf);

  const breakevens: number[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, x1] = [points[i], points[i + 1]];
    const [y0, y1] = [values[i], values[i + 1]];
    if (y0 === y1) continue;
    if ((y0 <= 0 && y1 >= 0) || (y0 >= 0 && y1 <= 0)) {
      const t = y0 / (y0 - y1);
      breakevens.push(x0 + t * (x1 - x0));
    }
  }
  // The tail beyond the last strike continues linearly with slope upsideSlope.
  if (upsideSlope !== 0) {
    const lastX = points[points.length - 1];
    const lastY = values[values.length - 1];
    const dx = -lastY / upsideSlope;
    if (dx >= 0) breakevens.push(lastX + dx);
  }
  breakevens.sort((a, b) => a - b);

  return { maxProfit, maxLoss, breakevens: [...new Set(breakevens.map((b) => Math.round(b * 100) / 100))] };
}
