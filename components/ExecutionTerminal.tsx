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
    <section className="bg-white rounded-2xl p-6 shadow-xs border border-slate-100/80 flex flex-col gap-5" aria-label="Autonomous Thetanuts Execution Copilot">
      {/* Alert Header Banner */}
      <div
        className={`p-5 rounded-2xl border flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 transition ${
          isHighRisk
            ? "border-rose-200 bg-rose-50/70"
            : "border-blue-100 bg-blue-50/50"
        }`}
      >
        <div className="flex items-center gap-3.5">
          <div
            className={`flex size-11 items-center justify-center rounded-2xl text-[20px] shrink-0 ${
              isHighRisk ? "bg-rose-100 text-rose-600 animate-pulse" : "bg-blue-100 text-blue"
            }`}
          >
            {isHighRisk ? "⚠️" : "🛡️"}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-bold text-slate-900">
                {isHighRisk
                  ? `High Fragility Alert (Score: ${snap.score}/100)`
                  : `Portfolio Protection Ready`}
              </h2>
              <span
                className={`text-[10.5px] font-bold uppercase px-2 py-0.5 rounded-full ${
                  isHighRisk ? "bg-rose-600 text-white" : "bg-blue text-white"
                }`}
              >
                {snap.regime.toUpperCase()}
              </span>
            </div>
            <p className="text-[12.5px] text-slate-600 mt-0.5">
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
          className={`shrink-0 h-10 px-5 rounded-xl text-[13px] font-bold transition shadow-xs flex items-center gap-2 ${
            loading
              ? "bg-rose-400 text-white cursor-wait"
              : isHighRisk
              ? "bg-rose-600 text-white hover:bg-rose-700 active:scale-[0.98] shadow-md shadow-rose-200"
              : "bg-blue text-white hover:brightness-110 active:scale-[0.98] shadow-md shadow-blue-100"
          }`}
        >
          {loading ? (
            <>
              <span className="size-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              <span>Executing on Base…</span>
            </>
          ) : (
            <>
              <span>⚡ Confirm & Execute Live Hedge</span>
            </>
          )}
        </button>
      </div>

      {/* Execution Parameter Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
        <div className="p-4 rounded-xl border border-slate-100 bg-slate-50/70 flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Asset & Live Price</span>
          <span className="num text-[16px] font-bold text-slate-900">
            {snap.asset} · ${snap.spot.toLocaleString()}
          </span>
          <span className="text-[11.5px] text-slate-500">Base Mainnet (8453)</span>
        </div>

        <div className="p-4 rounded-xl border border-slate-100 bg-slate-50/70 flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Recommended Put Strike</span>
          <div className="flex items-center gap-2">
            <span className="num text-[16px] font-bold text-blue">${strike.toLocaleString()}</span>
            <span className="text-[10.5px] px-1.5 py-0.5 rounded-md bg-white border border-slate-200 text-slate-500">
              {strike < snap.spot ? `-${(((snap.spot - strike) / snap.spot) * 100).toFixed(1)}% OTM` : "ATM"}
            </span>
          </div>
          <span className="text-[11.5px] text-slate-500">Flip Level: ${snap.flipStrike ? snap.flipStrike.toLocaleString() : "None"}</span>
        </div>

        <div className="p-4 rounded-xl border border-slate-100 bg-slate-50/70 flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Burner Wallet Status</span>
          <div className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-emerald-500" />
            <span className="text-[12px] font-mono text-slate-800 font-medium truncate">
              {wallet?.address
                ? `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`
                : "Active Signer Loaded"}
            </span>
          </div>
          <span className="text-[11.5px] text-slate-500 num">
            Gas: {wallet?.ethBalance ? `${parseFloat(wallet.ethBalance).toFixed(4)} ETH` : "~0.005 ETH"} · USDC: {wallet?.usdcBalance || "2.00"}
          </span>
        </div>
      </div>

      {/* Confirmed Transaction Card */}
      {result && (
        <div className="p-4 rounded-xl border border-emerald-200 bg-emerald-50/70 flex flex-col gap-2.5 animate-fade-in">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="flex size-2.5 rounded-full bg-emerald-600" />
              <span className="text-[14px] font-bold text-slate-900">
                ✅ Protective Put Option Successfully Confirmed on Base Mainnet
              </span>
            </div>
            <span className="text-[11px] font-mono px-2 py-0.5 rounded-md bg-white border border-emerald-200 text-emerald-700 font-semibold">
              Block #{result.blockNumber}
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[12px] pt-1">
            <div>
              <span className="text-slate-400 block text-[11px]">Contract</span>
              <span className="font-semibold text-slate-800">{result.market} PUT</span>
            </div>
            <div>
              <span className="text-slate-400 block text-[11px]">Strike</span>
              <span className="font-semibold text-slate-800 num">${result.strike.toLocaleString()}</span>
            </div>
            <div>
              <span className="text-slate-400 block text-[11px]">Cost</span>
              <span className="font-semibold text-slate-800 num">{result.amountUsdc} USDC</span>
            </div>
            <div>
              <span className="text-slate-400 block text-[11px]">Speed</span>
              <span className="font-semibold text-slate-800 num">{result.executionTimeMs}ms</span>
            </div>
          </div>

          <div className="pt-2 border-t border-emerald-200/60 flex flex-wrap items-center justify-between gap-2 text-[12px]">
            <span className="text-slate-500 font-mono truncate max-w-[280px] sm:max-w-md">
              Tx: {result.txHash}
            </span>
            <a
              href={result.basescanUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1 rounded-lg bg-emerald-600 text-white text-[11.5px] font-bold hover:bg-emerald-700 transition flex items-center gap-1 shadow-xs"
            >
              <span>View on Basescan ↗</span>
            </a>
          </div>
        </div>
      )}

      {error && (
        <div className="p-3.5 rounded-xl border border-rose-200 bg-rose-50 text-rose-700 text-[12.5px]">
          Execution Notice: {error}
        </div>
      )}

      {/* Terminal Console */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 px-1">
          <span>Execution Log Console</span>
          <span>Thetanuts OptionBook (Base Mainnet)</span>
        </div>

        <div className="bg-slate-900 border border-slate-800 text-emerald-400 p-4 rounded-xl font-mono text-[11.5px] leading-relaxed max-h-[220px] overflow-y-auto feed-scroll">
          {terminalLogs.map((log, index) => (
            <div key={index} className="whitespace-pre-wrap">
              {log}
            </div>
          ))}
          {loading && (
            <div className="flex items-center gap-2 text-sky-400 animate-pulse mt-1">
              <span className="size-2 rounded-full bg-sky-400" />
              <span>Submitting order to OptionBook smart contracts on Base Mainnet...</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
