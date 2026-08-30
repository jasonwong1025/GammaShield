"use client";

import { useState } from "react";
import type { AssetSnapshot } from "@/lib/engine";
import { TRADE_PERIODS, type TradePeriod } from "@/lib/tradePeriods";
import type { HedgeIntent } from "./TradePanel";

export function ExecutionTerminal({ snap, onOpenDashboard }: { snap: AssetSnapshot; onOpenDashboard: (intent: HedgeIntent) => void }) {
  const highRisk = snap.score >= 70 || snap.regime === "amplifying";
  const [contracts, setContracts] = useState("0.001");
  const [period, setPeriod] = useState<TradePeriod>(7);
  const [maxPremium, setMaxPremium] = useState("1");
  const contractsValue = Number(contracts);
  const maxPremiumValue = Number(maxPremium);
  const valid = Number.isFinite(contractsValue) && contractsValue > 0 && Number.isFinite(maxPremiumValue) && maxPremiumValue > 0;

  return (
    <section className="card p-5 flex flex-col gap-4" aria-label="Autonomous hedge recommendation">
      <div className={`rounded-xl border p-4 ${highRisk ? "border-crit/40 bg-crit/10" : "border-blue/30 bg-blue/5"}`}>
        <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-blue">Live protective-put plan</p>
        <h2 className="mt-1 text-[16px] font-bold text-fg">Turn your exposure into one reviewed live quote</h2>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">
          The quoted book is {snap.score}/100 and {snap.regime}. This is market context, not a price prediction: GammaShield finds a matching live put, then you review and sign it yourself.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 text-[12px]">
        <label className="flex flex-col gap-1 text-muted">
          Exposure to protect ({snap.asset})
          <input value={contracts} onChange={(event) => setContracts(event.target.value)} inputMode="decimal" className="h-9 rounded-lg border border-edge bg-panel px-2 text-fg outline-none focus:border-blue" />
        </label>
        <label className="flex flex-col gap-1 text-muted">
          Premium cap (USD)
          <input value={maxPremium} onChange={(event) => setMaxPremium(event.target.value)} inputMode="decimal" className="h-9 rounded-lg border border-edge bg-panel px-2 text-fg outline-none focus:border-blue" />
        </label>
      </div>
      <div className="grid grid-cols-3 gap-1 rounded-lg bg-panel2 p-1">
        {TRADE_PERIODS.map((value) => (
          <button key={value} type="button" onClick={() => setPeriod(value)} className={`h-8 rounded-md text-[12px] font-medium ${period === value ? "bg-panel3 text-fg" : "text-muted hover:text-fg"}`}>
            {value === 7 ? "1 week" : value === 14 ? "2 weeks" : "4 weeks"}
          </button>
        ))}
      </div>
      <button type="button" disabled={!valid || !["BTC", "ETH"].includes(snap.asset)} onClick={() => onOpenDashboard({ asset: snap.asset, contracts, period, maxPremiumUsd: maxPremiumValue, nonce: Date.now() })} className="h-10 rounded-lg bg-blue text-[13px] font-semibold text-white hover:brightness-110 disabled:opacity-50">
        Find a live {snap.asset} protective put
      </button>
    </section>
  );
}
