"use client";

import type { AssetSnapshot } from "@/lib/engine";

export function ExecutionTerminal({ snap, onOpenDashboard }: { snap: AssetSnapshot; onOpenDashboard: () => void }) {
  const highRisk = snap.score >= 70 || snap.regime === "amplifying";

  return (
    <section className="card p-5 flex flex-col gap-4" aria-label="Autonomous hedge recommendation">
      <div className={`rounded-xl border p-4 ${highRisk ? "border-crit/40 bg-crit/10" : "border-blue/30 bg-blue/5"}`}>
        <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-blue">Autonomous hedge recommendation</p>
        <h2 className="mt-1 text-[16px] font-bold text-fg">Configure the hedge in one trade panel</h2>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">
          {snap.asset} risk is {snap.score}/100 in the {snap.regime} regime. AI can recommend a hedge, but it never receives a private key: you review and sign a Base-mainnet or Sepolia-shadow fill in the dashboard.
        </p>
      </div>
      <button type="button" onClick={onOpenDashboard} className="h-10 rounded-lg bg-blue text-[13px] font-semibold text-white hover:brightness-110">
        Configure {snap.asset} protective put
      </button>
    </section>
  );
}
