"use client";

// The strategy list's leading mark: a stylized payoff glyph per strategy.
//
// Geometry is transcribed from Hegic's own strategy icons (hegic.co/app,
// "Trade One-Click Option Strategies") on a shared 72×72 grid, so every
// glyph reads the same way:
//   • solid line — red on the leg that sits at a loss, green on the leg in
//     profit, meeting at the strategy's turning point;
//   • an open chevron arrowhead on each open-ended leg, pointing the way the
//     payoff keeps running;
//   • dashed reference rails — green on the top level, red on the bottom
//     level, neutral on any plateau in between.
// Colors come from the theme tokens (this is a light UI), not Hegic's
// dark-theme hexes — see AGENTS.md on keeping color in CSS variables.

import { useId } from "react";

type Tone = "calm" | "crit";
type Poly = { c: Tone; pts: [number, number][]; arrow?: boolean };
type Rail = { c: Tone | "edge"; y: number; x0: number; x1: number };
type Glyph = { lines: Poly[]; rails: Rail[] };

const X0 = 8;
const X1 = 64;

const GLYPHS: Record<string, Glyph> = {
  // --- bullish ---
  call: {
    lines: [
      { c: "crit", pts: [[9.5, 63.5], [37.5, 35.5]] },
      { c: "calm", pts: [[37.5, 35.5], [63.5, 9.5]], arrow: true },
    ],
    rails: [
      { c: "calm", y: 35.5, x0: X0, x1: X1 },
      { c: "edge", y: 63.5, x0: 9, x1: X1 },
    ],
  },
  strap: {
    lines: [
      { c: "crit", pts: [[28.5, 26], [8, 36], [28.5, 54]] },
      { c: "calm", pts: [[28.5, 26], [63, 11]], arrow: true },
      { c: "calm", pts: [[28.5, 54], [38.5, 63.5]], arrow: true },
    ],
    rails: [
      { c: "calm", y: 26, x0: X0, x1: X1 },
      { c: "edge", y: 36, x0: X0, x1: X1 },
      { c: "crit", y: 54, x0: X0, x1: X1 },
    ],
  },
  "bull-call-spread": {
    lines: [
      { c: "crit", pts: [[10.5, 63], [30.2, 35]] },
      { c: "calm", pts: [[30.2, 35], [48, 10], [63.5, 10]], arrow: true },
    ],
    rails: [
      { c: "calm", y: 35, x0: X0, x1: X1 },
      { c: "edge", y: 63, x0: 9, x1: X1 },
    ],
  },
  "bull-put-spread": {
    lines: [
      { c: "calm", pts: [[9.5, 8.5], [36.3, 36]] },
      { c: "crit", pts: [[36.3, 36], [48, 62], [63.5, 62]], arrow: true },
    ],
    rails: [
      { c: "edge", y: 8.5, x0: 9, x1: X1 },
      { c: "crit", y: 36, x0: X0, x1: X1 },
    ],
  },

  // --- bearish ---
  put: {
    lines: [
      { c: "crit", pts: [[9.5, 8.5], [37.5, 36.5]] },
      { c: "calm", pts: [[37.5, 36.5], [63.5, 62.5]], arrow: true },
    ],
    rails: [
      { c: "edge", y: 8.5, x0: 9, x1: X1 },
      { c: "crit", y: 36.5, x0: X0, x1: X1 },
    ],
  },
  strip: {
    lines: [
      { c: "crit", pts: [[28.5, 17.5], [8, 36], [28.5, 45.5]] },
      { c: "calm", pts: [[28.5, 17.5], [38.5, 9]], arrow: true },
      { c: "calm", pts: [[28.5, 45.5], [63, 60.5]], arrow: true },
    ],
    rails: [
      { c: "calm", y: 18, x0: X0, x1: X1 },
      { c: "edge", y: 36, x0: X0, x1: X1 },
      { c: "crit", y: 45.5, x0: X0, x1: X1 },
    ],
  },
  "bear-put-spread": {
    lines: [
      { c: "crit", pts: [[10.4, 9], [30.2, 37]] },
      { c: "calm", pts: [[30.2, 37], [48, 62], [63.5, 62]], arrow: true },
    ],
    rails: [
      { c: "edge", y: 8.5, x0: 9, x1: X1 },
      { c: "crit", y: 36.5, x0: X0, x1: X1 },
    ],
  },
  "bear-call-spread": {
    lines: [
      { c: "calm", pts: [[9.5, 63.5], [36.3, 36]] },
      { c: "crit", pts: [[36.3, 36], [48, 10], [63.5, 10]], arrow: true },
    ],
    rails: [
      { c: "calm", y: 35.5, x0: X0, x1: X1 },
      { c: "edge", y: 63.5, x0: 9, x1: X1 },
    ],
  },

  // --- high volatility ---
  straddle: {
    lines: [
      { c: "crit", pts: [[38.2, 22], [8.6, 36], [38.2, 50]] },
      { c: "calm", pts: [[38.2, 22], [63, 11]], arrow: true },
      { c: "calm", pts: [[38.2, 50], [63, 61]], arrow: true },
    ],
    rails: [
      { c: "calm", y: 22, x0: X0, x1: X1 },
      { c: "edge", y: 36, x0: X0, x1: X1 },
      { c: "crit", y: 50, x0: X0, x1: X1 },
    ],
  },
  strangle: {
    lines: [
      { c: "crit", pts: [[36, 20], [8, 30], [8, 42], [36, 52]] },
      { c: "calm", pts: [[36, 20], [63, 11]], arrow: true },
      { c: "calm", pts: [[36, 52], [63, 61]], arrow: true },
    ],
    rails: [
      { c: "calm", y: 20, x0: X0, x1: X1 },
      { c: "edge", y: 30, x0: X0, x1: X1 },
      { c: "edge", y: 42, x0: X0, x1: X1 },
      { c: "crit", y: 52, x0: X0, x1: X1 },
    ],
  },

  // --- low volatility ---
  "long-butterfly": {
    lines: [
      { c: "calm", pts: [[30.2, 20], [8, 36], [30.2, 52]] },
      { c: "crit", pts: [[30.2, 20], [44, 10], [63.5, 10]], arrow: true },
      { c: "crit", pts: [[30.2, 52], [44, 62], [63.5, 62]], arrow: true },
    ],
    rails: [
      { c: "calm", y: 20, x0: X0, x1: X1 },
      { c: "edge", y: 36, x0: X0, x1: X1 },
      { c: "crit", y: 52, x0: X0, x1: X1 },
    ],
  },
  "long-condor": {
    lines: [
      { c: "calm", pts: [[36, 16], [8, 30], [8, 42], [36, 56]] },
      { c: "crit", pts: [[36, 16], [48, 10], [63.5, 10]], arrow: true },
      { c: "crit", pts: [[36, 56], [48, 62], [63.5, 62]], arrow: true },
    ],
    rails: [
      { c: "calm", y: 16, x0: X0, x1: X1 },
      { c: "edge", y: 30, x0: X0, x1: X1 },
      { c: "edge", y: 42, x0: X0, x1: X1 },
      { c: "crit", y: 56, x0: X0, x1: X1 },
    ],
  },
};

const ARM = 5;

/** Open chevron at the polyline's last point, aligned to its final direction. */
function chevron(pts: [number, number][]): string {
  const [px, py] = pts[pts.length - 2];
  const [tx, ty] = pts[pts.length - 1];
  const a = Math.atan2(ty - py, tx - px);
  const a1 = a + (Math.PI * 3) / 4;
  const a2 = a - (Math.PI * 3) / 4;
  return (
    `M${(tx + ARM * Math.cos(a1)).toFixed(2)},${(ty + ARM * Math.sin(a1)).toFixed(2)} ` +
    `L${tx},${ty} ` +
    `L${(tx + ARM * Math.cos(a2)).toFixed(2)},${(ty + ARM * Math.sin(a2)).toFixed(2)}`
  );
}

const RAIL_COLOR: Record<Rail["c"], string> = {
  edge: "var(--edge-2)",
  calm: "var(--calm)",
  crit: "var(--crit)",
};

export function StrategyGlyph({ strategyId }: { strategyId: string }) {
  const id = useId();
  const glyph = GLYPHS[strategyId];
  if (!glyph) return null;

  return (
    <svg width={44} height={44} viewBox="0 0 72 72" className="shrink-0" aria-hidden="true">
      <g strokeLinecap="round" fill="none">
        {glyph.rails.map((r) => (
          <line
            key={`${id}-r${r.y}`}
            x1={r.x0}
            y1={r.y}
            x2={r.x1}
            y2={r.y}
            stroke={RAIL_COLOR[r.c]}
            strokeWidth={1.1}
            strokeDasharray="2.7 2.7"
            opacity={r.c === "edge" ? 0.9 : 0.5}
          />
        ))}
        {glyph.lines.map((l, i) => (
          <g key={`${id}-l${i}`} stroke={`var(--${l.c})`} strokeWidth={1.8} strokeLinejoin="round">
            <path d={l.pts.map((p, j) => `${j === 0 ? "M" : "L"}${p[0]},${p[1]}`).join(" ")} />
            {l.arrow && <path d={chevron(l.pts)} />}
          </g>
        ))}
      </g>
    </svg>
  );
}
