"use client";

import { useState } from "react";
import type { AssetSnapshot } from "@/lib/engine";
import { fmtPct, fmtUsd } from "@/lib/format";
import type { WhatIfResult } from "@/lib/gonka";

type Props = {
  snap: AssetSnapshot;
  onNavigateToHedge?: () => void;
};

const SAMPLE_QUERIES = [
  "What is the market impact if I market-sell $5M of ETH right now?",
  "What happens if a whale dumps $25M on the orderbook?",
  "If an institution buys $50M, how much will dealers delta-hedge?",
];

type Message = {
  id: string;
  sender: "user" | "ai";
  text: string;
  data?: WhatIfResult;
  timestamp: number;
};

export function WhatIfChat({ snap, onNavigateToHedge }: Props) {
  const [input, setInput] = useState(SAMPLE_QUERIES[0]);
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<Message[]>(() => [
    {
      id: "welcome",
      sender: "ai",
      text: `Hello! I'm your Gonka Quantitative Risk Copilot. Ask me any "What-If" trade scenario on ${snap.asset} (e.g. "What if I sell $5M ETH right now?"), and I'll calculate the exact market impact and dealer hedging feedback loop.`,
      timestamp: Date.now(),
    },
  ]);

  const handleSend = async (queryText = input) => {
    if (!queryText.trim()) return;

    const userMsg: Message = {
      id: `user_${Date.now()}`,
      sender: "user",
      text: queryText,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/whatif", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: queryText,
          asset: snap.asset,
          spotPrice: snap.spot,
          score: snap.score,
          netGexUsd: snap.netGexUsd,
          regime: snap.regime,
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: WhatIfResult = await res.json();

      const aiMsg: Message = {
        id: `ai_${Date.now()}`,
        sender: "ai",
        text: data.conversationalAnswer,
        data,
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, aiMsg]);
    } catch (e) {
      const errMsg: Message = {
        id: `err_${Date.now()}`,
        sender: "ai",
        text: `Error analyzing scenario: ${e instanceof Error ? e.message : "Network error"}`,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, errMsg]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="card p-5 flex flex-col gap-4 border border-edge rounded-xl" aria-label="What-If Scenario Chat">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-edge">
        <div className="flex items-center gap-2">
          <span className="flex size-2 rounded-full bg-calm" />
          <h2 className="text-[14px] font-semibold tracking-tight">
            Scenario Simulator (&quot;What-If&quot; Copilot)
          </h2>
        </div>
        <div className="flex items-center gap-2 text-[11px] font-mono text-muted">
          <span>Active Asset:</span>
          <span className="font-semibold text-fg px-2 py-0.5 rounded bg-panel2 border border-edge">
            {snap.asset} (${snap.spot.toLocaleString()})
          </span>
        </div>
      </div>

      {/* Preset Query Chips */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-faint uppercase tracking-wider">Example Questions:</span>
        <div className="flex flex-wrap gap-1.5">
          {SAMPLE_QUERIES.map((query, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => {
                setInput(query);
                handleSend(query);
              }}
              className="text-[11.5px] px-2.5 py-1 rounded-md border border-edge bg-panel2 text-muted hover:text-fg hover:border-edge2 transition text-left"
            >
              {query}
            </button>
          ))}
        </div>
      </div>

      {/* Chat Messages Log */}
      <div className="flex flex-col gap-3 max-h-[380px] overflow-y-auto pr-1 feed-scroll">
        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex flex-col gap-2 p-3.5 rounded-xl text-[12.5px] leading-relaxed transition ${
              m.sender === "user"
                ? "bg-bluesoft/70 border border-blue/20 text-fg ml-8 self-end"
                : "bg-panel2 border border-edge text-fg mr-4 self-start"
            }`}
          >
            <div className="flex items-center justify-between gap-3 text-[11px] font-medium text-faint">
              <span>{m.sender === "user" ? "You" : "🤖 Gonka Quantitative Copilot"}</span>
              <span className="text-[10px]">
                {new Date(m.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>

            <p className="whitespace-pre-line">{m.text}</p>

            {/* Quantitative Breakdown Card for AI responses */}
            {m.data && (
              <div className="mt-2 pt-2 border-t border-edge flex flex-col gap-2">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11.5px] bg-panel p-2.5 rounded-lg border border-edge">
                  <div>
                    <span className="text-faint block">Simulated Order</span>
                    <span className="font-semibold text-fg num">
                      {m.data.parsedAction} ${m.data.parsedSizeM}M
                    </span>
                  </div>
                  <div>
                    <span className="text-faint block">Direct Impact</span>
                    <span className="font-semibold text-fg num">
                      {fmtPct(m.data.initialMovePct)}
                    </span>
                  </div>
                  <div>
                    <span className="text-faint block">Dealer Hedging</span>
                    <span
                      className="font-semibold num"
                      style={{ color: m.data.amplification > 1.05 ? "var(--crit)" : "var(--calm)" }}
                    >
                      {fmtUsd(Math.abs(m.data.hedgeFlowUsd))}
                    </span>
                  </div>
                  <div>
                    <span className="text-faint block">Amplification</span>
                    <span
                      className="font-semibold num"
                      style={{ color: m.data.amplification > 1.05 ? "var(--crit)" : "var(--calm)" }}
                    >
                      ×{m.data.amplification.toFixed(2)}
                    </span>
                  </div>
                </div>

                <div className="p-2.5 rounded-lg bg-blue/5 border border-blue/15 text-[12px] text-muted flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-semibold text-fg text-[11px] uppercase tracking-wider text-blue">
                      Strategic Risk Advice:
                    </span>
                    <p className="text-[11.5px]">{m.data.strategicAdvice}</p>
                  </div>
                  {m.data.source === "gonka" && m.data.amplification > 1.15 && m.data.optimalContract && onNavigateToHedge && (
                    <button
                      type="button"
                      onClick={onNavigateToHedge}
                      className="shrink-0 px-3 py-1 text-[11.5px] font-medium rounded-md bg-crit text-white hover:brightness-110 transition"
                    >
                      Review live order
                    </button>
                  )}
                </div>

                <div className="text-[10px] font-mono text-faint flex items-center justify-between pt-0.5">
                  {m.data.source === "gonka" ? <><span>Gonka Trace ID: {m.data.gonkaRequestId}</span><span>Model: {m.data.modelUsed}</span></> : <span>Deterministic market-impact calculation · no model call</span>}
                </div>
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="flex items-center gap-2 p-3 rounded-xl bg-panel2 border border-edge text-[12px] text-muted self-start animate-pulse">
            <span className="size-3 rounded-full border-2 border-blue border-t-transparent animate-spin" />
            <span>Calculating dealer gamma impact with GonkaRouter…</span>
          </div>
        )}
      </div>

      {/* Input Form */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSend();
        }}
        className="flex gap-2 mt-1"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a trade scenario (e.g. 'What if I sell $10M ETH?')..."
          className="grow px-3.5 py-2.5 text-[13px] bg-panel2 border border-edge rounded-lg text-fg focus:outline-none focus:border-blue transition placeholder:text-faint"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="px-5 py-2.5 rounded-lg bg-blue text-white text-[13px] font-medium hover:brightness-110 active:scale-[0.98] transition disabled:opacity-50"
        >
          Ask Copilot
        </button>
      </form>
    </section>
  );
}
