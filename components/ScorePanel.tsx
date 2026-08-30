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
          colorClass: "text-calm",
        }
      : snap.score <= 70
      ? {
          status: "Moderate Friction",
          advice: "Price is near dealer transition levels. Use limit orders or split large market orders to minimize slippage.",
          colorClass: "text-warn",
        }
      : {
          status: "High Fragility Alert",
          advice: "Dealers are in amplifier mode. Consider buying a protective Put option or hedging downside before trading.",
          colorClass: "text-crit",
        };

  return (
    <section className="card p-5 flex flex-col gap-4" aria-label="Market Fragility Risk Score">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[14px] font-semibold text-fg tracking-tight">Market Fragility Score</h2>
          <p className="text-[11.5px] text-muted">Real-time dealer amplification risk</p>
        </div>
        <span
          className="text-[11px] font-semibold px-2.5 py-0.5 rounded-full"
          style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
        >
          {riskLabel(snap.score)}
        </span>
      </div>

      {/* Ring Gauge + Actionable Advice */}
      <div className="flex items-center gap-4 p-3.5 rounded-xl bg-panel2 border border-edge">
        <Ring score={snap.score} color={color} />
        <div className="flex flex-col gap-0.5">
          <span className={`text-[12.5px] font-bold ${actionSummary.colorClass}`}>{actionSummary.status}</span>
          <p className="text-[11.5px] leading-relaxed text-muted">{actionSummary.advice}</p>
        </div>
      </div>

      {/* Factor Breakdown with Plain English Tooltips */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between text-[11px] font-medium text-faint uppercase tracking-wider">
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
                  <span className="font-medium text-fg">{label}</span>
                  <button
                    type="button"
                    onClick={() => setActiveTooltip(isTooltipActive ? null : key)}
                    onMouseEnter={() => setActiveTooltip(key)}
                    onMouseLeave={() => setActiveTooltip(null)}
                    className="text-faint hover:text-fg text-[11px] transition focus:outline-none"
                    aria-label={`Info about ${label}`}
                  >
                    ℹ️
                  </button>
                  <span className="text-[11px] text-faint hidden sm:inline">· {simpleSubtitle}</span>
                </div>
                <span className="num font-semibold text-fg">{v}%</span>
              </div>

              {/* Progress bar */}
              <div className="h-1.5 rounded-full bg-panel3 overflow-hidden">
                <div
                  className="h-full rounded-full transition-[width] duration-700"
                  style={{ width: `${v}%`, background: riskColor(v) }}
                />
              </div>

              {/* Interactive Tooltip Card */}
              {isTooltipActive && (
                <div className="absolute z-20 top-7 left-0 right-0 p-3 rounded-lg bg-panel3 text-fg text-[11.5px] leading-relaxed border border-edge shadow-lg animate-fade-in">
                  <span className="font-semibold text-fg block mb-0.5">{label}</span>
                  {tooltip}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Net Dealer GEX & Flip Level */}
      <div className="pt-3 border-t border-edge grid grid-cols-2 gap-3 text-[12px]">
        <div className="p-2.5 rounded-lg bg-panel2 border border-edge flex flex-col gap-0.5">
          <span className="text-faint text-[10.5px] font-medium uppercase">Net Dealer Flow</span>
          <div
            className="num font-bold text-[13px]"
            style={{ color: snap.netGexUsd < 0 ? "var(--crit)" : "var(--calm)" }}
          >
            {fmtSignedUsd(snap.netGexUsd)}
          </div>
          <span className="text-faint text-[10px]">Per 1% spot shock</span>
        </div>

        <div className="p-2.5 rounded-lg bg-panel2 border border-edge flex flex-col gap-0.5">
          <span className="text-faint text-[10.5px] font-medium uppercase">Gamma Flip Level</span>
          <div className="num font-bold text-[13px] text-fg">
            {snap.flipStrike ? `$${fmtStrike(snap.flipStrike)}` : "None on book"}
          </div>
          <span className="text-faint text-[10px]">Transition price</span>
        </div>
      </div>
    </section>
  );
}

function Ring({ score, color }: { score: number; color: string }) {
  const r = 36;
  const c = 2 * Math.PI * r;
  const filled = (score / 100) * c;
  return (
    <div className="relative shrink-0" role="img" aria-label={`Risk score ${score} of 100`}>
      <svg width="88" height="88" viewBox="0 0 88 88">
        <circle cx="44" cy="44" r={r} fill="none" stroke="var(--panel-3)" strokeWidth="7" />
        <circle
          cx="44"
          cy="44"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${c - filled}`}
          transform="rotate(-90 44 44)"
          style={{ transition: "stroke-dasharray 0.7s ease" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="num text-[22px] font-bold leading-none" style={{ color }}>
          {score}
        </span>
        <span className="text-[9px] text-faint font-medium mt-0.5 uppercase">of 100</span>
      </div>
    </div>
  );
}
