"use client";

import { useEffect, useState } from "react";
import type { Asset } from "@/lib/assets";
import { SENTIMENTS, getStrategy, strategiesBySentiment, type SentimentBucket } from "@/lib/strategy";
import type { AiStrategySuggestion } from "@/lib/aiStrategy";
import type { StrategyQuote } from "@/lib/strategyQuote";
import { type TradePeriod } from "@/lib/tradePeriods";
import { fmtExpiryDate, fmtStrike, fmtUsd } from "@/lib/format";
import { StrategyPayoffChart } from "./StrategyPayoffChart";

const PERIODS: TradePeriod[] = [7, 14, 28];

function periodLabel(period: TradePeriod) {
  return period === 7 ? "1 Week" : period === 14 ? "2 Weeks" : "4 Weeks";
}

function result<T>(response: Response, data: T & { error?: string }) {
  if (!response.ok) throw new Error(data.error ?? `request ${response.status}`);
  return data;
}

export function StrategyBuilder({ asset }: { asset: Asset }) {
  const [sentiment, setSentiment] = useState<SentimentBucket>("bullish");
  const [strategyId, setStrategyId] = useState(() => strategiesBySentiment("bullish")[0].id);
  const [amount, setAmount] = useState("1");
  const [period, setPeriod] = useState<TradePeriod>(7);
  const [quote, setQuote] = useState<StrategyQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [ai, setAi] = useState<AiStrategySuggestion | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const contracts = Number(amount);
  const validAmount = Number.isFinite(contracts) && contracts > 0;
  const strategies = strategiesBySentiment(sentiment);
  const strategy = getStrategy(strategyId) ?? strategies[0];
  const activeQuote = validAmount && strategy ? quote : null;

  useEffect(() => {
    if (!strategy || !validAmount) {
      return;
    }
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/strategy-quote?asset=${asset}&strategyId=${strategy.id}&contracts=${contracts}&period=${period}`, { cache: "no-store" });
        const data = await response.json();
        if (cancelled) return;
        setQuote(result(response, data));
        setQuoteError(null);
      } catch (error) {
        if (!cancelled) {
          setQuote(null);
          setQuoteError(error instanceof Error ? error.message : "strategy quote failed");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    const timer = setTimeout(load, 250);
    const refresh = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearInterval(refresh);
    };
  }, [asset, contracts, period, strategy, validAmount]);

  const suggest = async () => {
    setAiLoading(true);
    setAiError(null);
    try {
      const response = await fetch("/api/strategy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ asset }),
      });
      const data = result(response, await response.json()) as AiStrategySuggestion;
      setAi(data);
      setSentiment(data.sentiment);
      setStrategyId(data.strategyId);
    } catch (error) {
      setAi(null);
      setAiError(error instanceof Error ? error.message : "AI strategy suggestion failed");
    } finally {
      setAiLoading(false);
    }
  };

  const selectSentiment = (next: SentimentBucket) => {
    const nextStrategies = strategiesBySentiment(next);
    setQuote(null);
    setSentiment(next);
    setStrategyId(nextStrategies[0].id);
  };
  const hasSell = strategy?.legs.some((leg) => leg.action === "sell");
  const resolvedLegs = activeQuote?.legs.map(({ side, action, strike, qty }) => ({ side, action, strike, qty })) ?? [];

  return (
    <div className="flex flex-col gap-4" aria-label="Multi-leg strategy planner">
      <div className="rounded-lg border border-blue/25 bg-bluesoft/30 p-3 text-[12px] leading-relaxed text-muted">
        Explore real Thetanuts strikes and long-option prices at one shared expiry. This is a strategy planner, not a bundle order: GammaShield intentionally does not send sequential multi-leg fills.
      </div>
      <div className="grid grid-cols-4 gap-1 rounded-lg bg-panel2 p-1">
        {SENTIMENTS.map((item) => <button key={item.id} onClick={() => selectSentiment(item.id)} aria-pressed={sentiment === item.id} className={`h-8 rounded-md text-[11px] font-semibold ${sentiment === item.id ? "bg-panel text-fg shadow-sm" : "text-muted hover:text-fg"}`}>{item.label}</button>)}
      </div>
      <div className="grid grid-cols-1 gap-1">
        {strategies.map((item) => <button key={item.id} onClick={() => { setQuote(null); setStrategyId(item.id); }} aria-pressed={strategy?.id === item.id} className={`rounded-lg border p-3 text-left ${strategy?.id === item.id ? "border-blue bg-bluesoft/30" : "border-edge hover:border-blue/40"}`}><span className="text-[13px] font-semibold text-fg">{item.name}</span><span className="mt-0.5 block text-[11px] text-muted">{item.description}</span></button>)}
      </div>
      <div className="grid grid-cols-[1fr_auto] gap-3">
        <label className="text-[11px] text-muted">Contracts<input value={amount} onChange={(event) => { setQuote(null); setAmount(event.target.value); }} inputMode="decimal" className="mt-1 h-9 w-full rounded-lg border border-edge bg-panel px-2 text-[13px] text-fg outline-none" /></label>
        <div className="text-[11px] text-muted">Period<div className="mt-1 flex rounded-lg bg-panel2 p-1">{PERIODS.map((item) => <button key={item} onClick={() => { setQuote(null); setPeriod(item); }} className={`h-7 rounded-md px-2 text-[10px] font-semibold ${period === item ? "bg-panel text-fg shadow-sm" : "text-muted"}`}>{periodLabel(item)}</button>)}</div></div>
      </div>
      <div className="flex items-center justify-between gap-3"><button onClick={suggest} disabled={aiLoading} className="h-9 rounded-lg border border-blue/40 px-3 text-[12px] font-semibold text-blue disabled:opacity-60">{aiLoading ? "Asking Gonka…" : "Suggest strategy"}</button>{ai && <span className="text-right text-[11px] text-muted">Gonka advisory · {Math.round(ai.confidence * 100)}% confidence</span>}</div>
      {ai && <p className="rounded-lg bg-panel2 p-3 text-[12px] text-muted">{ai.rationale}</p>}
      {aiError && <p className="text-[12px] text-crit">{aiError}</p>}
      {loading && !activeQuote && <p className="text-[12px] text-faint">Resolving the live Thetanuts strike grid…</p>}
      {quoteError && <p className="text-[12px] text-crit">{quoteError}</p>}
      {activeQuote && <div className="rounded-lg bg-panel2 p-3 text-[12px]"><div className="flex justify-between gap-3"><span className="text-muted">Shared expiry</span><span className="text-fg">{fmtExpiryDate(activeQuote.expiryTs)}</span></div><div className="mt-2 flex flex-col gap-1.5">{activeQuote.legs.map((leg, index) => <div key={`${leg.side}:${leg.action}:${leg.strike}:${index}`} className="flex justify-between gap-3"><span className="text-muted">{leg.qty}× {leg.action} {leg.side} {fmtStrike(leg.strike)}</span><span className="text-fg">{leg.premiumPerContractUsd == null ? "Price unavailable" : `${fmtUsd(leg.premiumPerContractUsd, false)} / contract`}</span></div>)}</div>{activeQuote.netPremiumUsd != null ? <><div className="my-2 border-t border-edge" /><div className="flex justify-between font-semibold"><span>Long-option cost</span><span>{fmtUsd(activeQuote.netPremiumUsd, false, 2)}</span></div><StrategyPayoffChart legs={resolvedLegs} netPremiumPerUnit={activeQuote.netPremiumUsd / activeQuote.contracts} spot={activeQuote.spot} /><div className="grid grid-cols-2 gap-2 text-[11px]"><span className="text-muted">Max profit <b className="text-fg">{activeQuote.maxProfit === "unlimited" ? "Unlimited" : fmtUsd(activeQuote.maxProfit ?? 0, false)}</b></span><span className="text-muted">Max loss <b className="text-fg">{activeQuote.maxLoss === "unlimited" ? "Unlimited" : fmtUsd(activeQuote.maxLoss ?? 0, false)}</b></span></div></> : <p className="mt-3 rounded-md border border-warn/30 bg-panel p-2.5 text-muted">Thetanuts currently exposes reliable taker-long quotes only. This strategy includes a short leg, so its payoff is a planning template—not a price or executable order.</p>}</div>}
      <p className="text-[11px] leading-relaxed text-faint">{hasSell ? "Short legs require collateral and a maker-side execution path that is not available here." : "Each leg has a live long-option quote, but there is no atomic Thetanuts multi-leg fill. Use the single-option panel only after reviewing each leg independently."}</p>
    </div>
  );
}
