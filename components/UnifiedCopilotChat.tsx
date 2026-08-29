"use client";

import { useState } from "react";
import type { AssetSnapshot } from "@/lib/engine";
import { fmtPct, fmtUsd } from "@/lib/format";
import type { FactCheckResult, WhatIfResult, GonkaModelId } from "@/lib/gonka";
import { GONKA_MODELS } from "@/lib/gonka";

type CopilotMode = "simulate" | "rumor";

type Props = {
  snap: AssetSnapshot;
  onNavigateToHedge?: (strike?: number) => void;
};

type ChatMessage = {
  id: string;
  sender: "user" | "ai";
  mode: CopilotMode;
  text: string;
  rumorData?: FactCheckResult;
  whatIfData?: WhatIfResult;
  gonkaRequestId?: string;
  modelUsed?: string;
  timestamp: number;
};

const SIMULATE_PILLS = [
  "What if I market-sell $5M ETH right now?",
  "What if a whale dumps $25M on the book?",
  "If institutions buy $50M, how much will dealers short?",
];

const RUMOR_PILLS = [
  "Whale moving 50,000 ETH to exchange, crash imminent!",
  "SEC investigating liquid staking derivative protocols",
  "Derivatives dealer short gamma cascade alert",
];

export function UnifiedCopilotChat({ snap, onNavigateToHedge }: Props) {
  const [mode, setMode] = useState<CopilotMode>("simulate");
  const [input, setInput] = useState("");
  const [selectedModel, setSelectedModel] = useState<GonkaModelId>(GONKA_MODELS.FLASH);
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      sender: "ai",
      mode: "simulate",
      text: `👋 Hi! I'm your Gonka Quantitative Copilot. Select a mode above to test how large trades move ${snap.asset} or verify whether breaking market rumors are real.`,
      timestamp: Date.now(),
    },
  ]);

  const activePills = mode === "simulate" ? SIMULATE_PILLS : RUMOR_PILLS;

  const handleSend = async (textToSend = input) => {
    if (!textToSend.trim()) return;

    const userMessage: ChatMessage = {
      id: `user_${Date.now()}`,
      sender: "user",
      mode,
      text: textToSend,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setLoading(true);

    try {
      if (mode === "simulate") {
        const res = await fetch("/api/whatif", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question: textToSend,
            asset: snap.asset,
            spotPrice: snap.spot,
            score: snap.score,
            netGexUsd: snap.netGexUsd,
            regime: snap.regime,
            model: selectedModel,
          }),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: WhatIfResult = await res.json();

        const aiMessage: ChatMessage = {
          id: `ai_${Date.now()}`,
          sender: "ai",
          mode: "simulate",
          text: data.conversationalAnswer,
          whatIfData: data,
          gonkaRequestId: data.gonkaRequestId,
          modelUsed: data.modelUsed,
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, aiMessage]);
      } else {
        // Rumor Fact-Check Mode
        const res = await fetch("/api/factcheck", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            headline: textToSend,
            asset: snap.asset,
            gexScore: snap.score,
            spotPrice: snap.spot,
            flipStrike: snap.flipStrike,
            netGexUsd: snap.netGexUsd,
            regime: snap.regime,
            model: selectedModel,
          }),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const data: FactCheckResult = json.data;

        const aiMessage: ChatMessage = {
          id: `ai_${Date.now()}`,
          sender: "ai",
          mode: "rumor",
          text: data.verdict,
          rumorData: data,
          gonkaRequestId: json.gonkaRequestId,
          modelUsed: json.modelUsed,
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, aiMessage]);
      }
    } catch (err) {
      const errMsg: ChatMessage = {
        id: `err_${Date.now()}`,
        sender: "ai",
        mode,
        text: `Error reaching GonkaRouter: ${err instanceof Error ? err.message : "Network error"}`,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, errMsg]);
    } finally {
      setLoading(false);
    }
  };

  const copyTraceId = (id: string) => {
    navigator.clipboard.writeText(id);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <section className="bg-white rounded-2xl shadow-xs border border-slate-100/80 p-6 flex flex-col gap-5 min-h-[580px]" aria-label="Unified Gonka Copilot">
      {/* Header & Mode Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-100">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex size-2.5 rounded-full bg-blue animate-pulse" />
            <h2 className="text-[16px] font-bold text-slate-900 tracking-tight">Gonka AI Copilot</h2>
          </div>
          <p className="text-[12.5px] text-slate-500 mt-0.5">
            Check if viral rumors are real or simulate how dealer hedging will react to your trades.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {/* Model Selector */}
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value as GonkaModelId)}
            className="px-2.5 py-1.5 rounded-lg border border-slate-200 bg-slate-50 text-[11.5px] font-medium text-slate-700 focus:outline-none focus:border-blue"
            title="Select AI Model"
          >
            <option value={GONKA_MODELS.FLASH}>⚡ DeepSeek Flash (~3s)</option>
            <option value={GONKA_MODELS.PRIMARY}>🧠 MiniMax-M2.7 (Deep Quant)</option>
            <option value={GONKA_MODELS.KIMI}>🎯 Kimi-K2.6 (Fact Accuracy)</option>
          </select>

          {/* Mode Switcher Pill */}
          <div className="flex p-1 rounded-xl bg-slate-100/80 border border-slate-200/60 shrink-0">
            <button
              type="button"
              onClick={() => setMode("simulate")}
              className={`px-3.5 py-1.5 rounded-lg text-[12px] font-semibold transition ${
                mode === "simulate"
                  ? "bg-white text-blue shadow-xs"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              💬 Simulate Trade ("What-If")
            </button>
            <button
              type="button"
              onClick={() => setMode("rumor")}
              className={`px-3.5 py-1.5 rounded-lg text-[12px] font-semibold transition ${
                mode === "rumor"
                  ? "bg-white text-blue shadow-xs"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              🔍 Verify Rumor (Fact-Check)
            </button>
          </div>
        </div>
      </div>

      {/* Messages Stream */}
      <div className="grow flex flex-col gap-3.5 max-h-[460px] overflow-y-auto pr-1 feed-scroll">
        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex flex-col gap-2.5 p-4 rounded-2xl text-[13px] leading-relaxed transition ${
              m.sender === "user"
                ? "bg-blue/5 border border-blue/15 text-slate-900 ml-10 self-end"
                : "bg-slate-50 border border-slate-100 text-slate-800 mr-4 self-start"
            }`}
          >
            {/* Message header */}
            <div className="flex items-center justify-between text-[11px] font-medium text-slate-400">
              <span className="flex items-center gap-1.5">
                {m.sender === "user" ? (
                  <span>You</span>
                ) : (
                  <>
                    <span className="size-2 rounded-full bg-blue" />
                    <span className="font-semibold text-slate-700">
                      Gonka Copilot · {m.mode === "simulate" ? "Trade Simulator" : "Fact-Checker"}
                    </span>
                  </>
                )}
              </span>
              <span>{new Date(m.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            </div>

            <p className="whitespace-pre-line text-slate-700">{m.text}</p>

            {/* RUMOR FACT-CHECK RESULT CARD */}
            {m.rumorData && (
              <div className="mt-2 p-3.5 rounded-xl bg-white border border-slate-200/80 shadow-xs flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3 pb-2.5 border-b border-slate-100">
                  <div className="flex items-center gap-3">
                    <div className="flex flex-col items-center justify-center size-12 rounded-full border-2 border-slate-100 bg-slate-50 text-center">
                      <span
                        className="num text-[16px] font-bold leading-none"
                        style={{ color: m.rumorData.truthScore > 65 ? "var(--crit)" : "var(--calm)" }}
                      >
                        {m.rumorData.truthScore}%
                      </span>
                      <span className="text-[8.5px] text-slate-400 font-bold uppercase mt-0.5">Truth</span>
                    </div>
                    <div>
                      <span className="font-bold text-[13px] text-slate-900">
                        {m.rumorData.truthScore > 65 ? "⚠️ Confirmed Fragility Trigger" : "🛡️ FUD / Minimal Market Danger"}
                      </span>
                      <span
                        className="ml-2 text-[10px] font-bold px-2 py-0.5 rounded-full"
                        style={{
                          background: m.rumorData.urgency === "CRITICAL" ? "rgba(216, 67, 59, 0.1)" : "rgba(18, 160, 110, 0.1)",
                          color: m.rumorData.urgency === "CRITICAL" ? "var(--crit)" : "var(--calm)",
                        }}
                      >
                        {m.rumorData.urgency}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="text-[12px] text-slate-600 leading-relaxed">
                  <span className="font-semibold text-slate-800 block mb-1">Reasoning Analysis:</span>
                  <p>{m.rumorData.reasoning}</p>
                </div>

                {/* Autonomous Hedge Recommendation */}
                <div
                  className={`p-3 rounded-lg border flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2.5 ${
                    m.rumorData.shouldHedge
                      ? "border-rose-200 bg-rose-50/60"
                      : "border-emerald-200 bg-emerald-50/60"
                  }`}
                >
                  <div className="flex flex-col gap-0.5 text-[11.5px]">
                    <div className="flex items-center gap-1.5 font-bold text-slate-900">
                      <span>{m.rumorData.shouldHedge ? "🚨 Protective Put Recommended" : "✅ No Immediate Hedge Needed"}</span>
                      {m.rumorData.strikeSuggestion > 0 && (
                        <span className="font-mono px-1.5 py-0.2 rounded bg-white border text-blue text-[11px]">
                          ${m.rumorData.strikeSuggestion.toLocaleString()} PUT
                        </span>
                      )}
                    </div>
                    <span className="text-slate-600">{m.rumorData.actionRationale}</span>
                  </div>

                  {m.rumorData.shouldHedge && onNavigateToHedge && (
                    <button
                      type="button"
                      onClick={() => onNavigateToHedge(m.rumorData?.strikeSuggestion)}
                      className="shrink-0 px-3.5 py-1.5 rounded-lg bg-rose-600 text-white text-[11.5px] font-bold hover:bg-rose-700 transition shadow-xs"
                    >
                      Hedge on Base (~1 USDC) ⚡
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* WHAT-IF SIMULATION RESULT CARD */}
            {m.whatIfData && (
              <div className="mt-2 p-3.5 rounded-xl bg-white border border-slate-200/80 shadow-xs flex flex-col gap-3">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11.5px] bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                  <div>
                    <span className="text-slate-400 block text-[10.5px]">Order</span>
                    <span className="font-bold text-slate-800 num">
                      {m.whatIfData.parsedAction} ${m.whatIfData.parsedSizeM}M
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[10.5px]">Direct Move</span>
                    <span className="font-bold text-slate-800 num">{fmtPct(m.whatIfData.initialMovePct)}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[10.5px]">Dealer Hedging</span>
                    <span
                      className="font-bold num"
                      style={{ color: m.whatIfData.amplification > 1.05 ? "var(--crit)" : "var(--calm)" }}
                    >
                      {fmtUsd(Math.abs(m.whatIfData.hedgeFlowUsd))}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[10.5px]">Amplification</span>
                    <span
                      className="font-bold num"
                      style={{ color: m.whatIfData.amplification > 1.05 ? "var(--crit)" : "var(--calm)" }}
                    >
                      ×{m.whatIfData.amplification.toFixed(2)}
                    </span>
                  </div>
                </div>

                <div className="p-2.5 rounded-lg bg-blue-50/70 border border-blue-100 text-[12px] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-semibold text-blue-900 text-[11px] uppercase tracking-wider">
                      Execution Strategy:
                    </span>
                    <p className="text-slate-600 text-[11.5px]">{m.whatIfData.strategicAdvice}</p>
                  </div>
                  {m.whatIfData.amplification > 1.15 && onNavigateToHedge && (
                    <button
                      type="button"
                      onClick={() => onNavigateToHedge()}
                      className="shrink-0 px-3 py-1 text-[11.5px] font-bold rounded-lg bg-rose-600 text-white hover:bg-rose-700 transition"
                    >
                      Hedge Downside 🛡️
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Gonka Trace Pill */}
            {m.gonkaRequestId && (
              <div className="flex items-center justify-between text-[10.5px] font-mono text-slate-400 pt-1">
                <span>Gonka Trace ID: {m.gonkaRequestId}</span>
                <button
                  type="button"
                  onClick={() => copyTraceId(m.gonkaRequestId!)}
                  className="text-blue hover:underline"
                >
                  {copiedId === m.gonkaRequestId ? "✓ Copied" : "Copy ID"}
                </button>
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="flex items-center gap-2 p-3.5 rounded-xl bg-slate-50 border border-slate-100 text-[12.5px] text-slate-500 self-start animate-pulse">
            <span className="size-3.5 rounded-full border-2 border-blue border-t-transparent animate-spin" />
            <span>Analyzing scenario with GonkaRouter multi-model AI…</span>
          </div>
        )}
      </div>

      {/* Input Area + Hovering Preset Pills */}
      <div className="flex flex-col gap-2 mt-auto">
        {/* Quick Suggestion Pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 feed-scroll">
          <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider shrink-0">Try:</span>
          {activePills.map((pill, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => {
                setInput(pill);
                handleSend(pill);
              }}
              className="text-[11.5px] px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-900 transition whitespace-nowrap shrink-0 border border-slate-200/50"
            >
              {pill.length > 40 ? `${pill.slice(0, 38)}…` : pill}
            </button>
          ))}
        </div>

        {/* Input Bar */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          className="flex gap-2"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              mode === "simulate"
                ? `Ask a trade scenario (e.g. 'What if I sell $5M ${snap.asset}?')...`
                : `Paste a market rumor or viral tweet to fact-check...`
            }
            className="grow px-4 py-2.5 text-[13px] bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:outline-none focus:border-blue focus:bg-white transition placeholder:text-slate-400"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="px-5 py-2.5 rounded-xl bg-blue text-white text-[13px] font-semibold hover:brightness-110 active:scale-[0.98] transition disabled:opacity-40 shadow-xs"
          >
            {mode === "simulate" ? "Simulate" : "Verify"}
          </button>
        </form>
      </div>
    </section>
  );
}
