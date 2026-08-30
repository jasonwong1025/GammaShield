"use client";

import { useEffect, useState, useCallback } from "react";
import type { AssetSnapshot } from "@/lib/engine";
import type { HedgeResult, AutopilotStatus } from "@/lib/hedge";
import type { OptimalHedgeRecommendation, PutCandidate } from "@/lib/optimizerTypes";

type Props = {
  snap: AssetSnapshot;
  initialStrike?: number;
};

type WalletInfo = {
  configured: boolean;
  address?: string | null;
  ethBalance?: string;
  usdcBalance?: string;
  chainId?: number;
  rpcUrl?: string;
  autopilot?: AutopilotStatus;
};

export function ExecutionTerminal({ snap, initialStrike }: Props) {
  const [strike, setStrike] = useState<number>(initialStrike || snap.flipStrike || Math.round(snap.spot * 0.95));
  const amountUsdc = 1;
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<HedgeResult | null>(null);
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"copilot" | "autopilot">("copilot");
  const [optimizerData, setOptimizerData] = useState<OptimalHedgeRecommendation | null>(null);
  const [optimizerLoading, setOptimizerLoading] = useState(true);

  const [terminalLogs, setTerminalLogs] = useState<string[]>([
    `[SYS] Thetanuts V4 SDK client ready on Base Mainnet (Chain ID 8453).`,
    `[SYS] Intelligent Strike Optimizer active. Monitoring Net GEX ($${snap.netGexUsd ? snap.netGexUsd.toLocaleString() : "0"}) and Gamma Flip ($${snap.flipStrike || Math.round(snap.spot * 0.95)}).`,
    `[SYS] Hardcoded Guardrails: 5.00 USDC cap per execution · 60m cooldown · 15.00 USDC daily limit.`,
  ]);

  const isHighRisk = snap.score >= 70 || snap.regime === "amplifying";

  const refreshWallet = useCallback(() => {
    fetch("/api/hedge")
      .then((r) => r.json())
      .then((d: WalletInfo) => {
        setWallet(d);
        if (d.autopilot?.enabled) {
          setMode("autopilot");
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let ignore = false;
    fetch("/api/hedge")
      .then((r) => r.json())
      .then((d: WalletInfo) => {
        if (!ignore) {
          setWallet(d);
          if (d.autopilot?.enabled) {
            setMode("autopilot");
          }
        }
      })
      .catch(() => {});

    fetch(`/api/optimize?asset=${snap.asset}&spot=${snap.spot}`)
      .then((r) => r.json())
      .then((d: OptimalHedgeRecommendation) => {
        if (!ignore) {
          setOptimizerData(d);
          if (d.optimalContract) {
            setStrike(d.optimalContract.strike);
          }
          setOptimizerLoading(false);
        }
      })
      .catch(() => {
        if (!ignore) setOptimizerLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [snap.asset, snap.spot]);

  // Autopilot toggle handler
  const handleToggleAutopilot = async (newEnabled: boolean) => {
    try {
      const res = await fetch("/api/hedge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "toggleAutopilot",
          enabled: newEnabled,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setMode(newEnabled ? "autopilot" : "copilot");
        refreshWallet();
        const time = new Date().toLocaleTimeString();
        setTerminalLogs((prev) => [
          ...prev,
          `[${time}] 🛡️ Autopilot Mode ${newEnabled ? "ACTIVATED: Autonomous on-chain protection enabled" : "DEACTIVATED: Manual Copilot mode active"}.`,
        ]);
      }
    } catch {
      setError("Failed to toggle autopilot");
    }
  };

  // Copilot 1-Click Manual Execution
  const handleExecute = async () => {
    setLoading(true);
    setError(null);
    const time = new Date().toLocaleTimeString();
    setTerminalLogs((prev) => [
      ...prev,
      `--------------------------------------------------`,
      `[${time}] 🚀 Initiating 1-Click Protective Put on Base Mainnet for ${snap.asset}...`,
      `[${time}] 🎯 Selected Strike: $${strike.toLocaleString()} PUT | Allocation: ${amountUsdc} USDC`,
    ]);

    try {
      const res = await fetch("/api/hedge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          asset: snap.asset,
          targetStrike: strike,
          amountUsdc,
        }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `HTTP ${res.status}`);
      }

      const data: HedgeResult = await res.json();
      setResult(data);
      if (data.logs && data.logs.length) {
        setTerminalLogs((prev) => [...prev, ...data.logs]);
      }
      refreshWallet();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Execution failed";
      setError(msg);
      setTerminalLogs((prev) => [...prev, `[ERR] ❌ Execution stopped: ${msg}`]);
    } finally {
      setLoading(false);
    }
  };

  const optimal: PutCandidate | null = optimizerData?.optimalContract || null;

  return (
    <section className="card p-5 flex flex-col gap-4" aria-label="Autonomous Thetanuts Execution Engine">
      {/* Alert Header Banner */}
      <div
        className={`p-4 rounded-xl border flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 transition ${
          isHighRisk
            ? "border-crit/40 bg-crit/10"
            : "border-blue/30 bg-blue/5"
        }`}
      >
        <div className="flex items-center gap-3">
          <div
            className={`flex size-10 items-center justify-center rounded-xl text-[18px] shrink-0 ${
              isHighRisk ? "bg-crit/20 text-crit animate-pulse" : "bg-blue/20 text-blue"
            }`}
          >
            {isHighRisk ? "⚠️" : "🛡️"}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-[14px] font-bold text-fg">
                {isHighRisk
                  ? `High Fragility Alert (Score: ${snap.score}/100)`
                  : `Portfolio Protection Defender Ready`}
              </h2>
              <span
                className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
                  isHighRisk ? "bg-crit text-white" : "bg-blue text-white"
                }`}
              >
                {snap.regime.toUpperCase()}
              </span>
            </div>
            <p className="text-[12px] text-muted mt-0.5">
              {isHighRisk
                ? "Dealers are in amplifier mode. A protective Put locks in floor liquidity before cascade liquidations."
                : "OptionBook smart contract routing active on Base Mainnet (Chain ID 8453)."}
            </p>
          </div>
        </div>

        {/* Mode Switcher Buttons */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex p-0.5 rounded-lg bg-panel border border-edge">
            <button
              type="button"
              onClick={() => handleToggleAutopilot(false)}
              className={`px-3 py-1.5 rounded-md text-[11.5px] font-medium transition ${
                mode === "copilot"
                  ? "bg-panel2 text-fg font-semibold shadow-xs"
                  : "text-muted hover:text-fg"
              }`}
            >
              ✋ Copilot (1-Click)
            </button>
            <button
              type="button"
              onClick={() => handleToggleAutopilot(true)}
              className={`px-3 py-1.5 rounded-md text-[11.5px] font-medium transition flex items-center gap-1.5 ${
                mode === "autopilot"
                  ? "bg-crit text-white font-semibold shadow-xs"
                  : "text-muted hover:text-fg"
              }`}
            >
              <span>🤖 Autopilot</span>
              <span className="size-1.5 rounded-full bg-white animate-pulse" />
            </button>
          </div>

          {mode === "copilot" && (
            <button
              type="button"
              onClick={handleExecute}
              disabled={loading}
              className={`h-9 px-4 rounded-lg text-[13px] font-medium transition flex items-center gap-2 ${
                loading
                  ? "bg-crit/50 text-white cursor-wait"
                  : isHighRisk
                  ? "bg-crit text-white hover:brightness-110 active:scale-[0.98]"
                  : "bg-blue text-white hover:brightness-110 active:scale-[0.98]"
              }`}
            >
              {loading ? (
                <>
                  <span className="size-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>Executing on Base…</span>
                </>
              ) : (
                <span>⚡ Confirm & Execute (~1 USDC)</span>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Intelligent Strike Optimizer Card */}
      <div className="p-4 rounded-xl border border-blue/20 bg-blue/5 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[14px]">🧠</span>
            <h3 className="text-[13px] font-bold text-fg">Intelligent Strike & Expiry Optimizer</h3>
            <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-blue/15 text-blue font-semibold">
              Cost-to-Protection Engine
            </span>
          </div>
          {optimal && (
            <span className="text-[11px] font-mono text-muted">
              Efficiency Score: <strong className="text-blue num font-bold">{optimal.efficiencyScore}</strong> / 10
            </span>
          )}
        </div>

        {optimizerLoading ? (
          <div className="flex items-center gap-2 text-[12px] text-muted py-2">
            <span className="size-3 rounded-full border-2 border-blue border-t-transparent animate-spin" />
            <span>Scanning live OptionBook on Base for optimal protection ratio…</span>
          </div>
        ) : optimal ? (
          <div className="flex flex-col gap-2.5">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11.5px] bg-panel p-2.5 rounded-lg border border-edge">
              <div>
                <span className="text-faint block text-[10px]">Optimal Strike</span>
                <span className="font-bold text-fg num text-[13px]">${optimal.strike.toLocaleString()} PUT</span>
              </div>
              <div>
                <span className="text-faint block text-[10px]">Tail-Risk Coverage</span>
                <span className="font-bold text-calm num text-[13px]">{optimal.protectionCoveragePct}% Protection</span>
              </div>
              <div>
                <span className="text-faint block text-[10px]">Target Expiry</span>
                <span className="font-bold text-fg num text-[13px]">{optimal.daysToExpiry} Days</span>
              </div>
              <div>
                <span className="text-faint block text-[10px]">Estimated Cost</span>
                <span className="font-bold text-blue num text-[13px]">~{optimal.estCostUsdc} USDC</span>
              </div>
            </div>

            <p className="text-[12px] text-muted leading-relaxed">
              <strong className="text-fg font-medium">Quantitative Rationale: </strong>
              {optimizerData?.quantitativeRationale}
            </p>
          </div>
        ) : (
          <p className="text-[12px] text-muted">No live orderbook rows available to optimize. Using default protection strike.</p>
        )}
      </div>

      {/* Guardrails & Wallet Parameters */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="p-3.5 rounded-lg border border-edge bg-panel2 flex flex-col gap-1">
          <span className="text-[11px] font-medium text-faint uppercase">Active Mode & Defense</span>
          <div className="flex items-center gap-2">
            <span
              className={`size-2 rounded-full ${
                mode === "autopilot" ? "bg-crit animate-ping" : "bg-blue"
              }`}
            />
            <span className="text-[13px] font-bold text-fg">
              {mode === "autopilot" ? "🤖 Autopilot (Active)" : "✋ Copilot (1-Click)"}
            </span>
          </div>
          <span className="text-[11px] text-muted">
            {mode === "autopilot"
              ? "Autonomous on-chain defense when Risk ≥ 75"
              : "Manual human confirmation required"}
          </span>
        </div>

        <div className="p-3.5 rounded-lg border border-edge bg-panel2 flex flex-col gap-1">
          <span className="text-[11px] font-medium text-faint uppercase">Hardcoded Guardrails</span>
          <div className="flex items-center gap-2 text-[12px] font-mono text-fg font-semibold">
            <span>Cap: $5.00 USDC</span>
            <span className="text-faint">·</span>
            <span>60m Cooldown</span>
          </div>
          <span className="text-[11px] text-muted num">
            Daily Spend: ${wallet?.autopilot?.dailySpendUsdc?.toFixed(2) || "0.00"} / $15.00 USDC
          </span>
        </div>

        <div className="p-3.5 rounded-lg border border-edge bg-panel2 flex flex-col gap-1">
          <span className="text-[11px] font-medium text-faint uppercase">Burner Wallet (Base Mainnet)</span>
          <div className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-calm" />
            <span className="text-[12px] font-mono text-fg font-medium truncate">
              {wallet?.address
                ? `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`
                : "Active Signer Loaded"}
            </span>
          </div>
          <span className="text-[11px] text-muted num">
            Gas: {wallet?.ethBalance ? `${parseFloat(wallet.ethBalance).toFixed(4)} ETH` : "~0.005 ETH"} · USDC: {wallet?.usdcBalance || "2.00"}
          </span>
        </div>
      </div>

      {/* Confirmed Transaction Card */}
      {result && (
        <div className="p-3.5 rounded-lg border border-calm/40 bg-calm/10 flex flex-col gap-2.5 animate-fade-in">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="flex size-2.5 rounded-full bg-calm" />
              <span className="text-[13.5px] font-bold text-fg">
                ✅ Protective Put Option Confirmed on Base Mainnet ({result.isAutopilot ? "Autopilot" : "Copilot"})
              </span>
            </div>
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-panel border border-calm/30 text-calm font-semibold">
              Block #{result.blockNumber}
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11.5px] pt-1">
            <div>
              <span className="text-faint block text-[10.5px]">Contract</span>
              <span className="font-semibold text-fg">{result.market} PUT</span>
            </div>
            <div>
              <span className="text-faint block text-[10.5px]">Strike</span>
              <span className="font-semibold text-fg num">${result.strike.toLocaleString()}</span>
            </div>
            <div>
              <span className="text-faint block text-[10.5px]">Cost</span>
              <span className="font-semibold text-fg num">{result.amountUsdc} USDC</span>
            </div>
            <div>
              <span className="text-faint block text-[10.5px]">Speed</span>
              <span className="font-semibold text-fg num">{result.executionTimeMs}ms</span>
            </div>
          </div>

          <div className="pt-2 border-t border-calm/20 flex flex-wrap items-center justify-between gap-2 text-[11.5px]">
            <span className="text-muted font-mono truncate max-w-[280px] sm:max-w-md">
              Tx: {result.txHash}
            </span>
            <a
              href={result.basescanUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1 rounded-md bg-calm text-white text-[11.5px] font-semibold hover:brightness-110 transition flex items-center gap-1"
            >
              <span>View on Basescan ↗</span>
            </a>
          </div>
        </div>
      )}

      {error && (
        <div className="p-3 rounded-lg border border-crit/30 bg-crit/10 text-crit text-[12px]">
          Execution Notice: {error}
        </div>
      )}

      {/* Terminal Console */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-[11px] font-mono text-faint px-1">
          <span>Execution Log Console</span>
          <span>Thetanuts OptionBook (Base Mainnet 8453)</span>
        </div>

        <div className="bg-[#0b101d] border border-edge text-[#64d8a5] p-3.5 rounded-xl font-mono text-[11.5px] leading-5 max-h-[220px] overflow-y-auto feed-scroll">
          {terminalLogs.map((log, index) => (
            <div key={index} className="whitespace-pre-wrap">
              {log}
            </div>
          ))}
          {loading && (
            <div className="flex items-center gap-2 text-[#60a5fa] animate-pulse mt-1">
              <span className="size-2 rounded-full bg-[#60a5fa]" />
              <span>Submitting fillOrder to Thetanuts smart contracts on Base Mainnet...</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
