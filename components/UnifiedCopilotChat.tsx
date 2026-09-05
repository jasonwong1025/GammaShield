"use client";

import { useEffect, useRef, useState } from "react";
import type { AssetSnapshot } from "@/lib/engine";
import type { FactCheckResult } from "@/lib/gonka";
import type { KnowledgeResult } from "@/lib/knowledge";

type CopilotMode = "ask" | "rumor";

type Props = {
  snap: AssetSnapshot;
  isOpen?: boolean;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
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
  traces?: {
    stepName: string;
    model: string;
    requestId: string | null;
    score: number;
    perspective: string;
  }[];
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
  "https://coindesk.com/markets/sec-investigating-liquid-staking-protocols",
  "Derivatives dealer short gamma cascade alert",
];

const DEFAULT_WELCOME: ChatMessage = {
  id: "welcome",
  sender: "ai",
  mode: "ask",
  text: `👋 Hi! I'm your GammaShield Copilot. Ask any question about options mechanics, gamma risks, gas fees, or risk scores in plain English—or switch tabs to verify a market rumor via Gonka multi-model consensus.`,
  timestamp: Date.now(),
};

export function UnifiedCopilotChat({
  snap,
  isOpen = true,
  isExpanded = false,
  onToggleExpand,
  onNavigateToHedge,
  onClose,
  onProcessingChange,
  onNewAiMessage,
}: Props) {
  const [mode, setMode] = useState<CopilotMode>("ask");
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [copiedTraceId, setCopiedTraceId] = useState<string | null>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = sessionStorage.getItem(STORAGE_KEY);
        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
      } catch { }
    }
    return [DEFAULT_WELCOME];
  });

  // Sync chat history to sessionStorage so it persists across closes and navigation
  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
      } catch { }
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
      } catch { }
    }
  };

  const copyTrace = (id: string) => {
    navigator.clipboard.writeText(id);
    setCopiedTraceId(id);
    setTimeout(() => setCopiedTraceId(null), 2000);
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
        // Rumor Fact-Check Mode with Multi-Model Consensus & URL Extraction
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
          traces: data.traces || json.traces,
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
        text: `Unable to verify rumor: ${err instanceof Error ? err.message : "Network error"}`,
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
          {onToggleExpand && (
            <button
              type="button"
              onClick={onToggleExpand}
              title={isExpanded ? "Restore compact size" : "Expand window"}
              aria-label={isExpanded ? "Restore compact size" : "Expand window"}
              className="flex items-center justify-center size-7 rounded-lg text-faint hover:text-fg hover:bg-panel2 transition text-[13px]"
            >
              {isExpanded ? "🗗" : "⛶"}
            </button>
          )}

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
            className={`px-3 py-1 rounded-md text-[12px] font-medium transition ${mode === "ask"
                ? "bg-panel3 text-fg font-semibold shadow-xs"
                : "text-muted hover:text-fg"
              }`}
          >
            💡 Learn & Ask
          </button>
          <button
            type="button"
            onClick={() => setMode("rumor")}
            className={`px-3 py-1 rounded-md text-[12px] font-medium transition ${mode === "rumor"
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
            className={`flex flex-col gap-2 p-3.5 rounded-xl text-[12.5px] leading-relaxed transition ${m.sender === "user"
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

            {/* RUMOR FACT-CHECK RESULT CARD WITH MULTI-MODEL CONSENSUS */}
            {m.rumorData && (
              <div className="mt-2 p-3.5 rounded-lg bg-panel border border-edge flex flex-col gap-3">
                {/* Extracted URL / Tweet Source (if URL was submitted) */}
                {m.rumorData.extractedClaim?.isUrl && (
                  <div className="flex flex-col gap-1.5 p-2 rounded-lg bg-panel2 border border-edge text-[11.5px]">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-blue shrink-0">🔗 Source:</span>
                      {m.rumorData.extractedClaim.domain && (
                        <span className="font-mono text-[10.5px] px-2 py-0.5 rounded bg-panel border border-edge text-fg font-medium">
                          {m.rumorData.extractedClaim.domain}
                        </span>
                      )}
                      {m.rumorData.extractedClaim.originalUrl && (
                        <a
                          href={m.rumorData.extractedClaim.originalUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] text-muted hover:text-blue transition-colors flex items-center gap-1 ml-auto"
                        >
                          <span>Open link</span>
                          <span>↗</span>
                        </a>
                      )}
                    </div>
                    {m.rumorData.extractedClaim.warning && (
                      <div className="flex items-center gap-1.5 text-[11px] text-amber-500 font-medium bg-amber-500/10 px-2 py-1 rounded border border-amber-500/20">
                        <span>⚠️</span>
                        <span>{m.rumorData.extractedClaim.warning}</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Consensus Truth Score Header */}
                {(() => {
                  const isThreat = m.rumorData.urgency === "CRITICAL" || m.rumorData.urgency === "HIGH" || m.rumorData.shouldHedge;
                  const isVerified = m.rumorData.truthScore > 65;
                  const isDebunked = m.rumorData.truthScore <= 35;

                  let headerTitle = "⚠️ Unverified Narrative / Low Impact";
                  if (isVerified && isThreat) {
                    headerTitle = "🚨 High-Risk Shock Verified";
                  } else if (isVerified) {
                    headerTitle = "✅ Verified Market Catalyst";
                  } else if (isDebunked) {
                    headerTitle = "🛡️ Debunked FUD / False Rumor";
                  } else if (isThreat) {
                    headerTitle = "⚠️ Unconfirmed Threat / Precaution Advised";
                  }

                  const scoreColor = isThreat && isVerified
                    ? "var(--crit)"
                    : isVerified || isDebunked
                    ? "var(--calm)"
                    : "var(--warn)";

                  const urgencyConfig = {
                    CRITICAL: { bg: "rgba(216, 67, 59, 0.15)", color: "var(--crit)" },
                    HIGH: { bg: "rgba(216, 67, 59, 0.12)", color: "var(--crit)" },
                    MEDIUM: { bg: "rgba(200, 137, 26, 0.15)", color: "var(--warn)" },
                    LOW: { bg: "rgba(18, 160, 110, 0.15)", color: "var(--calm)" },
                  }[m.rumorData.urgency] || { bg: "rgba(18, 160, 110, 0.15)", color: "var(--calm)" };

                  return (
                    <div className="flex items-center justify-between gap-3 pb-2.5 border-b border-edge">
                      <div className="flex items-center gap-3">
                        <div className="flex flex-col items-center justify-center size-12 rounded-full border border-edge bg-panel2 text-center shrink-0 shadow-xs">
                          <span
                            className="num text-[15px] font-bold leading-none"
                            style={{ color: scoreColor }}
                          >
                            {m.rumorData.truthScore}%
                          </span>
                          <span className="text-[7.5px] text-faint font-bold uppercase mt-0.5 tracking-tight">Consensus</span>
                        </div>
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-bold text-[12.5px] text-fg">
                              {headerTitle}
                            </span>
                            <span
                              className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                              style={{
                                background: urgencyConfig.bg,
                                color: urgencyConfig.color,
                              }}
                            >
                              {m.rumorData.urgency}
                            </span>
                          </div>
                          <span className="text-[11px] text-muted">
                            {m.rumorData.consensusStatus === "STRONG"
                              ? `⚡ Strong Multi-Model Consensus (${m.rumorData.consensusAgreementPct}% alignment)`
                              : "⚡ Multi-Model Cross-Examination Verified"}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* Executive Verdict */}
                <div className="p-2.5 rounded-lg bg-panel2 border border-edge text-[12px] leading-relaxed">
                  <span className="font-semibold text-fg text-[11px] block mb-1">
                    Consensus Verdict:
                  </span>
                  <p className="text-muted">{m.rumorData.verdict}</p>
                </div>

                {/* Dual-Model Perspectives */}
                <div className="flex flex-col gap-2">
                  {/* Perspective A: Factual Verification */}
                  {m.rumorData.factualPerspective && (
                    <div className="p-2.5 rounded-lg bg-panel2 border border-edge text-[11.5px] flex flex-col gap-1">
                      <div className="flex items-center justify-between gap-1.5 font-semibold text-fg text-[11px]">
                        <div className="flex items-center gap-1.5">
                          <span>🔍</span>
                          <span>Factual News Veracity</span>
                        </div>
                        <span className="font-mono text-[10px] text-muted font-normal px-1.5 py-0.5 rounded bg-panel border border-edge shrink-0">
                          {(m.traces?.[0] || m.rumorData.traces?.[0])?.model?.split("/").pop() || "DeepSeek-Flash"}
                        </span>
                      </div>
                      <p className="text-muted leading-relaxed">{m.rumorData.factualPerspective}</p>
                    </div>
                  )}

                  {/* Perspective B: Quantitative GEX Feedback */}
                  {m.rumorData.marketPerspective && (
                    <div className="p-2.5 rounded-lg bg-panel2 border border-edge text-[11.5px] flex flex-col gap-1">
                      <div className="flex items-center justify-between gap-1.5 font-semibold text-fg text-[11px]">
                        <div className="flex items-center gap-1.5">
                          <span>📊</span>
                          <span>Dealer GEX & Hedging Feedback</span>
                        </div>
                        <span className="font-mono text-[10px] text-muted font-normal px-1.5 py-0.5 rounded bg-panel border border-edge shrink-0">
                          {(m.traces?.[1] || m.rumorData.traces?.[1])?.model?.split("/").pop() || "MiniMax-M2.7"}
                        </span>
                      </div>
                      <p className="text-muted leading-relaxed">{m.rumorData.marketPerspective}</p>
                    </div>
                  )}
                </div>

                {/* Real-Time Web Evidence Card (Tavily Search) */}
                {m.rumorData.webEvidence && m.rumorData.webEvidence.length > 0 && (
                  <div className="p-2.5 rounded-lg bg-panel2 border border-edge text-[11.5px] flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-1.5 pb-1 border-b border-edge/60">
                      <div className="flex items-center gap-1.5 font-semibold text-fg text-[11px]">
                        <span>🌐</span>
                        <span>Live Web Evidence</span>
                        <span className="text-[10px] text-faint font-normal">
                          ({m.rumorData.webEvidence.length} {m.rumorData.webEvidence.length === 1 ? "source" : "sources"})
                        </span>
                      </div>
                      <span className="font-mono text-[9px] text-blue font-medium px-1.5 py-0.5 rounded bg-blue/10 border border-blue/20">
                        Tavily Search
                      </span>
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      {m.rumorData.webEvidence.map((ev, eIdx) => (
                        <a
                          key={eIdx}
                          href={ev.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-panel border border-edge/80 hover:border-blue/50 hover:bg-panel2/60 transition-colors group text-[11px]"
                          title={ev.title}
                        >
                          <span className="font-medium text-fg group-hover:text-blue transition-colors truncate max-w-[200px]">
                            {ev.title}
                          </span>
                          {ev.domain && (
                            <span className="font-mono text-[9px] px-1.5 py-0.2 rounded bg-panel2 text-muted border border-edge shrink-0 font-normal">
                              {ev.domain}
                            </span>
                          )}
                          <span className="text-[10px] text-faint group-hover:text-blue shrink-0">↗</span>
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                {/* Autonomous Hedge Recommendation */}
                <div
                  className={`p-2.5 rounded-lg border flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-[11.5px] ${m.rumorData.shouldHedge
                      ? "border-crit/30 bg-crit/10"
                      : "border-calm/30 bg-calm/10"
                    }`}
                >
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-1.5 font-bold text-fg">
                      <span>{m.source === "deterministic" ? "No executable recommendation" : m.rumorData.shouldHedge ? "🚨 Protective PUT review suggested" : "✅ No immediate hedge suggested"}</span>
                      {(m.source === "gonka" || m.source === "ai") && m.rumorData.shouldHedge && m.rumorData.optimalContract && (
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

                {/* Gonka Network Multi-Model Transparency Trace Panel */}
                {(m.traces || m.rumorData.traces) && (
                  <div className="mt-0.5 p-2.5 rounded-lg bg-panel2/70 border border-edge flex flex-col gap-1.5 text-[11px]">
                    <div className="flex items-center justify-between text-faint pb-1 border-b border-edge/60">
                      <span className="font-semibold text-fg text-[10.5px] uppercase tracking-wider flex items-center gap-1.5">
                        <span className="size-1.5 rounded-full bg-blue shrink-0" />
                        Gonka Network Multi-Model Inference Trace
                      </span>
                      <span className="text-[9.5px] font-mono text-muted">Gateway: gonkarouter.io</span>
                    </div>

                    <div className="flex flex-col gap-1 pt-0.5">
                      {(m.traces || m.rumorData.traces)?.map((step, sIdx) => (
                        <div
                          key={sIdx}
                          className="flex items-center justify-between gap-2 p-1.5 rounded bg-panel border border-edge text-[10.5px]"
                        >
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="font-medium text-fg truncate">{step.stepName}:</span>
                            <span className="font-mono text-muted text-[10px] truncate max-w-[120px]" title={step.model}>
                              {step.model.split("/").pop()}
                            </span>
                          </div>

                          {step.requestId ? (
                            <div className="flex items-center gap-1.5 shrink-0 font-mono text-[10px]">
                              <span className="text-faint truncate max-w-[110px]" title={step.requestId}>
                                {step.requestId.length > 18 ? `${step.requestId.slice(0, 16)}…` : step.requestId}
                              </span>
                              <button
                                type="button"
                                onClick={() => copyTrace(step.requestId!)}
                                className="px-1.5 py-0.5 rounded bg-panel2 text-blue hover:text-fg hover:bg-panel3 transition font-sans font-medium text-[9.5px]"
                              >
                                {copiedTraceId === step.requestId ? "✓ Copied" : "Copy ID"}
                              </button>
                            </div>
                          ) : (
                            <span className="text-faint font-mono text-[10px]">Local consensus</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="flex items-center gap-2 p-3 rounded-xl bg-panel2 border border-edge text-[12px] text-muted self-start animate-pulse">
            <span className="size-3 rounded-full border-2 border-blue border-t-transparent animate-spin" />
            <span>
              {mode === "ask"
                ? "Explaining market concepts with GammaShield Copilot…"
                : "Running Gonka Multi-Model Consensus…"}
            </span>
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
