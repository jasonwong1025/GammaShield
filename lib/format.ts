export function fmtUsd(v: number, compact = true, maximumFractionDigits = 0): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (compact) {
    if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
    if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
    if (abs >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  }
  return `$${v.toLocaleString("en-US", { maximumFractionDigits })}`;
}

export function fmtSignedUsd(v: number): string {
  const s = fmtUsd(Math.abs(v));
  return v < 0 ? `-${s}` : `+${s}`;
}

export function fmtStrike(v: number): string {
  if (v >= 10_000) {
    const k = v / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}K`;
  }
  return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export function fmtPct(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

export function fmtIv(v: number | null): string {
  return v === null ? "—" : `${(v * 100).toFixed(0)}%`;
}

export function fmtCountdown(ts: number, now: number): string {
  const s = Math.max(0, ts - now);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m ${String(sec).padStart(2, "0")}s`;
  return `${m}m ${String(sec).padStart(2, "0")}s`;
}

export function fmtExpiryDate(ts: number): string {
  return new Date(ts * 1000)
    .toLocaleDateString("en-GB", { day: "2-digit", month: "short" })
    .toUpperCase()
    .replace(" ", "");
}

export function shortAddr(a: string): string {
  return a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function riskColor(score: number): string {
  if (score >= 67) return "var(--crit)";
  if (score >= 40) return "var(--warn)";
  return "var(--calm)";
}

export function riskLabel(score: number): string {
  if (score >= 80) return "CRITICAL";
  if (score >= 67) return "HIGH";
  if (score >= 40) return "ELEVATED";
  if (score >= 20) return "MODERATE";
  return "LOW";
}
