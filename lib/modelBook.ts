// Black-Scholes pricing/greeks, computed against the LIVE spot price for the
// shadow demo book (lib/shadow.ts) and for rho, which the Thetanuts pricing
// API doesn't return (lib/snapshot.ts, lib/trade.ts).

// --- Black-Scholes greeks ---

function normPdf(x: number) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function normCdf(x: number) {
  // Abramowitz & Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly =
    t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const p = 1 - normPdf(x) * poly;
  return x >= 0 ? p : 1 - p;
}

export function bsOptionPrice(spot: number, strike: number, iv: number, yearsToExpiry: number, isCall: boolean) {
  const intrinsic = Math.max(isCall ? spot - strike : strike - spot, 0);
  if (!Number.isFinite(spot) || !Number.isFinite(strike) || spot <= 0 || strike <= 0) return NaN;
  if (yearsToExpiry <= 0 || !Number.isFinite(iv) || iv <= 0) return intrinsic;
  const rootT = Math.sqrt(yearsToExpiry);
  const d1 = (Math.log(spot / strike) + 0.5 * iv * iv * yearsToExpiry) / (iv * rootT);
  const d2 = d1 - iv * rootT;
  return isCall ? spot * normCdf(d1) - strike * normCdf(d2) : strike * normCdf(-d2) - spot * normCdf(-d1);
}

export function bsGreeks(spot: number, strike: number, iv: number, yearsToExpiry: number, isCall: boolean) {
  const T = Math.max(yearsToExpiry, 1 / 365 / 24);
  const d1 = (Math.log(spot / strike) + 0.5 * iv * iv * T) / (iv * Math.sqrt(T));
  const d2 = d1 - iv * Math.sqrt(T);
  const delta = isCall ? normCdf(d1) : normCdf(d1) - 1;
  const gamma = normPdf(d1) / (spot * iv * Math.sqrt(T));
  const theta = (-spot * normPdf(d1) * iv) / (2 * Math.sqrt(T)) / 365;
  const vega = (spot * normPdf(d1) * Math.sqrt(T)) / 100;
  // Rho isn't part of the Thetanuts pricing API response — it's derived here
  // the same way theta/vega are, at zero risk-free rate (consistent with d1
  // above, which also omits an r*T term).
  const rho = isCall ? (strike * T * normCdf(d2)) / 100 : (-strike * T * normCdf(-d2)) / 100;
  return { delta, gamma, iv, theta, vega, rho };
}

// Rho for a book order whose live greeks (delta/gamma/theta/vega) came from
// the Thetanuts pricing API but don't include rho — computed standalone so
// callers don't have to re-derive the other four via Black-Scholes.
export function bsRho(spot: number, strike: number, iv: number, yearsToExpiry: number, isCall: boolean) {
  const T = Math.max(yearsToExpiry, 1 / 365 / 24);
  const d1 = (Math.log(spot / strike) + 0.5 * iv * iv * T) / (iv * Math.sqrt(T));
  const d2 = d1 - iv * Math.sqrt(T);
  return isCall ? (strike * T * normCdf(d2)) / 100 : (-strike * T * normCdf(-d2)) / 100;
}
