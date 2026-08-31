"use client";

import { useState } from "react";
import type { AssetSnapshot } from "@/lib/engine";
import { GONKA_MODELS, type FactCheckResult, type GonkaModelId } from "@/lib/gonka";

type Props = {
  snap: AssetSnapshot;
  onExecuteHedge?: (strike: number) => void;
};

const SAMPLE_HEADLINES = [
  "Whale dumping 25,000 ETH on DEX pools, triggering liquidation cascading warnings.",
  "SEC initiates immediate enforcement review against liquid staking derivative protocols.",
  "Major derivatives dealer caught in -50M short gamma gamma-flip breach zone.",
  "Institutional OTC desk reports $500M net buying inflow into Base ecosystem.",
];

export function FactChecker({ snap, onExecuteHedge }: Props) {
  const [headline, setHeadline] = useState(SAMPLE_HEADLINES[0]);
  const [model, setModel] = useState<GonkaModelId>(GONKA_MODELS.PRIMARY);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<FactCheckResult | null>(null);
  const [source, setSource] = useState<"gonka" | "deterministic" | null>(null);
  const [gonkaRequestId, setGonkaRequestId] = useState<string | null>(null);
  const [modelUsed, setModelUsed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleVerify = async (textToVerify = headline) => {
    if (!textToVerify.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/factcheck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          headline: textToVerify,
          asset: snap.asset,
          gexScore: snap.score,
          spotPrice: snap.spot,
          flipStrike: snap.flipStrike,
          netGexUsd: snap.netGexUsd,
          regime: snap.regime,
          model,
        }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `HTTP ${res.status}`);
      }

      const json = await res.json();
      setResult(json.data);
      setSource(json.source);
      setGonkaRequestId(json.gonkaRequestId);
      setModelUsed(json.modelUsed);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Verification request failed");
    } finally {
      setLoading(false);
    }
  };

  const copyRequestId = () => {
    if (!gonkaRequestId) return;
    navigator.clipboard.writeText(gonkaRequestId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const getUrgencyColor = (urgency?: string) => {
    switch (urgency) {
      case "CRITICAL":
        return "var(--crit)";
      case "HIGH":
        return "#f97316";
      case "MEDIUM":
        return "var(--warn)";
      default:
        return "var(--calm)";
    }
  };

  return (
    <section className="card p-5 flex flex-col gap-4 border-t border-edge" aria-label="GonkaRouter AI Fact Checker">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex size-2 rounded-full bg-blue animate-pulse" />
          <h2 className="text-[14px] font-semibold tracking-tight">
            GonkaRouter Multi-Model Verification & Truth Scoring
          </h2>
        </div>
        <span className="text-[10px] font-medium uppercase px-2 py-0.5 rounded-full border border-blue/20 bg-blue/10 text-blue">
          AI for Society Track
        </span>
      </div>

      <p className="text-[12px] text-muted leading-relaxed">
        Cross-verify breaking market rumors and viral panic headlines against deterministic dealer gamma exposure (GEX) mechanics to inform a manual protective decision.
      </p>

      {/* Preset Chips */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-faint uppercase tracking-wider">Test Sample Rumors:</span>
        <div className="flex flex-wrap gap-1.5">
          {SAMPLE_HEADLINES.map((sample, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => {
                setHeadline(sample);
                handleVerify(sample);
              }}
              className="text-[11.5px] px-2.5 py-1 rounded-md border border-edge bg-panel2 text-muted hover:text-fg hover:border-edge2 transition text-left"
            >
              {sample.length > 55 ? `${sample.slice(0, 52)}…` : sample}
            </button>
          ))}
        </div>
      </div>

      {/* Input & Model Selector */}
      <div className="flex flex-col gap-2.5 mt-1">
        <div className="flex gap-2">
          <input
            type="text"
            value={headline}
            onChange={(e) => setHeadline(e.target.value)}
            placeholder="Paste viral headline, rumor, or market panic tweet..."
            className="grow px-3.5 py-2 text-[13px] bg-panel2 border border-edge rounded-lg text-fg focus:outline-none focus:border-blue transition placeholder:text-faint"
          />
          <select
            value={model}
            onChange={(e) => setModel(e.target.value as GonkaModelId)}
            className="px-3 py-2 text-[12px] bg-panel2 border border-edge rounded-lg text-fg focus:outline-none focus:border-blue transition font-mono shrink-0"
            title="Select GonkaRouter AI Model"
          >
            <option value="MiniMaxAI/MiniMax-M2.7">MiniMax-M2.7 (Agent Native)</option>
            <option value="moonshotai/Kimi-K2.6">Kimi-K2.6 (Truth Verifier)</option>
            <option value="deepseek-ai/DeepSeek-V4-Flash-0731">DeepSeek-V4-Flash (Fast)</option>
          </select>
        </div>

        <button
          type="button"
          onClick={() => handleVerify()}
          disabled={loading || !headline.trim()}
          className={`h-9 px-4 rounded-lg text-[13px] font-medium transition flex items-center justify-center gap-2 ${
            loading
              ? "bg-blue/50 text-white cursor-wait"
              : "bg-blue text-white hover:brightness-110 active:scale-[0.99]"
          }`}
        >
          {loading ? (
            <>
              <span className="size-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              <span>Analyzing with {model.split("/")[1] || model}…</span>
            </>
          ) : (
            <>
              <span>⚡ Verify Rumor with Gonka Multi-Model AI</span>
            </>
          )}
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-lg border border-crit/30 bg-crit/10 text-crit text-[12px]">
          Verification Error: {error}
        </div>
      )}

      {/* Result Display */}
      {result && (
        <div className="mt-2 flex flex-col gap-3.5 p-4 rounded-xl border border-edge bg-panel2 animate-fade-in">
          {/* Top Score Banner */}
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-edge">
            <div className="flex items-center gap-3">
              <div className="flex flex-col items-center justify-center size-14 rounded-full border-2 border-edge bg-panel text-center">
                <span
                  className="num text-[18px] font-bold leading-none"
                  style={{ color: result.truthScore > 65 ? "var(--crit)" : "var(--calm)" }}
                >
                  {result.truthScore}%
                </span>
                <span className="text-[9px] text-faint uppercase font-medium mt-0.5">Truth</span>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-semibold text-fg">
                    {result.truthScore > 65 ? "⚠️ High Systemic Risk" : "🛡️ FUD / Low Impact"}
                  </span>
                  <span
                    className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                    style={{
                      color: getUrgencyColor(result.urgency),
                      background: `color-mix(in srgb, ${getUrgencyColor(result.urgency)} 15%, transparent)`,
                    }}
                  >
                    {result.urgency} URGENCY
                  </span>
                </div>
                <p className="text-[12px] text-muted mt-0.5">{result.verdict}</p>
              </div>
            </div>

            {source === "deterministic" ? (
              <span className="rounded-md border border-edge bg-panel px-2.5 py-1 text-[11px] font-mono text-faint">Deterministic fallback · no Gonka response</span>
            ) : gonkaRequestId ? (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-edge bg-panel text-[11px] font-mono text-muted">
                <span className="text-blue font-semibold">Gonka ID:</span>
                <span className="truncate max-w-[120px] sm:max-w-[180px]">{gonkaRequestId}</span>
                <button
                  type="button"
                  onClick={copyRequestId}
                  className="text-faint hover:text-fg transition ml-1"
                  title="Copy Gonka Request ID"
                >
                  {copied ? "✓ Copied" : "Copy"}
                </button>
              </div>
            ) : null}
          </div>

          {/* Reasoning Trace */}
          <div className="text-[12.5px] leading-relaxed text-muted flex flex-col gap-2">
            <div className="font-medium text-fg text-[12px]">{source === "gonka" ? "Quantitative AI reasoning:" : "Deterministic market-structure calculation:"}</div>
            <p className="whitespace-pre-line">{result.reasoning}</p>
            {result.marketRegimeAssessment && (
              <div className="p-2.5 rounded-lg bg-panel border border-edge text-[12px] text-faint">
                <span className="font-semibold text-fg">Market Structure: </span>
                {result.marketRegimeAssessment}
              </div>
            )}
          </div>

          {/* Autonomous Hedging Action Card */}
          <div
            className={`p-3.5 rounded-lg border flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 ${
              result.shouldHedge
                ? "border-crit/30 bg-crit/5"
                : "border-calm/30 bg-calm/5"
            }`}
          >
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <span
                  className="size-2 rounded-full"
                  style={{ background: result.shouldHedge ? "var(--crit)" : "var(--calm)" }}
                />
                <span className="text-[13px] font-semibold text-fg">
                  {source === "deterministic" ? "No executable recommendation" : result.shouldHedge ? "Protective PUT review suggested" : "No hedging suggested"}
                </span>
                {source === "gonka" && result.optimalContract && (
                  <span className="text-[11.5px] font-mono px-2 py-0.5 rounded bg-panel border border-edge font-medium text-blue">
                    Listed PUT strike: ${result.optimalContract.strike.toLocaleString()}
                  </span>
                )}
              </div>
              <p className="text-[11.5px] text-muted">{result.actionRationale}</p>
            </div>

            {source === "gonka" && result.shouldHedge && result.optimalContract && onExecuteHedge && (
              <button
                type="button"
                onClick={() => onExecuteHedge(result.optimalContract!.strike)}
                className="shrink-0 px-3.5 h-8 rounded-lg bg-crit text-white text-[12px] font-medium hover:brightness-110 transition shadow-sm"
              >
                Review live listed PUT
              </button>
            )}
          </div>

          {/* Model info footer */}
          <div className="flex items-center justify-between text-[10.5px] text-faint pt-1">
            <span>{source === "gonka" ? `Verified via ${modelUsed || model} on GonkaRouter Gateway` : "Deterministic output · no model call"}</span>
            {source === "gonka" && (
              <a
                href="https://gonkarouter.io"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue hover:underline"
              >
                gonkarouter.io ↗
              </a>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
