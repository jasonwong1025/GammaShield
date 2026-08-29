"use client";

import { useState } from "react";
import type { AssetSnapshot } from "@/lib/engine";
import type { ShadowQuote } from "@/lib/shadow";
import { BASE_SEPOLIA_CHAIN, getActiveProvider, switchToBaseSepolia, type Eip1193Provider } from "./WalletConnect";

type Tx = { to: string; data: string };
type FillResult = { hash: string; quote: ShadowQuote };
const CIRCLE_FAUCET_URL = process.env.NEXT_PUBLIC_CIRCLE_FAUCET_URL ?? "";

async function connectSepolia() {
  const provider = getActiveProvider();
  if (!provider) throw new Error("Connect MetaMask or Phantom first");
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  const buyer = accounts[0];
  if (!buyer) throw new Error("no wallet account selected");
  await switchToBaseSepolia(provider);
  const chainId = await provider.request({ method: "eth_chainId" });
  if (chainId !== BASE_SEPOLIA_CHAIN.chainId) throw new Error("switch your wallet to Base Sepolia to continue");
  return { provider, buyer };
}

async function send(provider: Eip1193Provider, from: string, tx: Tx) {
  const hash = (await provider.request({
    method: "eth_sendTransaction",
    params: [{ from, to: tx.to, data: tx.data }],
  })) as string;
  for (let i = 0; i < 60; i++) {
    const receipt = (await provider.request({
      method: "eth_getTransactionReceipt",
      params: [hash],
    })) as { status?: string } | null;
    if (receipt) {
      if (receipt.status === "0x0") throw new Error("transaction reverted");
      return hash;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("transaction confirmation timed out");
}

async function api<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `request failed (${response.status})`);
  return body as T;
}

export function ExecutionTerminal({ snap }: { snap: AssetSnapshot }) {
  const [loading, setLoading] = useState<"fill" | null>(null);
  const [result, setResult] = useState<FillResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([
    "[SYS] Live Thetanuts Base-mainnet book is read-only.",
    "[SYS] Shadow fills use GammaShield contracts on Base Sepolia (84532).",
  ]);
  const highRisk = snap.score >= 70 || snap.regime === "amplifying";

  const addLog = (message: string) => setLogs((previous) => [...previous, `[${new Date().toLocaleTimeString()}] ${message}`]);

  const execute = async () => {
    setLoading("fill");
    setError(null);
    try {
      const { provider, buyer } = await connectSepolia();
      const params = new URLSearchParams({ asset: snap.asset, buyer, contracts: "1" });
      const quote = await api<ShadowQuote>(`/api/shadow/quote?${params}`);
      addLog(`Mirrored ${quote.source.asset} ${quote.source.side}: $${quote.source.strike.toLocaleString()} strike from ${quote.source.liquidity} pricing.`);
      addLog("Approving Circle test USDC on Base Sepolia.");
      await send(provider, buyer, quote.txs.approve);
      addLog("Submitting signed shadow fill.");
      const hash = await send(provider, buyer, quote.txs.fill);
      setResult({ hash, quote });
      addLog(`Shadow position confirmed: ${hash}`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "shadow fill failed";
      setError(message);
      addLog(`Shadow fill stopped: ${message}`);
    } finally {
      setLoading(null);
    }
  };

  return (
    <section className="card p-5 flex flex-col gap-4" aria-label="Base Sepolia shadow hedge">
      <div className={`rounded-xl border p-4 ${highRisk ? "border-crit/40 bg-crit/10" : "border-blue/30 bg-blue/5"}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-blue">Base Sepolia shadow execution</p>
            <h2 className="mt-1 text-[16px] font-bold text-fg">Human-confirmed protective put test</h2>
            <p className="mt-1 text-[12px] text-muted">
              Mirrors a fresh Base-mainnet Thetanuts quote. The fill uses Circle test USDC on Sepolia; this is not a Thetanuts position.
            </p>
          </div>
          <span className="rounded-full border border-edge bg-panel px-2 py-1 text-[10px] font-mono text-faint">{BASE_SEPOLIA_CHAIN.chainId || "unconfigured"}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Metric label="Asset" value={`${snap.asset} protective put`} />
        <Metric label="Risk signal" value={`${snap.score}/100 · ${snap.regime}`} />
        <Metric label="Execution" value="1 test contract" />
      </div>

      <div className="flex flex-wrap gap-2">
        {CIRCLE_FAUCET_URL && <a href={CIRCLE_FAUCET_URL} target="_blank" rel="noopener noreferrer" className="flex h-10 items-center rounded-lg border border-blue/40 px-4 text-[13px] font-semibold text-blue">Get Circle test USDC ↗</a>}
        <button type="button" onClick={execute} disabled={loading !== null} className="h-10 rounded-lg bg-blue px-4 text-[13px] font-semibold text-white disabled:opacity-50">
          {loading === "fill" ? "Confirming on Sepolia…" : "Mirror & fill protective put"}
        </button>
      </div>

      {result && (
        <div className="rounded-lg border border-calm/40 bg-calm/10 p-3 text-[12px] text-fg">
          Shadow fill confirmed for ${result.quote.source.strike.toLocaleString()} {result.quote.source.asset} put. {" "}
          {BASE_SEPOLIA_CHAIN.blockExplorerUrls[0] && <a className="font-semibold text-blue" href={`${BASE_SEPOLIA_CHAIN.blockExplorerUrls[0]}/tx/${result.hash}`} target="_blank" rel="noopener noreferrer">View testnet transaction ↗</a>}
        </div>
      )}

      {error && <div className="rounded-lg border border-crit/30 bg-crit/10 p-3 text-[12px] text-crit">{error}</div>}

      <div className="rounded-xl border border-edge bg-[#0b101d] p-3 font-mono text-[11px] leading-5 text-[#64d8a5]">
        {logs.map((log, index) => <div key={`${log}-${index}`}>{log}</div>)}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-edge bg-panel2 p-3"><p className="text-[10px] uppercase text-faint">{label}</p><p className="mt-1 text-[12px] font-semibold text-fg">{value}</p></div>;
}
