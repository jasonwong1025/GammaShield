"use client";

import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import type { AssetSnapshot } from "@/lib/engine";
import { fmtExpiryDate, fmtStrike, fmtUsd } from "@/lib/format";
import { EChart } from "./EChart";

const MAX_STRIKE_ROWS = 12;
const MAX_EXPIRY_COLS = 8;

/** Chart only, no card/header chrome — composed into RiskView alongside GexChart. */
export function HeatmapBody({ snap }: { snap: AssetSnapshot }) {
  const { option, empty } = useMemo(() => buildOption(snap), [snap]);

  return empty ? (
    <div className="h-[200px] flex items-center justify-center text-[12px] text-faint">
      No live open interest for this asset.
    </div>
  ) : (
    <EChart option={option} height={280} ariaLabel="Open interest by strike and expiry" />
  );
}

function buildOption(snap: AssetSnapshot): { option: EChartsOption; empty: boolean } {
  const byStrike = new Map<number, number>();
  const byExpiry = new Map<number, number>();
  for (const c of snap.heatmap) {
    byStrike.set(c.strike, (byStrike.get(c.strike) ?? 0) + c.notionalUsd);
    byExpiry.set(c.expiryTs, (byExpiry.get(c.expiryTs) ?? 0) + c.notionalUsd);
  }

  const strikes = [...byStrike.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_STRIKE_ROWS)
    .map(([s]) => s)
    .sort((a, b) => a - b); // ascending: bottom row = lowest strike
  const expiries = [...byExpiry.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_EXPIRY_COLS)
    .map(([e]) => e)
    .sort((a, b) => a - b);

  const cells = new Map<string, number>();
  let max = 0;
  for (const c of snap.heatmap) {
    const x = expiries.indexOf(c.expiryTs);
    const y = strikes.indexOf(c.strike);
    if (x === -1 || y === -1) continue;
    const k = `${x}|${y}`;
    const v = (cells.get(k) ?? 0) + c.notionalUsd;
    cells.set(k, v);
    max = Math.max(max, v);
  }

  const data = [...cells.entries()].map(([k, v]) => {
    const [x, y] = k.split("|").map(Number);
    return [x, y, v] as [number, number, number];
  });

  let spotIdx = -1;
  for (let i = 0; i < strikes.length; i++) {
    if (
      Math.abs(strikes[i] - snap.spot) / snap.spot < 0.02 &&
      (spotIdx === -1 || Math.abs(strikes[i] - snap.spot) < Math.abs(strikes[spotIdx] - snap.spot))
    ) {
      spotIdx = i;
    }
  }

  const option: EChartsOption = {
    animationDuration: 300,
    grid: { left: 8, right: 8, top: 8, bottom: 40, containLabel: true },
    tooltip: {
      backgroundColor: "#10141b",
      borderColor: "#333e4e",
      textStyle: { color: "#e8ecf1", fontSize: 12 },
      formatter: (params) => {
        const p = Array.isArray(params) ? params[0] : params;
        const [x, y, v] = p.value as [number, number, number];
        return `<b>$${fmtStrike(strikes[y])} · ${fmtExpiryDate(expiries[x])}</b><br/>Open interest: ${fmtUsd(v)}`;
      },
    },
    xAxis: {
      type: "category",
      data: expiries.map((e) => fmtExpiryDate(e)),
      axisLine: { lineStyle: { color: "#333e4e" } },
      axisTick: { show: false },
      axisLabel: { color: "#8891a0", fontSize: 10 },
      splitArea: { show: false },
    },
    yAxis: {
      type: "category",
      data: strikes.map((s) => {
        const label = `$${fmtStrike(s)}`;
        return strikes.indexOf(s) === spotIdx ? `${label} ◂` : label;
      }),
      axisLine: { lineStyle: { color: "#333e4e" } },
      axisTick: { show: false },
      axisLabel: { color: "#8891a0", fontSize: 10 },
    },
    visualMap: {
      min: 0,
      max: Math.max(max, 1),
      calculable: false,
      orient: "horizontal",
      left: "center",
      bottom: 0,
      itemHeight: 90,
      itemWidth: 10,
      text: ["crowded", "quiet"],
      textStyle: { color: "#8891a0", fontSize: 10 },
      inRange: {
        color: ["#141a24", "#1c3a5e", "#1f5f9e", "#2f8fef", "#7dd3fc"],
      },
    },
    series: [
      {
        type: "heatmap",
        data,
        itemStyle: {
          borderColor: "#0a0d12",
          borderWidth: 1.5,
          borderRadius: 3,
        },
        emphasis: {
          itemStyle: { shadowBlur: 8, shadowColor: "rgba(47, 143, 239, 0.5)" },
        },
      },
    ],
  };

  return { option, empty: strikes.length === 0 };
}
