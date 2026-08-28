"use client";

import { simulateWhale, type AssetSnapshot } from "@/lib/engine";
import { fmtPct, fmtUsd } from "@/lib/format";
import type { Asset } from "@/lib/assets";

export type SimState = { sizeM: number; buy: boolean };

const QUICK = [10, 50, 100, 250, 500];
const MIN_M = 5;
const MAX_M = 500;

export function WhaleControls({
  asset,
  sim,
  onChange,
}: {
  asset: Asset;
  sim: SimState;
  onChange: (s: SimState) => void;
}) {
  const fill = ((sim.sizeM - MIN_M) / (MAX_M - MIN_M)) * 100;

  return (
    <section className="card p-5" aria-label="Whale impact simulator">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[14px] font-semibold">
            What if a whale trades {asset} right now?
          </h2>
          <p className="text-[12px] text-muted mt-0.5">
            Simulate a large market order and see how dealer hedging would react.
          </p>
        </div>
        <div className="flex rounded-lg border border-edge overflow-hidden shrink-0">
          {(["Buy", "Sell"] as const).map((side) => {
            const active = sim.buy === (side === "Buy");
            return (
              <button
                key={side}
                onClick={() => onChange({ ...sim, buy: side === "Buy" })}
                aria-pressed={active}
                className={`px-4 h-8 text-[12px] font-medium transition ${
                  active
                    ? side === "Buy"
                      ? "bg-calm/15 text-calm"
                      : "bg-crit/15 text-crit"
                    : "text-muted hover:text-fg"
                }`}
              >
                {side}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-5">
        <div className="flex items-baseline justify-between">
          <span className="text-[12px] text-muted">Order size</span>
          <span className="num text-[20px] font-semibold">${sim.sizeM}M</span>
        </div>
        <input
          type="range"
          min={MIN_M}
          max={MAX_M}
          step={5}
          value={sim.sizeM}
          onChange={(e) => onChange({ ...sim, sizeM: Number(e.target.value) })}
          className="sim-range mt-3"
          style={{ "--fill": `${fill}%` } as React.CSSProperties}
          aria-label="Whale order size in millions of dollars"
        />
        <div className="mt-3 flex gap-2">
          {QUICK.map((m) => (
            <button
              key={m}
              onClick={() => onChange({ ...sim, sizeM: m })}
              aria-pressed={sim.sizeM === m}
              className={`flex-1 h-8 rounded-lg text-[12px] num transition border ${
                sim.sizeM === m
                  ? "border-blue bg-bluesoft text-fg font-medium"
                  : "border-edge text-muted hover:text-fg hover:border-edge2"
              }`}
            >
              ${m}M
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

export function ImpactCard({
  snap,
  sim,
}: {
  snap: AssetSnapshot;
  sim: SimState;
}) {
  const r = simulateWhale(snap, sim.sizeM * 1_000_000, sim.buy);
  const amplifies = r.amplification > 1.001;

  return (
    <section className="card p-5" aria-label="Simulated impact">
      <h2 className="text-[14px] font-semibold">
        A{" "}
        <span className="text-blue num">${sim.sizeM}M</span>{" "}
        <span style={{ color: sim.buy ? "var(--calm)" : "var(--crit)" }}>
          {sim.buy ? "buy" : "sell"}
        </span>{" "}
        in {snap.asset} would…
      </h2>

      <div className="mt-4 flex flex-col gap-3 text-[13px]">
        <Row
          label="Move the market directly"
          value={fmtPct(r.initialMovePct)}
        />
        <Row
          label={`Trigger dealer hedging that ${r.sameDirection ? "chases the move" : "pushes back"}`}
          value={fmtUsd(Math.abs(r.hedgeFlowUsd))}
          tone={r.sameDirection ? "crit" : "calm"}
        />
        <Row
          label="Land at an estimated total move of"
          value={fmtPct(r.totalMovePct)}
          tone={amplifies ? "crit" : undefined}
        />
      </div>

      <div className="mt-4 pt-4 border-t border-edge flex items-center justify-between">
        <span className="text-[12px] text-muted">Amplification</span>
        <span
          className="num text-[24px] font-semibold"
          style={{ color: amplifies ? "var(--crit)" : "var(--calm)" }}
        >
          ×{r.amplification.toFixed(2)}
        </span>
      </div>
      <p className="mt-2 text-[11px] text-faint leading-4">
        First-order estimate from the live book — an analysis aid, not a prediction.
      </p>
    </section>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "calm" | "crit";
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted leading-5">{label}</span>
      <span
        className="num font-medium shrink-0"
        style={{ color: tone ? `var(--${tone})` : "var(--text)" }}
      >
        {value}
      </span>
    </div>
  );
}
