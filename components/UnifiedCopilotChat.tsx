"use client";

import { useEffect, useRef, useState } from "react";
import type { AssetSnapshot } from "@/lib/engine";
import type { FactCheckResult } from "@/lib/gonka";
import type { KnowledgeResult } from "@/lib/knowledge";

type CopilotMode = "ask" | "rumor";

type Props = {
  snap: AssetSnapshot;
  isOpen?: boolean;
  onNavigateToHedge?: (strike?: number) => void;
  onClose?: () => void;
  onProcessingChange?: (loading: boolean) => void;
  onNewAiMessage?: () => void;
};

type ChatMessage = {
  id: string;
  sender: "user" | "ai";
  mode: CopilotMode;
  text: string;
  rumorData?: FactCheckResult;
  knowledgeData?: KnowledgeResult;
  source?: "ai" | "gonka" | "deterministic";
  modelUsed?: string | null;
  timestamp: number;
};

const STORAGE_KEY = "gammashield_copilot_history";

const ASK_PILLS = [
  "What is Gamma and why is it dangerous for traders?",
  "What does the 0–100 Risk Score actually mean?",
  "What is a gas fee and why does it fluctuate on Base?",
  "What is the difference between buying a Put vs Call?",
];

const RUMOR_PILLS = [
  "Whale moving 50,000 ETH to exchange, crash imminent!",
  "SEC investigating liquid staking derivative protocols",
  "Derivatives dealer short gamma cascade alert",
];

const DEFAULT_WELCOME: ChatMessage = {
  id: "welcome",
  sender: "ai",
  mode: "ask",
  text: `👋 Hi! I'm your GammaShield Copilot. Ask any question about options mechanics, gamma risks, gas fees, or risk scores in plain English—or switch tabs to verify a market rumor.`,
  timestamp: Date.now(),
};

export function UnifiedCopilotChat({
  snap,
  isOpen = true,
  onNavigateToHedge,
  onClose,
  onProcessingChange,
  onNewAiMessage,
}: Props) {
  const [mode, setMode] = useState<CopilotMode>("ask");
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = sessionStorage.getItem(STORAGE_KEY);
        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
      } catch {}
    }
    return [DEFAULT_WELCOME];
  });

  // Sync chat history to sessionStorage so it persists across closes and navigation
  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
      } catch {}
    }
  }, [messages]);

  // Auto-scroll to bottom whenever messages update or dialog is opened
  useEffect(() => {
    if (isOpen && chatScrollRef.current) {
      chatScrollRef.current.scrollTo({
        top: chatScrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [messages, loading, isOpen]);

  const activePills = mode === "ask" ? ASK_PILLS : RUMOR_PILLS;

  const updateLoading = (val: boolean) => {
    setLoading(val);
    onProcessingChange?.(val);
  };

  const handleClearHistory = () => {
    const fresh = [{ ...DEFAULT_WELCOME, timestamp: Date.now() }];
    setMessages(fresh);
    if (typeof window !== "undefined") {
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
      } catch {}
    }
  };

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
    updateLoading(true);

    try {
      if (mode === "ask") {
        const res = await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question: textToSend,
            asset: snap.asset,
            spotPrice: snap.spot,
            score: snap.score,
            netGexUsd: snap.netGexUsd,
            regime: snap.regime,
            flipStrike: snap.flipStrike,
          }),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: KnowledgeResult = await res.json();

        const aiMessage: ChatMessage = {
          id: `ai_${Date.now()}`,
          sender: "ai",
          mode: "ask",
          text: data.summary,
          knowledgeData: data,
          source: data.source,
          modelUsed: data.modelUsed,
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, aiMessage]);
        onNewAiMessage?.();
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
          source: json.source,
          modelUsed: json.modelUsed,
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, aiMessage]);
        onNewAiMessage?.();
      }
    } catch (err) {
      const errMsg: ChatMessage = {
        id: `err_${Date.now()}`,
        sender: "ai",
        mode,
        text: `Unable to get answer: ${err instanceof Error ? err.message : "Network error"}`,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, errMsg]);
      onNewAiMessage?.();
    } finally {
      updateLoading(false);
    }
  };

  return (
    <section className="flex flex-col gap-3 h-full min-h-0 p-4" aria-label="GammaShield Copilot">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 pb-3 border-b border-edge">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="live-dot inline-block size-2 rounded-full bg-blue shrink-0" />
            <h2 className="text-[14px] font-semibold text-fg tracking-tight truncate">GammaShield Copilot</h2>
          </div>
          <p className="text-[11px] text-muted mt-0.5 leading-snug">
            Ask any question about options, gamma risk, gas fees, or your risk score in plain English.
          </p>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {messages.length > 1 && (
            <button
              type="button"
              onClick={handleClearHistory}
              title="Clear chat history"
              aria-label="Clear chat history"
              className="flex items-center justify-center size-7 rounded-lg text-faint hover:text-fg hover:bg-panel2 transition text-[11px]"
            >
              🗑️
            </button>
          )}

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close copilot"
              className="flex items-center justify-center size-7 rounded-lg text-faint hover:text-fg hover:bg-panel2 transition"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Mode Switcher Pills */}
      <div className="flex items-center gap-2">
        <div className="flex p-0.5 rounded-lg bg-panel2 border border-edge shrink-0">
          <button
            type="button"
            onClick={() => setMode("ask")}
            className={`px-3 py-1 rounded-md text-[12px] font-medium transition ${
              mode === "ask"
                ? "bg-panel3 text-fg font-semibold shadow-xs"
                : "text-muted hover:text-fg"
            }`}
          >
            💡 Learn & Ask
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
            🔍 Verify Rumor
          </button>
        </div>
      </div>

      {/* Messages Stream */}
      <div
        ref={chatScrollRef}
        className="grow flex flex-col gap-3 min-h-0 overflow-y-auto pr-1 feed-scroll"
      >
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
                      {m.mode === "ask" ? "GammaShield Copilot" : "Market Fact-Checker"}
                    </span>
                    {m.modelUsed && (
                      <span className="text-[10px] text-faint font-normal">
                        · {m.modelUsed}
                      </span>
                    )}
                  </>
                )}
              </span>
              <span>{new Date(m.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            </div>

            <p className="whitespace-pre-line">{m.text}</p>

            {/* KNOWLEDGE RESULT STRUCTURED CARD */}
            {m.knowledgeData && (
              <div className="mt-1.5 p-3 rounded-lg bg-panel border border-edge flex flex-col gap-2.5">
                {/* Quick Summary */}
                <div className="p-2.5 rounded-lg bg-blue/10 border border-blue/20 text-[12px]">
                  <span className="font-bold text-blue text-[10.5px] uppercase tracking-wider block mb-1">
                    ⚡ Quick Summary
                  </span>
                  <p className="text-fg font-medium leading-relaxed">{m.knowledgeData.summary}</p>
                </div>

                {/* Everyday Analogy */}
                <div className="p-2.5 rounded-lg bg-panel2 border border-edge text-[12px]">
                  <span className="font-semibold text-fg text-[11px] block mb-1 flex items-center gap-1.5">
                    <span>🚗</span> Everyday Analogy
                  </span>
                  <p className="text-muted leading-relaxed">{m.knowledgeData.analogy}</p>
                </div>

                {/* Plain-English Breakdown */}
                {m.knowledgeData.explanation && (
                  <div className="text-[12px] text-muted leading-relaxed px-0.5">
                    <p>{m.knowledgeData.explanation}</p>
                  </div>
                )}

                {/* Trader Takeaway */}
                <div className="p-2.5 rounded-lg bg-panel2 border border-edge text-[11.5px] flex items-start gap-2">
                  <span className="text-[14px] leading-none shrink-0 mt-0.5">💡</span>
                  <div className="flex flex-col gap-0.5">
                    <span className="font-semibold text-fg text-[10.5px] uppercase tracking-wider">
                      Trader Takeaway
                    </span>
                    <p className="text-muted leading-relaxed">{m.knowledgeData.takeaway}</p>
                  </div>
                </div>

                {/* Live Context Badge */}
                {m.knowledgeData.liveContext && (
                  <div className="text-[10.5px] text-faint flex items-center gap-1.5 pt-1 border-t border-edge/60">
                    <span className="size-1.5 rounded-full bg-blue shrink-0" />
                    <span>Live context: {m.knowledgeData.liveContext}</span>
                  </div>
                )}
              </div>
            )}

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
                  <span className="font-semibold text-fg block mb-0.5">
                    {m.source === "gonka" || m.source === "ai" ? "Quantitative AI reasoning:" : "Deterministic market-structure calculation:"}
                  </span>
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
                      <span>{m.source === "deterministic" ? "No executable recommendation" : m.rumorData.shouldHedge ? "🚨 Protective PUT review suggested" : "✅ No immediate hedge suggested"}</span>
                      {(m.source === "gonka" || m.source === "ai") && m.rumorData.optimalContract && (
                        <span className="font-mono px-1.5 py-0.2 rounded bg-panel border border-edge text-blue text-[11px]">
                          ${m.rumorData.optimalContract.strike.toLocaleString()} PUT
                        </span>
                      )}
                    </div>
                    <span className="text-muted">{m.rumorData.actionRationale}</span>
                  </div>

                  {(m.source === "gonka" || m.source === "ai") && m.rumorData.shouldHedge && m.rumorData.optimalContract && onNavigateToHedge && (
                    <button
                      type="button"
                      onClick={() => onNavigateToHedge(m.rumorData?.optimalContract?.strike)}
                      className="shrink-0 px-3 py-1.5 rounded-lg bg-crit text-white text-[11px] font-bold hover:brightness-110 transition shadow-xs"
                    >
                      Review live order
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="flex items-center gap-2 p-3 rounded-xl bg-panel2 border border-edge text-[12px] text-muted self-start animate-pulse">
            <span className="size-3 rounded-full border-2 border-blue border-t-transparent animate-spin" />
            <span>Explaining market concepts with GammaShield Copilot…</span>
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
              {pill.length > 42 ? `${pill.slice(0, 40)}…` : pill}
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
              mode === "ask"
                ? `Ask about options (e.g., 'What is gamma?', 'Explain my risk score')...`
                : `Paste a market rumor or viral tweet to fact-check...`
            }
            className="grow px-3.5 py-2 text-[13px] bg-panel2 border border-edge rounded-lg text-fg focus:outline-none focus:border-blue transition placeholder:text-faint"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="px-4 py-2 rounded-lg bg-blue text-white text-[13px] font-medium hover:brightness-110 active:scale-[0.98] transition disabled:opacity-40 shadow-xs"
          >
            {mode === "ask" ? "Ask" : "Verify"}
          </button>
        </form>
      </div>
    </section>
  );
}
