"use client";

import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import type { AssetSnapshot } from "@/lib/engine";
import { fmtStrike, fmtUsd } from "@/lib/format";
import { EChart } from "./EChart";

/** Chart only, no card/header chrome — composed into RiskView alongside Heatmap. */
export function GexChartBody({ snap }: { snap: AssetSnapshot }) {
  const option = useMemo(() => buildOption(snap), [snap]);
  const empty = snap.gexByStrike.length === 0;

  return empty ? (
    <div className="h-[240px] flex items-center justify-center text-[12px] text-faint">
      No live orders with Greeks for this asset right now.
    </div>
  ) : (
    <EChart option={option} height={260} ariaLabel="Dealer gamma exposure across strikes" />
  );
}

function buildOption(snap: AssetSnapshot): EChartsOption {
  const rows = snap.gexByStrike;
  const strikes = rows.map((r) => r.strike);
  const notionalByStrike = new Map(rows.map((r) => [r.strike, r.notionalUsd]));

  const nearestIndex = (target: number) => {
    let best = 0;
    for (let i = 1; i < strikes.length; i++) {
      if (Math.abs(strikes[i] - target) < Math.abs(strikes[best] - target)) best = i;
    }
    return best;
  };

  const markData: object[] = [
    {
      name: "spot",
      xAxis: nearestIndex(snap.spot),
      label: { formatter: `spot $${fmtStrike(snap.spot)}`, color: "#2b66d9" },
      lineStyle: { color: "#2b66d9", type: "dashed" },
    },
  ];
  if (snap.flipStrike !== null) {
    markData.push({
      name: "flip",
      xAxis: nearestIndex(snap.flipStrike),
      label: { formatter: `flip $${fmtStrike(snap.flipStrike)}`, color: "#c8891a" },
      lineStyle: { color: "#c8891a", type: "dashed" },
    });
  }

  return {
    animationDuration: 300,
    grid: { left: 8, right: 8, top: 26, bottom: 22, containLabel: true },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      backgroundColor: "#ffffff",
      borderColor: "#c9d2e0",
      textStyle: { color: "#172136", fontSize: 12 },
      formatter: (params) => {
        const p = Array.isArray(params) ? params[0] : params;
        const strike = strikes[p.dataIndex as number];
        const gex = rows[p.dataIndex as number].gex;
        const oi = notionalByStrike.get(strike) ?? 0;
        return [
          `<b>Strike $${fmtStrike(strike)}</b>`,
          `Dealer GEX: ${gex < 0 ? "-" : "+"}${fmtUsd(Math.abs(gex))} per 1% move`,
          `Open interest: ${fmtUsd(oi)}`,
          gex < 0 ? "Hedging amplifies moves here" : "Hedging absorbs moves here",
        ].join("<br/>");
      },
    },
    xAxis: {
      type: "category",
      data: strikes.map((s) => fmtStrike(s)),
      axisLine: { lineStyle: { color: "#e3e8f0" } },
      axisTick: { show: false },
      axisLabel: { color: "#8a94a8", fontSize: 10, interval: "auto" },
    },
    yAxis: {
      type: "value",
      axisLabel: {
        color: "#8a94a8",
        fontSize: 10,
        formatter: (v: number) => fmtUsd(v),
      },
      splitLine: { lineStyle: { color: "rgba(23, 33, 54, 0.08)" } },
    },
    series: [
      {
        type: "bar",
        data: rows.map((r) => ({
          value: r.gex,
          itemStyle: {
            color: r.gex >= 0 ? "#12a06e" : "#d8433b",
            borderRadius: r.gex >= 0 ? [2, 2, 0, 0] : [0, 0, 2, 2],
          },
        })),
        barMaxWidth: 14,
        markLine: {
          symbol: "none",
          animation: false,
          label: { fontSize: 10 },
          data: markData,
        },
      },
    ],
  };
}
