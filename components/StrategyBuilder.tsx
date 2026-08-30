"use client";

// Hegic-style ("Trade One-Click Option Strategies") multi-leg strategy
// builder: sentiment tabs → strategy list → resolved legs/payoff/cost, with a
// manual "Suggest a Strategy" AI button (GonkaRouter, via lib/aiStrategy.ts)
// annotating — never replacing — the manual browsing. Long-only strategies
// (every leg a "buy") execute for real via a sequential per-leg approve+fill/
// RFQ flow, reusing components/tradeExec.ts. Strategies with a sell leg
// render fully (legs/payoff/cost/AI rationale) but stay simulated-only — the
// live Thetanuts OptionBook/RFQ don't support the taker going short yet.

import { useEffect, useRef, useState } from "react";
import type { Asset } from "@/lib/assets";
import { SENTIMENTS, strategiesBySentiment, type SentimentBucket, type StrategyDef } from "@/lib/strategy";
import type { StrategyQuote } from "@/lib/strategyQuote";
import type { AiStrategySuggestion } from "@/lib/aiStrategy";
import type { TradeQuote } from "@/lib/trade";
import type { RfqPrepared, RfqStatus } from "@/lib/rfq";
import { TRADE_PERIODS, type TradePeriod } from "@/lib/tradePeriods";
import { fmtExpiryDate, fmtStrike, fmtUsd, riskColor } from "@/lib/format";
import { StrategyPayoffChart } from "./StrategyPayoffChart";
import { StrategyGlyph } from "./StrategyGlyph";
import { connectWallet, needsApproval, periodLabel, rfqApi, sendTx } from "./tradeExec";

const QUOTE_DEBOUNCE_MS = 250;
const QUOTE_REFRESH_MS = 15_000;

type LegExecState =
  | { phase: "idle" }
  | { phase: "connecting" | "approving" | "filling" | "requesting" | "accepting" }
  | { phase: "auction"; status: RfqStatus | null }
  | { phase: "done"; hash: string }
  | { phase: "error"; message: string };

function fmtMax(v: number | "unlimited"): string {
  return v === "unlimited" ? "Unlimited" : fmtUsd(v, false);
}


// Same principle as the payoff traces: a real mark, not a decorative icon.
// Bullish/bearish reuse the exact ↗/↘ glyphs the Call/Put toggle already uses
// in this panel; the vol tabs trace an actual jagged-vs-flat path.
function SentimentMark({ id }: { id: SentimentBucket }) {
  if (id === "bullish") return <span aria-hidden>↗</span>;
  if (id === "bearish") return <span aria-hidden>↘</span>;
  const d = id === "highVol" ? "M1 9.5 L4 2.5 L7 10.5 L10 1.5 L13 8.5" : "M1 6.5 L4 5.5 L7 7 L10 5.5 L13 6.5";
  return (
    <svg width="13" height="11" viewBox="0 0 14 12" aria-hidden="true" className="shrink-0">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function legPhaseLabel(st: LegExecState): string {
  switch (st.phase) {
    case "idle":
      return "queued";
    case "connecting":
      return "connecting wallet…";
    case "approving":
      return "approving…";
    case "filling":
      return "filling…";
    case "requesting":
      return "submitting RFQ…";
    case "auction":
      return "auction live";
    case "accepting":
      return "accepting offer…";
    case "done":
      return "filled";
    case "error":
      return "failed";
  }
}

export function StrategyBuilder({ asset }: { asset: Asset }) {
  const [sentiment, setSentiment] = useState<SentimentBucket>("bullish");
  const [selectedId, setSelectedId] = useState<string>(strategiesBySentiment("bullish")[0].id);
  const [amountStr, setAmountStr] = useState("1");
  const [period, setPeriod] = useState<TradePeriod>(7);

  const [quote, setQuote] = useState<StrategyQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const [aiSuggestion, setAiSuggestion] = useState<AiStrategySuggestion | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const [legStates, setLegStates] = useState<LegExecState[] | null>(null);
  const [legIndex, setLegIndex] = useState(0);
  const rfqAddressRef = useRef<string | null>(null);

  const contracts = Number(amountStr);
  const validAmount = Number.isFinite(contracts) && contracts > 0;
  const strategies = strategiesBySentiment(sentiment);
  const selected: StrategyDef | undefined = strategies.find((s) => s.id === selectedId) ?? strategies[0];

  // Keep the selection valid when the sentiment tab changes, and reset any
  // in-flight execution when the chosen strategy/amount/period changes —
  // done during render (not an effect) so it can't trigger a cascading
  // extra render, matching TradePanel.tsx's prevKey pattern.
  const [prevSentiment, setPrevSentiment] = useState(sentiment);
  if (prevSentiment !== sentiment) {
    setPrevSentiment(sentiment);
    if (!strategies.find((s) => s.id === selectedId)) setSelectedId(strategies[0].id);
  }
  const tradeKey = `${asset}:${selectedId}:${contracts}:${period}`;
  const [prevTradeKey, setPrevTradeKey] = useState(tradeKey);
  if (prevTradeKey !== tradeKey) {
    setPrevTradeKey(tradeKey);
    setLegStates(null);
    setLegIndex(0);
  }
  // A suggestion is asset-specific — clear it on asset switch rather than
  // leaving a stale rationale from the previous asset on screen.
  const [prevAsset, setPrevAsset] = useState(asset);
  if (prevAsset !== asset) {
    setPrevAsset(asset);
    setAiSuggestion(null);
    setAiError(null);
  }

  useEffect(() => {
    if (!validAmount || !selected) return;
    const id = ++seq.current;
    const fetchQuote = async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/strategy-quote?asset=${asset}&strategyId=${selected.id}&contracts=${contracts}&period=${period}`,
          { cache: "no-store" },
        );
        const data = await res.json();
        if (seq.current !== id) return;
        if (!res.ok) throw new Error(data.error ?? `strategy-quote ${res.status}`);
        setQuote(data);
        setQuoteError(null);
      } catch (e) {
        if (seq.current !== id) return;
        setQuote(null);
        setQuoteError(e instanceof Error ? e.message : "strategy quote failed");
      } finally {
        if (seq.current === id) setLoading(false);
      }
    };
    const timer = setTimeout(fetchQuote, QUOTE_DEBOUNCE_MS);
    const refresh = setInterval(fetchQuote, QUOTE_REFRESH_MS);
    return () => {
      clearTimeout(timer);
      clearInterval(refresh);
    };
  }, [asset, selected, contracts, period, validAmount]);

  // Manual only — mirrors TradePanel's "Get AI read": nothing here auto-fires
  // on a snapshot tick or selection change.
  const suggestStrategy = async () => {
    setAiLoading(true);
    setAiError(null);
    try {
      const marketRes = await fetch("/api/market", { cache: "no-store" });
      const market = await marketRes.json();
      if (!marketRes.ok) throw new Error(market.error ?? "market snapshot failed");
      const a = market.assets[asset];
      const res = await fetch("/api/strategy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          asset,
          spot: a.spot,
          score: a.score,
          regime: a.regime,
          netGexUsd: a.netGexUsd,
          avgIv: a.avgIv,
          flipStrike: a.flipStrike,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `strategy ${res.status}`);
      setAiSuggestion(data);
      setSentiment(data.sentiment);
      setSelectedId(data.strategyId);
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "AI suggestion failed");
    } finally {
      setAiLoading(false);
    }
  };

  // --- sequential per-leg execution (long-only strategies only) ---

  const runLeg = async (i: number, q: StrategyQuote) => {
    const leg = q.legs[i];
    const legContracts = q.contracts * leg.qty;
    setLegStates((s) => s!.map((st, idx) => (idx === i ? { phase: "connecting" } : st)));
    try {
      const res = await fetch(
        `/api/quote?asset=${asset}&side=${leg.side}&contracts=${legContracts}&period=${period}&strike=${leg.strike}&expiry=${q.expiryTs}`,
        { cache: "no-store" },
      );
      const legQuote: TradeQuote & { error?: string } = await res.json();
      if (!res.ok) throw new Error(legQuote.error ?? "leg quote failed");

      if (legQuote.source === "book" && legQuote.txs) {
        const { provider, from } = await connectWallet();
        if (await needsApproval(provider, from, legQuote.txs.approve, legQuote.txs.fill.to)) {
          setLegStates((s) => s!.map((st, idx) => (idx === i ? { phase: "approving" } : st)));
          await sendTx(provider, from, legQuote.txs.approve);
        }
        setLegStates((s) => s!.map((st, idx) => (idx === i ? { phase: "filling" } : st)));
        const hash = await sendTx(provider, from, legQuote.txs.fill);
        setLegStates((s) => s!.map((st, idx) => (idx === i ? { phase: "done", hash } : st)));
        advanceLeg(i, q);
      } else {
        const { provider, from } = await connectWallet();
        rfqAddressRef.current = from;
        const prepared = await rfqApi<RfqPrepared>({
          action: "prepare",
          address: from,
          asset,
          side: leg.side,
          contracts: legContracts,
          period,
          strike: leg.strike,
          expiry: q.expiryTs,
        });
        if (await needsApproval(provider, from, prepared.approve, prepared.tx.to)) {
          setLegStates((s) => s!.map((st, idx) => (idx === i ? { phase: "approving" } : st)));
          await sendTx(provider, from, prepared.approve);
        }
        setLegStates((s) => s!.map((st, idx) => (idx === i ? { phase: "requesting" } : st)));
        await sendTx(provider, from, prepared.tx);
        setLegStates((s) => s!.map((st, idx) => (idx === i ? { phase: "auction", status: null } : st)));
      }
    } catch (e) {
      const message =
        (e as { code?: number })?.code === 4001
          ? "Transaction rejected in wallet."
          : e instanceof Error
            ? e.message
            : "leg execution failed";
      setLegStates((s) => s!.map((st, idx) => (idx === i ? { phase: "error", message } : st)));
    }
  };

  const advanceLeg = (i: number, q: StrategyQuote) => {
    if (i + 1 < q.legs.length) {
      setLegIndex(i + 1);
      runLeg(i + 1, q);
    }
  };

  // Poll the current leg's RFQ auction for decrypted maker offers.
  useEffect(() => {
    if (!legStates || legStates[legIndex]?.phase !== "auction" || !rfqAddressRef.current) return;
    const address = rfqAddressRef.current;
    let stale = false;
    const poll = async () => {
      try {
        const { rfq: status } = await rfqApi<{ rfq: RfqStatus | null }>({ action: "status", address });
        if (stale || !status) return;
        setLegStates((s) =>
          s!.map((st, idx) => (idx === legIndex && st.phase === "auction" ? { ...st, status } : st)),
        );
      } catch {
        /* transient poll failure — keep trying */
      }
    };
    poll();
    const timer = setInterval(poll, 5_000);
    return () => {
      stale = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legStates?.[legIndex]?.phase, legIndex]);

  const acceptLegOffer = async (i: number, q: StrategyQuote) => {
    const st = legStates?.[i];
    if (!st || st.phase !== "auction" || !st.status?.best || !rfqAddressRef.current) return;
    const status = st.status;
    try {
      setLegStates((s) => s!.map((s2, idx) => (idx === i ? { phase: "accepting" } : s2)));
      const { provider, from } = await connectWallet();
      const txs = await rfqApi<{ approve: { to: string; data: string }; settle: { to: string; data: string } }>({
        action: "settle",
        address: from,
        id: status.id,
        offeror: status.best!.offeror,
      });
      if (await needsApproval(provider, from, txs.approve, txs.settle.to)) {
        await sendTx(provider, from, txs.approve);
      }
      const hash = await sendTx(provider, from, txs.settle);
      setLegStates((s) => s!.map((s2, idx) => (idx === i ? { phase: "done", hash } : s2)));
      advanceLeg(i, q);
    } catch (e) {
      const message =
        (e as { code?: number })?.code === 4001
          ? "Transaction rejected in wallet."
          : e instanceof Error
            ? e.message
            : "settle failed";
      setLegStates((s) => s!.map((s2, idx) => (idx === i ? { phase: "error", message } : s2)));
    }
  };

  const startExecution = () => {
    if (!quote || !quote.executable) return;
    const initial: LegExecState[] = quote.legs.map(() => ({ phase: "idle" }));
    setLegStates(initial);
    setLegIndex(0);
    runLeg(0, quote);
  };

  const executing = !!legStates && legStates.some((s) => s.phase !== "done" && s.phase !== "error");
  const allDone = !!legStates && legStates.every((s) => s.phase === "done");

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-center gap-4">
        {SENTIMENTS.map((s) => (
          <button
            key={s.id}
            onClick={() => setSentiment(s.id)}
            aria-pressed={sentiment === s.id}
            className={`flex items-center gap-1.5 pb-1.5 border-b-2 text-[12px] font-semibold transition ${
              sentiment === s.id ? "border-blue text-fg" : "border-transparent text-faint hover:text-muted"
            }`}
          >
            <SentimentMark id={s.id} />
            {s.label}
          </button>
        ))}
      </div>
      {/* AI assist — a link and a quoted line, not a boxed callout. */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {aiSuggestion ? (
            <p className="text-[12px] text-muted leading-relaxed border-l-2 border-blue/30 pl-2.5">
              {aiSuggestion.rationale}
              <span className="text-faint"> · {Math.round(aiSuggestion.confidence * 100)}% confidence</span>
            </p>
          ) : aiError ? (
            <p className="text-[12px] text-crit border-l-2 border-crit/30 pl-2.5">Unavailable — {aiError}</p>
          ) : (
            <p className="text-[12px] text-faint">Ask the model which strategy fits the current book.</p>
          )}
        </div>
        <button
          type="button"
          onClick={suggestStrategy}
          disabled={aiLoading}
          className="shrink-0 text-[12px] font-medium text-blue hover:underline disabled:opacity-60 disabled:no-underline"
        >
          {aiLoading ? "Asking…" : aiSuggestion ? "Ask again" : "Suggest a strategy"}
        </button>
      </div>

      {/* Strategy list — flat rows, no per-item cards. Each row's leading
          trace is that strategy's own real payoff shape, not an icon. */}
      <div className="flex flex-col">
        {strategies.map((s, i) => (
          <button
            key={s.id}
            onClick={() => setSelectedId(s.id)}
            aria-pressed={selectedId === s.id}
            className={`flex items-center gap-3 px-2 py-2 -mx-2 text-left rounded-md transition ${
              i > 0 ? "border-t border-edge/60" : ""
            } ${selectedId === s.id ? "bg-panel2" : "hover:bg-panel2/60"}`}
          >
            <StrategyGlyph strategyId={s.id} />
            <span className="min-w-0 flex flex-col gap-0.5">
              <span className="flex items-baseline gap-1.5">
                <span className="text-[13px] font-semibold text-fg">{s.name}</span>
                {!s.executable && <span className="text-[9px] font-medium uppercase tracking-wide text-faint">simulated</span>}
              </span>
              <span className="text-[11px] text-faint leading-snug">{s.description}</span>
            </span>
          </button>
        ))}
      </div>

      {/* Amount + period */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-[11px] text-muted mb-1">Amount</div>
          <div className="flex items-center rounded-lg border border-edge bg-panel px-3 h-10">
            <input
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              inputMode="decimal"
              aria-label="Number of strategy units"
              className="w-full bg-transparent text-[14px] num outline-none"
            />
          </div>
        </div>
        <div>
          <div className="text-[11px] text-muted mb-1">Period</div>
          <div className="grid grid-cols-3 gap-1 rounded-lg bg-panel2 p-1 h-10">
            {TRADE_PERIODS.map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                aria-pressed={period === p}
                className={`rounded-md text-[11px] font-semibold transition ${
                  period === p ? "bg-panel text-fg shadow-sm" : "text-muted hover:text-fg"
                }`}
              >
                {periodLabel(p)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Resolved legs / payoff / cost — flows in the panel, no enclosing box. */}
      {quoteError ? (
        <p className="text-[12px] text-crit">{quoteError}</p>
      ) : quote ? (
        <div className="flex flex-col gap-3 pt-1">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-semibold text-fg">{quote.strategyName}</span>
            <span className="text-[11px] text-faint">Expires {fmtExpiryDate(quote.expiryTs)}</span>
          </div>

          <p className="text-[12px] text-muted leading-relaxed">
            {quote.legs.map((leg, i) => (
              <span key={i}>
                {i > 0 && " · "}
                {leg.action === "buy" ? "Buy" : "Sell"}
                {leg.qty > 1 ? ` ${leg.qty}×` : ""} <span className="text-fg font-medium">{fmtStrike(leg.strike)} {leg.side}</span>
              </span>
            ))}
          </p>

          <StrategyPayoffChart
            legs={quote.legs.map((l) => ({ side: l.side, action: l.action, strike: l.strike, qty: l.qty }))}
            netPremiumPerUnit={quote.netPremiumUsd / quote.contracts}
            spot={quote.spot}
            breakevens={quote.breakevens}
          />

          <div className="grid grid-cols-4">
            {[
              [quote.netPremiumUsd >= 0 ? "Net cost" : "Net credit", fmtUsd(Math.abs(quote.netPremiumUsd), false), "text-fg"],
              ["Max profit", fmtMax(quote.maxProfit), "text-calm"],
              ["Max loss", fmtMax(quote.maxLoss), "text-crit"],
              [
                quote.breakevens.length > 1 ? "Breakevens" : "Breakeven",
                quote.breakevens.length ? quote.breakevens.map(fmtStrike).join(" / ") : "—",
                "text-fg",
              ],
            ].map(([label, value, color], i) => (
              <div key={label} className={`flex flex-col gap-0.5 px-2 first:pl-0 ${i > 0 ? "border-l border-edge" : ""}`}>
                <span className="text-[10px] uppercase tracking-wide text-faint">{label}</span>
                <span className={`num text-[13px] font-semibold ${color}`}>{value}</span>
              </div>
            ))}
          </div>

          {quote.impact && (
            <div className="flex items-center justify-between text-[12px]">
              <span className="text-muted">Amplification risk</span>
              <span className="num font-semibold">
                <span style={{ color: riskColor(quote.impact.scoreBefore) }}>{quote.impact.scoreBefore}</span>
                <span className="text-faint"> → </span>
                <span style={{ color: riskColor(quote.impact.scoreAfter) }}>{quote.impact.scoreAfter}</span>
              </span>
            </div>
          )}

          {!quote.executable ? (
            <p className="text-[11px] text-faint leading-relaxed">
              Simulated — needs a sell leg the live OptionBook/RFQ can&apos;t fill yet. Numbers above are real
              estimates.
            </p>
          ) : !legStates ? (
            <button
              onClick={startExecution}
              disabled={!validAmount}
              className="h-10 rounded-lg bg-blue text-white text-[13px] font-semibold hover:brightness-110 transition disabled:opacity-50"
            >
              Buy {quote.strategyName}
            </button>
          ) : (
            <div className="flex flex-col">
              {quote.legs.map((leg, i) => {
                const st = legStates[i];
                const dotColor =
                  st.phase === "done"
                    ? "var(--calm)"
                    : st.phase === "error"
                      ? "var(--crit)"
                      : st.phase === "idle"
                        ? "var(--edge-2)"
                        : "var(--blue)";
                return (
                  <div key={i} className={`flex items-start gap-2.5 py-2 ${i > 0 ? "border-t border-edge/60" : ""}`}>
                    <span className="mt-[5px] size-1.5 rounded-full shrink-0" style={{ background: dotColor }} />
                    <div className="min-w-0 flex-1 flex flex-col gap-1.5">
                      <div className="flex items-center justify-between text-[12px]">
                        <span className="text-fg">
                          {leg.action} {fmtStrike(leg.strike)} {leg.side}
                        </span>
                        <span className="text-faint">{legPhaseLabel(st)}</span>
                      </div>
                      {st.phase === "auction" &&
                        (st.status?.best ? (
                          <button
                            onClick={() => acceptLegOffer(i, quote)}
                            className="h-8 rounded-lg bg-blue text-white text-[12px] font-semibold hover:brightness-110 transition self-start px-3"
                          >
                            Accept best offer · {fmtUsd(st.status.best.totalPremiumUsd, false)}
                          </button>
                        ) : (
                          <p className="text-[11px] text-faint">
                            {st.status
                              ? `${st.status.offersCount} maker offer${st.status.offersCount === 1 ? "" : "s"} so far — waiting for the best price`
                              : "Broadcast to market makers…"}
                          </p>
                        ))}
                      {st.phase === "done" && (
                        <a
                          href={`${process.env.NEXT_PUBLIC_BASE_EXPLORER_URL ?? "https://basescan.org"}/tx/${st.hash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] text-calm underline"
                        >
                          View transaction
                        </a>
                      )}
                      {st.phase === "error" && <p className="text-[11px] text-crit">{st.message}</p>}
                    </div>
                  </div>
                );
              })}
              {allDone && (
                <p className="text-[12px] text-calm pt-2">
                  All legs filled.{" "}
                  <button className="underline" onClick={() => setLegStates(null)}>
                    Trade again
                  </button>
                </p>
              )}
              {!executing && !allDone && (
                <button
                  className="text-[11px] text-muted hover:text-fg transition self-start pt-2 underline"
                  onClick={() => setLegStates(null)}
                >
                  Reset
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        <p className="text-[12px] text-faint">{loading ? "Resolving strategy legs against the live book…" : ""}</p>
      )}
    </div>
  );
}
