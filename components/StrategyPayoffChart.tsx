"use client";

// The resolved strategy's real payoff at expiry — actual strikes, actual net
// premium, actual breakevens (lib/strategyPayoff.ts). The line itself carries
// the read: red where the position is underwater at that spot, green where
// it's in profit, split exactly at the true breakeven. An arrowhead marks a
// profit tail that keeps climbing past the visible range; a capped spread's
// flat plateau gets none. (The strategy list's small per-row mark is a
// different, authored glyph — see StrategyGlyph.tsx — since before a
// strategy is selected there are no real strikes/premium to plot.)

import { terminalPayoff, type ResolvedLeg } from "@/lib/strategyPayoff";

type Pt = { x: number; y: number };
type Segment = { color: "calm" | "crit"; pts: Pt[] };

const ARM = 7;

/** Open chevron arrowhead — same mark the list glyphs use (StrategyGlyph.tsx). */
function chevron(from: [number, number], tip: [number, number]): string {
  const a = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  const a1 = a + (Math.PI * 3) / 4;
  const a2 = a - (Math.PI * 3) / 4;
  return (
    `M${(tip[0] + ARM * Math.cos(a1)).toFixed(2)},${(tip[1] + ARM * Math.sin(a1)).toFixed(2)} ` +
    `L${tip[0].toFixed(2)},${tip[1].toFixed(2)} ` +
    `L${(tip[0] + ARM * Math.cos(a2)).toFixed(2)},${(tip[1] + ARM * Math.sin(a2)).toFixed(2)}`
  );
}

// Split the sampled curve into red/green runs, inserting the exact
// zero-crossing point between samples so the color change lands precisely
// on the breakeven rather than snapping to the nearest sample.
function colorSegments(xs: number[], ys: number[]): Segment[] {
  const segments: Segment[] = [];
  let color: Segment["color"] = ys[0] >= 0 ? "calm" : "crit";
  let current: Pt[] = [{ x: xs[0], y: ys[0] }];
  for (let i = 1; i < xs.length; i++) {
    const y0 = ys[i - 1];
    const y1 = ys[i];
    if ((y0 >= 0) !== (y1 >= 0)) {
      const t = y0 / (y0 - y1);
      const xCross = xs[i - 1] + t * (xs[i] - xs[i - 1]);
      current.push({ x: xCross, y: 0 });
      segments.push({ color, pts: current });
      color = y1 >= 0 ? "calm" : "crit";
      current = [{ x: xCross, y: 0 }];
    }
    current.push({ x: xs[i], y: y1 });
  }
  segments.push({ color, pts: current });
  return segments;
}

export function StrategyPayoffChart({
  legs,
  netPremiumPerUnit,
  spot,
  breakevens = [],
}: {
  legs: ResolvedLeg[];
  netPremiumPerUnit: number;
  spot: number;
  breakevens?: number[];
}) {
  const width = 320;
  const height = 128;
  const pad = 12;
  const samples = 60;

  const lo = spot * 0.6;
  const hi = spot * 1.4;
  const xs = Array.from({ length: samples + 1 }, (_, i) => lo + ((hi - lo) * i) / samples);
  const ys = xs.map((S) => terminalPayoff(S, legs, netPremiumPerUnit));

  const yMax = Math.max(...ys, 0);
  const yMin = Math.min(...ys, 0);
  const yRange = Math.max(yMax - yMin, 1e-6);

  const toX = (S: number) => pad + ((S - lo) / (hi - lo)) * (width - pad * 2);
  const toY = (y: number) => pad + (1 - (y - yMin) / yRange) * (height - pad * 2);

  const segments = colorSegments(xs, ys);
  const strokeWidth = 2;

  // A tail that keeps running past the frame gets an arrowhead; a capped
  // spread's flat plateau doesn't — there's nothing further to point at.
  const first = segments[0];
  const last = segments[segments.length - 1];
  const px = (p: Pt): [number, number] => [toX(p.x), toY(p.y)];
  const arrowStart = first.pts[0].y !== first.pts[1]?.y;
  const arrowEnd = last.pts.at(-1)!.y !== last.pts.at(-2)?.y;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-32" role="img" aria-label="Strategy payoff at expiry">
      <g fill="none" strokeLinecap="round">
        <line x1={pad} y1={toY(yMax)} x2={width - pad} y2={toY(yMax)} stroke="var(--calm)" strokeWidth={1.2} strokeDasharray="4 4" opacity={0.5} />
        <line x1={pad} y1={toY(yMin)} x2={width - pad} y2={toY(yMin)} stroke="var(--crit)" strokeWidth={1.2} strokeDasharray="4 4" opacity={0.5} />
        <line x1={toX(spot)} y1={pad} x2={toX(spot)} y2={height - pad} stroke="var(--edge-2)" strokeDasharray="3 3" strokeWidth={1.2} opacity={0.9} />

        {segments.map((seg, i) => (
          <g key={i} stroke={`var(--${seg.color})`} strokeWidth={strokeWidth} strokeLinejoin="round">
            <path d={seg.pts.map((p, j) => `${j === 0 ? "M" : "L"}${toX(p.x).toFixed(1)},${toY(p.y).toFixed(1)}`).join(" ")} />
            {i === 0 && arrowStart && <path d={chevron(px(first.pts[1]), px(first.pts[0]))} />}
            {i === segments.length - 1 && arrowEnd && (
              <path d={chevron(px(last.pts.at(-2)!), px(last.pts.at(-1)!))} />
            )}
          </g>
        ))}

        {breakevens.map((be) => (
          <circle key={be} cx={toX(be)} cy={toY(0)} r={2.5} fill="var(--warn)" stroke="none" />
        ))}
      </g>
    </svg>
  );
}
