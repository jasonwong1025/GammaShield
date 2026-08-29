"use client";

// Dealer gamma (1D: GEX per strike, collapsed across expiries) and open
// interest (2D: strike × expiry) are two lenses on the same live book —
// tabbed into one card instead of two stacked sections, matching the
// OptionBook/Expiries tab pattern already used elsewhere on the dashboard.

import { useState } from "react";
import type { AssetSnapshot } from "@/lib/engine";
import { fmtUsd } from "@/lib/format";
import { GexChartBody } from "./GexChart";
import { HeatmapBody } from "./Heatmap";

const TABS = [
  {
    key: "gamma",
    label: "Dealer gamma",
    subtitle: "Green strikes absorb price moves; red strikes amplify them.",
  },
  {
    key: "oi",
    label: "Open interest",
    subtitle: "Collateral on the live book by strike and expiry — brighter is more crowded.",
  },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export function RiskView({ snap }: { snap: AssetSnapshot }) {
  const [tab, setTab] = useState<TabKey>("gamma");
  const active = TABS.find((t) => t.key === tab)!;

  return (
    <section className="card p-5 pb-2" aria-label="Dealer gamma and open interest">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1 rounded-lg bg-panel2 p-0.5 self-start">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                aria-pressed={tab === t.key}
                className={`px-3 h-7 rounded-md text-[12px] font-medium transition ${
                  tab === t.key ? "bg-panel3 text-fg" : "text-muted hover:text-fg"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <p className="text-[12px] text-muted">{active.subtitle}</p>
        </div>
        <div className="text-[11px] text-muted shrink-0 pt-1">
          {tab === "gamma" ? (
            <div className="flex items-center gap-3">
              <span><span className="text-calm">●</span> dampening</span>
              <span><span className="text-crit">●</span> amplifying</span>
            </div>
          ) : (
            <span className="num">{fmtUsd(snap.depthUsd)} on book</span>
          )}
        </div>
      </div>

      {tab === "gamma" ? <GexChartBody snap={snap} /> : <HeatmapBody snap={snap} />}
    </section>
  );
}
