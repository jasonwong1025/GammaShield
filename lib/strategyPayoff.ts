export type ResolvedLeg = {
  side: "call" | "put";
  action: "buy" | "sell";
  strike: number;
  qty: number;
};

export function terminalPayoff(spot: number, legs: ResolvedLeg[], netPremium: number): number {
  const intrinsic = legs.reduce((total, leg) => {
    const value = leg.side === "call" ? Math.max(spot - leg.strike, 0) : Math.max(leg.strike - spot, 0);
    return total + (leg.action === "buy" ? 1 : -1) * leg.qty * value;
  }, 0);
  return intrinsic - netPremium;
}

export type PayoffAnalysis = {
  maxProfit: number | "unlimited";
  maxLoss: number | "unlimited";
  breakevens: number[];
};

export function analyzePayoff(legs: ResolvedLeg[], netPremium: number): PayoffAnalysis {
  const strikes = [...new Set(legs.map((leg) => leg.strike))].sort((a, b) => a - b);
  const points = [0, ...strikes];
  const values = points.map((spot) => terminalPayoff(spot, legs, netPremium));
  const upsideSlope = legs
    .filter((leg) => leg.side === "call")
    .reduce((total, leg) => total + (leg.action === "buy" ? 1 : -1) * leg.qty, 0);
  const breakevens: number[] = [];

  for (let index = 0; index < points.length - 1; index++) {
    const [x0, x1] = [points[index], points[index + 1]];
    const [y0, y1] = [values[index], values[index + 1]];
    if (y0 !== y1 && ((y0 <= 0 && y1 >= 0) || (y0 >= 0 && y1 <= 0))) {
      breakevens.push(x0 + (y0 / (y0 - y1)) * (x1 - x0));
    }
  }
  if (upsideSlope !== 0) {
    const last = points.length - 1;
    const beyondLast = -values[last] / upsideSlope;
    if (beyondLast >= 0) breakevens.push(points[last] + beyondLast);
  }

  return {
    maxProfit: upsideSlope > 0 ? "unlimited" : Math.max(0, ...values),
    maxLoss: upsideSlope < 0 ? "unlimited" : Math.max(0, ...values.map((value) => -value)),
    breakevens: [...new Set(breakevens.map((value) => Math.round(value * 100) / 100))].sort((a, b) => a - b),
  };
}
