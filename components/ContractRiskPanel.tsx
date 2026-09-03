"use client";

// Per-contract risk breakdown (lib/contractRisk.ts). Every number shown here
// is either measured from the live book or explicitly named as modelled, and
// anything the venue cannot supply is listed as dropped rather than silently
// filled in — the same honesty contract the rest of the dashboard keeps.

import type { ContractRisk, RiskComponent, RiskLevel } from "@/lib/contractRisk";
import { riskColor } from "@/lib/format";

const LEVEL_LABEL: Record<RiskLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  extreme: "Extreme",
};

/** Compact score chip — safe to drop into a dense table cell. */
export function RiskScoreChip({ risk }: { risk: ContractRisk | null }) {
  if (!risk) return <span className="text-faint">—</span>;
  const color = riskColor(risk.score);
  return (
    <span
      className="inline-block num text-[11px] font-semibold px-1.5 py-0.5 rounded"
      style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
      title={`${LEVEL_LABEL[risk.level]} — ${risk.direction} exposure`}
    >
      {risk.score.toFixed(0)}
    </span>
  );
}

function ComponentRow({ component }: { component: RiskComponent }) {
  const color = riskColor(component.score);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2">
        <span className="text-fg w-[112px] shrink-0">{component.label}</span>
        <span className="text-faint num text-[10px] w-8 shrink-0">
          {Math.round(component.weight * 100)}%
        </span>
        <div className="grow h-1.5 rounded-full bg-panel3 overflow-hidden">
          <div
            className="h-full rounded-full"
            style={{ width: `${component.score}%`, background: color }}
          />
        </div>
        <span className="num w-8 text-right font-semibold" style={{ color }}>
          {component.score.toFixed(0)}
        </span>
      </div>
      <div className="pl-[120px] flex flex-col gap-0.5">
        {component.parts.map((part) => (
          <p key={part.key} className="text-faint text-[11px] leading-snug">
            <span className="text-muted">{part.label}</span> {part.score.toFixed(0)}
            {part.detail ? ` — ${part.detail}` : ""}
          </p>
        ))}
        {component.dropped.map((drop) => (
          <p key={drop.key} className="text-faint text-[11px] leading-snug italic">
            {drop.label} not scored — {drop.reason}
          </p>
        ))}
        {component.mirrored && (
          <p className="text-faint text-[11px] leading-snug">
            Inverted for short exposure — this works in your favour.
          </p>
        )}
      </div>
    </div>
  );
}

export function ContractRiskPanel({
  risk,
  volBaseline,
}: {
  risk: ContractRisk;
  /** Realized-vol reference the IV component used, for honest labelling. */
  volBaseline?: { vol: number; windowDays: number; lookbackDays: number; source: string } | null;
}) {
  const color = riskColor(risk.score);
  return (
    <div className="rounded-lg border border-edge bg-panel p-2.5 flex flex-col gap-2.5">
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center justify-between gap-3">
          <span className="panel-title text-[13px]">Contract risk</span>
          <span className="num font-semibold" style={{ color }}>
            {risk.score.toFixed(0)} <span className="text-[11px]">{LEVEL_LABEL[risk.level]}</span>
          </span>
        </div>
        <p className="text-[11px] text-faint">
          {risk.direction} · {risk.daysToExpiry.toFixed(1)}d to expiry · ×{risk.expiryMultiplier} near-expiry weight
        </p>
      </div>

      {risk.lossProbability !== null && (
        <p className="text-faint text-[11px] leading-relaxed">
          {(risk.lossProbability * 100).toFixed(0)}% chance of finishing past break-even against
          you, priced off this contract&apos;s own implied vol.
        </p>
      )}

      <div className="flex flex-col gap-2">
        {risk.components.map((c) => (
          <ComponentRow key={c.key} component={c} />
        ))}
      </div>

      {risk.dropped.length > 0 && (
        <p className="text-faint text-[11px] leading-relaxed border-t border-edge/60 pt-2">
          Not scored: {risk.dropped.map((d) => `${d.label} (${d.reason})`).join(", ")}. Remaining
          weights renormalise — nothing is filled in with a default.
        </p>
      )}

      {volBaseline && (
        <p className="text-faint text-[11px] leading-relaxed">
          Vol reference: {(volBaseline.vol * 100).toFixed(0)}% trailing {volBaseline.windowDays}d
          realized, ranked against {volBaseline.lookbackDays} days of history ({volBaseline.source}).
          This venue publishes no implied-vol history, so percentile is measured against realized
          vol and labelled as such.
        </p>
      )}
    </div>
  );
}
