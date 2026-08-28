"use client";

import type { AssetSnapshot } from "@/lib/engine";
import { fmtSignedUsd, fmtStrike, riskColor, riskLabel } from "@/lib/format";

const FACTOR_ROWS: { key: keyof AssetSnapshot["factors"]; label: string; hint: string }[] = [
  { key: "gamma", label: "Dealer positioning", hint: "Net hedging direction and size" },
  { key: "liquidity", label: "Book depth", hint: "How far a dollar moves price" },
  { key: "concentration", label: "Strike crowding", hint: "Share of OI in the top 3 strikes" },
  { key: "iv", label: "Implied volatility", hint: "Hedging fragility regime" },
  { key: "expiry", label: "Expiry pressure", hint: "Weight of near-dated open interest" },
];

export function ScorePanel({ snap }: { snap: AssetSnapshot }) {
  const color = riskColor(snap.score);
  const verdict =
    snap.regime === "amplifying"
      ? "Dealers are net short gamma — their hedging would chase a shock and amplify it."
      : "Dealers are net long gamma — their hedging would push back against a shock.";

  return (
    <section className="card p-5" aria-label="Amplification risk score">
      <div className="flex items-center justify-between">
        <h2 className="text-[14px] font-semibold">Amplification risk</h2>
        <span
          className="text-[11px] font-semibold px-2 py-0.5 rounded-full"
          style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
        >
          {riskLabel(snap.score)}
        </span>
      </div>

      <div className="mt-4 flex items-center gap-5">
        <Ring score={snap.score} color={color} />
        <p className="text-[12.5px] leading-5 text-muted">{verdict}</p>
      </div>

      <div className="mt-5 flex flex-col gap-3">
        {FACTOR_ROWS.map(({ key, label, hint }) => {
          const v = snap.factors[key];
          return (
            <div key={key} title={hint}>
              <div className="flex items-baseline justify-between text-[12px]">
                <span className="text-muted">{label}</span>
                <span className="num text-fg font-medium">{v}</span>
              </div>
              <div className="mt-1.5 h-1.5 rounded-full bg-panel3 overflow-hidden">
                <div
                  className="h-full rounded-full transition-[width] duration-700"
                  style={{ width: `${v}%`, background: riskColor(v) }}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-5 pt-4 border-t border-edge grid grid-cols-2 gap-3 text-[12px]">
        <div>
          <div className="text-faint">Net dealer GEX</div>
          <div
            className="num font-medium mt-0.5"
            style={{ color: snap.netGexUsd < 0 ? "var(--crit)" : "var(--calm)" }}
          >
            {fmtSignedUsd(snap.netGexUsd)}
            <span className="text-faint font-normal"> per 1% move</span>
          </div>
        </div>
        <div>
          <div className="text-faint">Gamma flip level</div>
          <div className="num font-medium mt-0.5 text-fg">
            {snap.flipStrike ? `$${fmtStrike(snap.flipStrike)}` : "None on book"}
          </div>
        </div>
      </div>
    </section>
  );
}

function Ring({ score, color }: { score: number; color: string }) {
  const r = 40;
  const c = 2 * Math.PI * r;
  const filled = (score / 100) * c;
  return (
    <div className="relative shrink-0" role="img" aria-label={`Risk score ${score} of 100`}>
      <svg width="104" height="104" viewBox="0 0 104 104">
        <circle cx="52" cy="52" r={r} fill="none" stroke="var(--panel-3)" strokeWidth="9" />
        <circle
          cx="52"
          cy="52"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${c - filled}`}
          transform="rotate(-90 52 52)"
          style={{ transition: "stroke-dasharray 0.7s ease" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="num text-[30px] font-semibold leading-none" style={{ color }}>
          {score}
        </span>
        <span className="text-[10px] text-faint mt-0.5">of 100</span>
      </div>
    </div>
  );
}
