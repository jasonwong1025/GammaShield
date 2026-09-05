"use client";

// Market impact of a fill (lib/marketImpact.ts): the spot flow a dealer has
// to trade to stay hedged, and what that flow does to price.
//
// The headline is deliberately the THRESHOLD, not a price move. On this book
// a real fill is worth a few thousand dollars of hedge flow against a spot
// market doing over a billion a day, so a "% move" readout would be a column
// of zeros dressed up as precision. Saying how large a trade would have to be
// before it registered is the honest version of the same question — and the
// size box makes that explorable instead of theoretical.
//
// Size is local state: the math is pure and linear in contracts, so it re-runs
// in the browser with no round trip.

import { useMemo, useState } from "react";
import {
  computeMarketImpact,
  MOVE_FLOOR_PCT,
  THRESHOLD_SHARE,
  type ImpactBasis,
} from "@/lib/marketImpact";
import { fmtContracts, fmtPct, fmtStrike, fmtUsd } from "@/lib/format";
import { Disclosure } from "./Disclosure";

function pctOfAdv(share: number | null): string {
  if (share === null) return "—";
  const pct = share * 100;
  if (pct < 0.001) return "<0.001% of daily volume";
  return `${pct.toFixed(pct < 0.1 ? 3 : 2)}% of daily volume`;
}

/** One flow line: what gets traded and how big it is. The methodology behind
 *  the number (why it counts as a % of volume, what size would matter) is
 *  read separately, from `flowDetail` below, inside the panel's one shared
 *  disclosure — this row is the reading, not the working. */
function FlowRow({
  label,
  usd,
  directed,
  magnitudeSuffix = "",
}: {
  label: string;
  usd: number;
  directed: boolean;
  magnitudeSuffix?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className="num text-fg">
        {directed
          ? `dealers ${usd >= 0 ? "buy" : "sell"} ${fmtUsd(Math.abs(usd))}`
          : `${fmtUsd(Math.abs(usd))}${magnitudeSuffix}`}
      </span>
    </div>
  );
}

/** `directed` separates the two flows the same way FlowRow's number does: the
 *  immediate hedge is one real order with a known side ("dealers buy $X"),
 *  gamma is not — a negative sign there means SHORT gamma, and a short-gamma
 *  dealer buys a rally and sells a selloff, so this text never states a
 *  direction the number itself doesn't carry. */
function flowDetail({
  hint,
  share,
  threshold,
  thresholdHint,
}: {
  hint: string;
  share: number | null;
  threshold: number | null;
  thresholdHint: string;
}): string {
  const parts = [hint, pctOfAdv(share)];
  if (threshold !== null) {
    parts.push(`${fmtContracts(Number(threshold.toPrecision(3)))} contracts ${thresholdHint}`);
  }
  return parts.join(" · ");
}

export function MarketImpactPanel({
  basis,
  defaultContracts,
  asset,
  children,
}: {
  basis: ImpactBasis;
  /** Size the card opens at — the configured trade, or the order's full size. */
  defaultContracts: number;
  asset: string;
  /** Optional AI annotation, rendered below a divider inside the same card so
   *  it reads as one risk readout rather than a second competing score. */
  children?: React.ReactNode;
}) {
  const [sizeStr, setSizeStr] = useState(() =>
    defaultContracts > 0 ? String(Number(defaultContracts.toPrecision(4))) : "1",
  );
  const size = Number(sizeStr);
  const contracts = Number.isFinite(size) && size > 0 ? size : 0;
  const impact = useMemo(() => computeMarketImpact(basis, contracts), [basis, contracts]);

  const thresholdPct = THRESHOLD_SHARE * 100;
  const move = impact.move;
  const negligible = move !== null && Math.abs(move.totalPct) < MOVE_FLOOR_PCT;
  const flipMoved = impact.flipBefore !== impact.flipAfter;

  const flipDetail = `Book net GEX ${fmtUsd(impact.netGexBefore)} → ${fmtUsd(impact.netGexAfter)} per 1% move${
    impact.regimeAfter !== impact.regimeBefore
      ? ` — regime flips to ${impact.regimeAfter}.`
      : ` (${impact.regimeAfter} regime).`
  } Gamma flip ${
    flipMoved
      ? `${impact.flipBefore === null ? "none" : `$${fmtStrike(impact.flipBefore)}`} → ${impact.flipAfter === null ? "none" : `$${fmtStrike(impact.flipAfter)}`}`
      : `unmoved at ${impact.flipBefore === null ? "—" : `$${fmtStrike(impact.flipBefore)}`}`
  }.`;

  const provenance = [
    impact.advUsd !== null
      ? `Against ${fmtUsd(impact.advUsd)} of measured 24h spot volume (${impact.advSources.join(" + ")}) — a floor, not global volume, so these are over-estimates.`
      : "Spot volume unavailable, so shares and thresholds are not scored.",
    impact.dailyVolPct !== null
      ? `Move estimate uses ${impact.dailyVolPct.toFixed(2)}% daily realized vol${impact.volSource ? ` (${impact.volSource})` : ""} and a square-root impact law at coefficient ${impact.coefficient.toFixed(1)}.`
      : null,
    impact.unavailable.length > 0 ? `Not scored: ${impact.unavailable.join("; ")}.` : null,
  ].filter((s): s is string => Boolean(s));

  return (
    <div className="rounded-md border border-edge p-3 text-[12px] flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted">Market impact</span>
        <label className="flex items-center gap-1.5 text-faint text-[11px]">
          size
          <input
            value={sizeStr}
            onChange={(e) => setSizeStr(e.target.value.replace(/[^0-9.]/g, ""))}
            inputMode="decimal"
            className="num w-20 rounded border border-edge bg-panel2 px-1.5 py-0.5 text-right text-fg text-[11px]"
            aria-label="What-if size in contracts"
          />
          <span>contracts</span>
        </label>
      </div>

      {contracts > 0 ? (
        <>
          <FlowRow label="Immediate hedge" usd={impact.hedge.usd} directed />
          <FlowRow
            label="Gamma feedback"
            usd={impact.gamma.usd}
            directed={false}
            magnitudeSuffix=" per 1% move"
          />

          {move && (
            <p className="text-fg leading-relaxed">
              Estimated {asset} price move:{" "}
              {negligible ? (
                <span>negligible (under {MOVE_FLOOR_PCT}%)</span>
              ) : (
                <span>
                  {fmtPct(move.initialPct, 3)} direct, {fmtPct(move.totalPct, 3)} after one round of
                  dealer rehedging (×{move.amplification.toFixed(2)})
                </span>
              )}
            </p>
          )}

          <Disclosure label="How this is estimated">
            <div className="flex flex-col gap-2 pt-1.5 mt-0.5 border-t border-edge/60">
              <p className="text-faint text-[11px] leading-snug">
                {flowDetail({
                  hint: `Immediate hedge: one-off spot order at the fill, on ${fmtUsd(impact.notionalUsd)} of notional`,
                  share: impact.hedge.shareOfAdv,
                  threshold: impact.hedge.contractsForThreshold,
                  thresholdHint: `would reach ${thresholdPct}%`,
                })}
              </p>
              <p className="text-faint text-[11px] leading-snug">
                {flowDetail({
                  hint: `Gamma feedback: ${impact.gammaSign} gamma for as long as the position lives — dealers ${
                    impact.gammaSign === "negative"
                      ? "buy rallies and sell selloffs, chasing the move"
                      : "sell rallies and buy selloffs, leaning against the move"
                  }`,
                  share: impact.gamma.shareOfAdv,
                  threshold: impact.gamma.contractsForThreshold,
                  thresholdHint: `would reach ${thresholdPct}%`,
                })}
              </p>
              <p className="text-faint text-[11px] leading-relaxed">{flipDetail}</p>
              {provenance.map((p) => (
                <p key={p} className="text-faint text-[11px] leading-snug">
                  {p}
                </p>
              ))}
            </div>
          </Disclosure>
        </>
      ) : (
        <p className="text-faint">Enter a size to estimate the hedging flow it creates.</p>
      )}

      {children && (
        <>
          <div className="border-t border-edge/60 my-0.5" />
          {children}
        </>
      )}
    </div>
  );
}
