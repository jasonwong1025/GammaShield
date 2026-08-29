"use client";

import { useEffect, useState } from "react";
import type { AssetSnapshot } from "@/lib/engine";
import type { HedgeResult } from "@/lib/hedge";

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
};

export function ExecutionTerminal({ snap, initialStrike }: Props) {
  const [strike, setStrike] = useState<number>(initialStrike || snap.flipStrike || Math.round(snap.spot * 0.95));
  const [amountUsdc, setAmountUsdc] = useState<number>(1);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<HedgeResult | null>(null);
  const [terminalLogs, setTerminalLogs] = useState<string[]>([
    `[SYS] Thetanuts V4 SDK client ready on Base Mainnet (Chain ID 8453).`,
    `[SYS] Monitoring live Net GEX ($${snap.netGexUsd ? snap.netGexUsd.toLocaleString() : "0"}) and Gamma Flip level ($${snap.flipStrike || Math.round(snap.spot * 0.95)}).`,
  ]);
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isHighRisk = snap.score >= 70 || snap.regime === "amplifying";

  useEffect(() => {
    fetch("/api/hedge")
      .then((r) => r.json())
      .then((d) => setWallet(d))
      .catch(() => {});
  }, []);

  const handleExecute = async () => {
    setLoading(true);
    setError(null);
    setTerminalLogs((prev) => [
      ...prev,
      `--------------------------------------------------`,
      `[${new Date().toLocaleTimeString()}] 🚀 Initiating 1-Click Autonomous Protective Put for ${snap.asset}...`,
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
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Execution failed";
      setError(msg);
      setTerminalLogs((prev) => [...prev, `[ERR] ❌ Execution stopped: ${msg}`]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="card p-5 flex flex-col gap-4" aria-label="Autonomous Thetanuts Execution Copilot">
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
                  : `Portfolio Protection Ready`}
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
                ? "Market makers are net short gamma. A protective Put option locks in floor liquidity before cascade drops."
                : "Automated options orderbook routing active on Base Mainnet."}
            </p>
          </div>
        </div>

        {/* 1-Click Trigger Button */}
        <button
          type="button"
          onClick={handleExecute}
          disabled={loading}
          className={`shrink-0 h-9 px-4 rounded-lg text-[13px] font-medium transition flex items-center gap-2 ${
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
            <>
              <span>⚡ Confirm & Execute Live Hedge (1 USDC)</span>
            </>
          )}
        </button>
      </div>

      {/* Execution Parameter Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="p-3.5 rounded-lg border border-edge bg-panel2 flex flex-col gap-1">
          <span className="text-[11px] font-medium text-faint uppercase">Asset & Live Price</span>
          <span className="num text-[15px] font-bold text-fg">
            {snap.asset} · ${snap.spot.toLocaleString()}
          </span>
          <span className="text-[11px] text-muted">Base Mainnet (8453)</span>
        </div>

        <div className="p-3.5 rounded-lg border border-edge bg-panel2 flex flex-col gap-1">
          <span className="text-[11px] font-medium text-faint uppercase">Recommended Put Strike</span>
          <div className="flex items-center gap-2">
            <span className="num text-[15px] font-bold text-blue">${strike.toLocaleString()}</span>
            <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-panel border border-edge text-faint">
              {strike < snap.spot ? `-${(((snap.spot - strike) / snap.spot) * 100).toFixed(1)}% OTM` : "ATM"}
            </span>
          </div>
          <span className="text-[11px] text-muted">Flip Level: ${snap.flipStrike ? snap.flipStrike.toLocaleString() : "None"}</span>
        </div>

        <div className="p-3.5 rounded-lg border border-edge bg-panel2 flex flex-col gap-1">
          <span className="text-[11px] font-medium text-faint uppercase">Burner Wallet Status</span>
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
                ✅ Protective Put Option Successfully Confirmed on Base Mainnet
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
          <span>Thetanuts OptionBook (Base Mainnet)</span>
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
              <span>Submitting order to OptionBook smart contracts on Base Mainnet...</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
