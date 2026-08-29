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
    <section className="card p-5 flex flex-col gap-4 min-h-[600px]" aria-label="Unified Gonka Copilot">
      {/* Header & Mode Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-edge">
        <div>
          <div className="flex items-center gap-2">
            <span className="live-dot inline-block size-2 rounded-full bg-blue" />
            <h2 className="text-[15px] font-semibold text-fg tracking-tight">Gonka AI Copilot</h2>
          </div>
          <p className="text-[12px] text-muted mt-0.5">
            Check if viral rumors are real or simulate how dealer hedging will react to your trades.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {/* Model Selector */}
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value as GonkaModelId)}
            className="px-2.5 py-1 rounded-lg border border-edge bg-panel2 text-[11.5px] font-medium text-fg focus:outline-none focus:border-blue"
            title="Select AI Model"
          >
            <option value={GONKA_MODELS.FLASH}>⚡ DeepSeek Flash (~3s)</option>
            <option value={GONKA_MODELS.PRIMARY}>🧠 MiniMax-M2.7 (Deep Quant)</option>
            <option value={GONKA_MODELS.KIMI}>🎯 Kimi-K2.6 (Fact Accuracy)</option>
          </select>

          {/* Mode Switcher Pill */}
          <div className="flex p-0.5 rounded-lg bg-panel2 border border-edge shrink-0">
            <button
              type="button"
              onClick={() => setMode("simulate")}
              className={`px-3 py-1 rounded-md text-[12px] font-medium transition ${
                mode === "simulate"
                  ? "bg-panel3 text-fg font-semibold shadow-xs"
                  : "text-muted hover:text-fg"
              }`}
            >
              💬 Simulate Trade ("What-If")
            </button>
            <button
              type="button"
              onClick={() => setMode("rumor")}
              className={`px-3 py-1 rounded-md text-[12px] font-medium transition ${
                mode === "rumor"
                  ? "bg-panel3 text-fg font-semibold shadow-xs"
                  : "text-muted hover:text-fg"
              }`}
            >
              🔍 Verify Rumor (Fact-Check)
            </button>
          </div>
        </div>
      </div>

      {/* Messages Stream */}
      <div className="grow flex flex-col gap-3 max-h-[460px] overflow-y-auto pr-1 feed-scroll">
        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex flex-col gap-2 p-3.5 rounded-xl text-[12.5px] leading-relaxed transition ${
              m.sender === "user"
                ? "bg-bluesoft/70 border border-blue/20 text-fg ml-10 self-end"
                : "bg-panel2 border border-edge text-fg mr-4 self-start"
            }`}
          >
            {/* Message header */}
            <div className="flex items-center justify-between text-[11px] font-medium text-faint">
              <span className="flex items-center gap-1.5">
                {m.sender === "user" ? (
                  <span>You</span>
                ) : (
                  <>
                    <span className="size-1.5 rounded-full bg-blue" />
                    <span className="font-semibold text-fg">
                      Gonka Copilot · {m.mode === "simulate" ? "Trade Simulator" : "Fact-Checker"}
                    </span>
                  </>
                )}
              </span>
              <span>{new Date(m.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            </div>

            <p className="whitespace-pre-line">{m.text}</p>

            {/* RUMOR FACT-CHECK RESULT CARD */}
            {m.rumorData && (
              <div className="mt-2 p-3 rounded-lg bg-panel border border-edge flex flex-col gap-2.5">
                <div className="flex items-center justify-between gap-3 pb-2 border-b border-edge">
                  <div className="flex items-center gap-3">
                    <div className="flex flex-col items-center justify-center size-11 rounded-full border border-edge bg-panel2 text-center">
                      <span
                        className="num text-[15px] font-bold leading-none"
                        style={{ color: m.rumorData.truthScore > 65 ? "var(--crit)" : "var(--calm)" }}
                      >
                        {m.rumorData.truthScore}%
                      </span>
                      <span className="text-[8px] text-faint font-bold uppercase mt-0.5">Truth</span>
                    </div>
                    <div>
                      <span className="font-bold text-[12.5px] text-fg">
                        {m.rumorData.truthScore > 65 ? "⚠️ High Fragility Alert" : "🛡️ Low Volatility Risk / FUD"}
                      </span>
                      <span
                        className="ml-2 text-[10px] font-bold px-2 py-0.5 rounded-full"
                        style={{
                          background: m.rumorData.urgency === "CRITICAL" ? "rgba(216, 67, 59, 0.15)" : "rgba(18, 160, 110, 0.15)",
                          color: m.rumorData.urgency === "CRITICAL" ? "var(--crit)" : "var(--calm)",
                        }}
                      >
                        {m.rumorData.urgency}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="text-[12px] text-muted leading-relaxed">
                  <span className="font-semibold text-fg block mb-0.5">Reasoning Analysis:</span>
                  <p>{m.rumorData.reasoning}</p>
                </div>

                {/* Autonomous Hedge Recommendation */}
                <div
                  className={`p-2.5 rounded-lg border flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-[11.5px] ${
                    m.rumorData.shouldHedge
                      ? "border-crit/30 bg-crit/10"
                      : "border-calm/30 bg-calm/10"
                  }`}
                >
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-1.5 font-bold text-fg">
                      <span>{m.rumorData.shouldHedge ? "🚨 Protective Put Recommended" : "✅ No Immediate Hedge Needed"}</span>
                      {m.rumorData.strikeSuggestion > 0 && (
                        <span className="font-mono px-1.5 py-0.2 rounded bg-panel border border-edge text-blue text-[11px]">
                          ${m.rumorData.strikeSuggestion.toLocaleString()} PUT
                        </span>
                      )}
                    </div>
                    <span className="text-muted">{m.rumorData.actionRationale}</span>
                  </div>

                  {m.rumorData.shouldHedge && onNavigateToHedge && (
                    <button
                      type="button"
                      onClick={() => onNavigateToHedge(m.rumorData?.strikeSuggestion)}
                      className="shrink-0 px-3 py-1.5 rounded-lg bg-crit text-white text-[11px] font-bold hover:brightness-110 transition shadow-xs"
                    >
                      Hedge on Base ⚡
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* WHAT-IF SIMULATION RESULT CARD */}
            {m.whatIfData && (
              <div className="mt-2 p-3 rounded-lg bg-panel border border-edge flex flex-col gap-2.5">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11.5px] bg-panel2 p-2 rounded-lg border border-edge">
                  <div>
                    <span className="text-faint block text-[10px]">Order</span>
                    <span className="font-bold text-fg num">
                      {m.whatIfData.parsedAction} ${m.whatIfData.parsedSizeM}M
                    </span>
                  </div>
                  <div>
                    <span className="text-faint block text-[10px]">Direct Move</span>
                    <span className="font-bold text-fg num">{fmtPct(m.whatIfData.initialMovePct)}</span>
                  </div>
                  <div>
                    <span className="text-faint block text-[10px]">Dealer Hedging</span>
                    <span
                      className="font-bold num"
                      style={{ color: m.whatIfData.amplification > 1.05 ? "var(--crit)" : "var(--calm)" }}
                    >
                      {fmtUsd(Math.abs(m.whatIfData.hedgeFlowUsd))}
                    </span>
                  </div>
                  <div>
                    <span className="text-faint block text-[10px]">Amplification</span>
                    <span
                      className="font-bold num"
                      style={{ color: m.whatIfData.amplification > 1.05 ? "var(--crit)" : "var(--calm)" }}
                    >
                      ×{m.whatIfData.amplification.toFixed(2)}
                    </span>
                  </div>
                </div>

                <div className="p-2.5 rounded-lg bg-blue/10 border border-blue/20 text-[11.5px] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-semibold text-blue text-[11px] uppercase tracking-wider">
                      Execution Strategy:
                    </span>
                    <p className="text-muted">{m.whatIfData.strategicAdvice}</p>
                  </div>
                  {m.whatIfData.amplification > 1.15 && onNavigateToHedge && (
                    <button
                      type="button"
                      onClick={() => onNavigateToHedge()}
                      className="shrink-0 px-3 py-1 text-[11px] font-bold rounded-lg bg-crit text-white hover:brightness-110 transition"
                    >
                      Hedge Downside 🛡️
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Gonka Trace Pill */}
            {m.gonkaRequestId && (
              <div className="flex items-center justify-between text-[10px] font-mono text-faint pt-0.5">
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
          <div className="flex items-center gap-2 p-3 rounded-xl bg-panel2 border border-edge text-[12px] text-muted self-start animate-pulse">
            <span className="size-3 rounded-full border-2 border-blue border-t-transparent animate-spin" />
            <span>Analyzing scenario with GonkaRouter multi-model AI…</span>
          </div>
        )}
      </div>

      {/* Input Area + Hovering Preset Pills */}
      <div className="flex flex-col gap-2 mt-auto">
        {/* Quick Suggestion Pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 feed-scroll">
          <span className="text-[11px] font-medium text-faint uppercase tracking-wider shrink-0">Try:</span>
          {activePills.map((pill, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => {
                setInput(pill);
                handleSend(pill);
              }}
              className="text-[11.5px] px-2.5 py-1 rounded-full bg-panel2 text-muted hover:bg-panel3 hover:text-fg transition whitespace-nowrap shrink-0 border border-edge"
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
            className="grow px-3.5 py-2 text-[13px] bg-panel2 border border-edge rounded-lg text-fg focus:outline-none focus:border-blue transition placeholder:text-faint"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="px-4 py-2 rounded-lg bg-blue text-white text-[13px] font-medium hover:brightness-110 active:scale-[0.98] transition disabled:opacity-40 shadow-xs"
          >
            {mode === "simulate" ? "Simulate" : "Verify"}
          </button>
        </form>
      </div>
    </section>
  );
}
