"use client";

import { useState } from "react";
import type { AssetSnapshot } from "@/lib/engine";
import { fmtSignedUsd, fmtStrike, riskColor, riskLabel } from "@/lib/format";

type FactorMeta = {
  key: keyof AssetSnapshot["factors"];
  label: string;
  simpleSubtitle: string;
  tooltip: string;
};

const FACTOR_ROWS: FactorMeta[] = [
  {
    key: "gamma",
    label: "Dealer Positioning",
    simpleSubtitle: "Market-maker reaction",
    tooltip: "When dealers are net short gamma, their automated delta-hedging chases price drops, creating cascading flash selloffs.",
  },
  {
    key: "liquidity",
    label: "Book Depth",
    simpleSubtitle: "Liquidity thickness",
    tooltip: "Thinner books move further per dollar traded. Higher scores mean the market is more vulnerable to large orders.",
  },
  {
    key: "concentration",
    label: "Strike Crowding",
    simpleSubtitle: "Cluster risk in top 3 strikes",
    tooltip: "Percentage of open interest locked in just 3 price levels. High concentration creates sudden liquidity vacuums.",
  },
  {
    key: "iv",
    label: "Implied Volatility",
    simpleSubtitle: "Options market turbulence",
    tooltip: "Elevated implied vol indicates traders expect turbulence, making hedging feedback more erratic.",
  },
  {
    key: "expiry",
    label: "Expiry Pressure",
    simpleSubtitle: "Near-dated options urgency",
    tooltip: "Options expiring this week exert strong gravitational pin or unclench pressure as expiration approaches.",
  },
];

export function ScorePanel({ snap }: { snap: AssetSnapshot }) {
  const [activeTooltip, setActiveTooltip] = useState<string | null>(null);
  const color = riskColor(snap.score);

  // User-facing actionable guidance
  const actionSummary =
    snap.score < 35
      ? {
          status: "Market is Stable",
          advice: "Dealers are absorbing price moves. Safe to execute trades normally without severe slippage feedback.",
          badgeBg: "bg-emerald-50 text-emerald-700 border-emerald-200",
        }
      : snap.score <= 70
      ? {
          status: "Moderate Friction",
          advice: "Price is near dealer transition levels. Use limit orders or split large market orders to minimize slippage.",
          badgeBg: "bg-amber-50 text-amber-700 border-amber-200",
        }
      : {
          status: "High Fragility Alert",
          advice: "Dealers are in amplifier mode. Consider buying a protective Put option or hedging downside before trading.",
          badgeBg: "bg-rose-50 text-rose-700 border-rose-200",
        };

  return (
    <section className="bg-white rounded-2xl p-6 shadow-xs border border-slate-100/80 flex flex-col gap-5" aria-label="Market Fragility Risk Score">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[15px] font-semibold text-slate-900 tracking-tight">Market Fragility Score</h2>
          <p className="text-[12px] text-slate-500">Real-time dealer amplification risk</p>
        </div>
        <span
          className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border ${actionSummary.badgeBg}`}
        >
          {riskLabel(snap.score)}
        </span>
      </div>

      {/* Ring Gauge + Actionable Advice */}
      <div className="flex items-center gap-5 p-4 rounded-xl bg-slate-50/70 border border-slate-100">
        <Ring score={snap.score} color={color} />
        <div className="flex flex-col gap-1">
          <span className="text-[13px] font-bold text-slate-800">{actionSummary.status}</span>
          <p className="text-[12px] leading-relaxed text-slate-600">{actionSummary.advice}</p>
        </div>
      </div>

      {/* Factor Breakdown with Plain English Tooltips */}
      <div className="flex flex-col gap-3.5">
        <div className="flex items-center justify-between text-[11px] font-medium text-slate-400 uppercase tracking-wider">
          <span>Risk Factor Breakdown</span>
          <span>Weight</span>
        </div>

        {FACTOR_ROWS.map(({ key, label, simpleSubtitle, tooltip }) => {
          const v = snap.factors[key];
          const isTooltipActive = activeTooltip === key;

          return (
            <div key={key} className="flex flex-col gap-1 relative">
              <div className="flex items-baseline justify-between text-[12px]">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium text-slate-800">{label}</span>
                  <button
                    type="button"
                    onClick={() => setActiveTooltip(isTooltipActive ? null : key)}
                    onMouseEnter={() => setActiveTooltip(key)}
                    onMouseLeave={() => setActiveTooltip(null)}
                    className="text-slate-400 hover:text-slate-600 text-[12px] transition focus:outline-none"
                    aria-label={`Info about ${label}`}
                  >
                    ℹ️
                  </button>
                  <span className="text-[11px] text-slate-400 hidden sm:inline">· {simpleSubtitle}</span>
                </div>
                <span className="num font-semibold text-slate-700">{v}%</span>
              </div>

              {/* Progress bar */}
              <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                <div
                  className="h-full rounded-full transition-[width] duration-700"
                  style={{ width: `${v}%`, background: riskColor(v) }}
                />
              </div>

              {/* Interactive Tooltip Card */}
              {isTooltipActive && (
                <div className="absolute z-20 top-7 left-0 right-0 p-3 rounded-lg bg-slate-900 text-white text-[11.5px] leading-relaxed shadow-lg animate-fade-in">
                  <span className="font-semibold text-slate-200 block mb-0.5">{label}</span>
                  {tooltip}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Net Dealer GEX & Flip Level */}
      <div className="pt-4 border-t border-slate-100 grid grid-cols-2 gap-4 text-[12px]">
        <div className="p-3 rounded-xl bg-slate-50/60 border border-slate-100 flex flex-col gap-0.5">
          <span className="text-slate-400 text-[11px] font-medium uppercase">Net Dealer Flow</span>
          <div
            className="num font-bold text-[14px]"
            style={{ color: snap.netGexUsd < 0 ? "var(--crit)" : "var(--calm)" }}
          >
            {fmtSignedUsd(snap.netGexUsd)}
          </div>
          <span className="text-slate-400 text-[10.5px]">Expected move per 1% shock</span>
        </div>

        <div className="p-3 rounded-xl bg-slate-50/60 border border-slate-100 flex flex-col gap-0.5">
          <span className="text-slate-400 text-[11px] font-medium uppercase">Gamma Flip Level</span>
          <div className="num font-bold text-[14px] text-slate-800">
            {snap.flipStrike ? `$${fmtStrike(snap.flipStrike)}` : "None on book"}
          </div>
          <span className="text-slate-400 text-[10.5px]">Regime transition price</span>
        </div>
      </div>
    </section>
  );
}

function Ring({ score, color }: { score: number; color: string }) {
  const r = 38;
  const c = 2 * Math.PI * r;
  const filled = (score / 100) * c;
  return (
    <div className="relative shrink-0" role="img" aria-label={`Risk score ${score} of 100`}>
      <svg width="96" height="96" viewBox="0 0 96 96">
        <circle cx="48" cy="48" r={r} fill="none" stroke="#f1f5f9" strokeWidth="8" />
        <circle
          cx="48"
          cy="48"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${c - filled}`}
          transform="rotate(-90 48 48)"
          style={{ transition: "stroke-dasharray 0.7s ease" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="num text-[26px] font-bold leading-none" style={{ color }}>
          {score}
        </span>
        <span className="text-[9px] text-slate-400 font-medium mt-0.5 uppercase">of 100</span>
      </div>
    </div>
  );
}
