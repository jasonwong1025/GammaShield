"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MarketSnapshot } from "@/lib/snapshot";
import { TopBar, type NavTab } from "./TopBar";
import { AssetRail } from "./AssetRail";
import { ScorePanel } from "./ScorePanel";
import { PriceChart } from "./PriceChart";
import { GexChart } from "./GexChart";
import { Heatmap } from "./Heatmap";
import { BookCard } from "./BookFeed";
import { WhaleControls, ImpactCard, type SimState } from "./WhaleSim";
import { LivePrice } from "./LivePrice";
import { CopilotView } from "./CopilotView";
import { HedgeView } from "./HedgeView";
import { ASSET_META, isOptionsAsset, type Asset } from "@/lib/assets";

const POLL_MS = 10_000;
const PRICE_POLL_MS = 4_000;

type Ticker = { symbol: string; price: number }[];

export function Dashboard() {
  const [activeTab, setActiveTab] = useState<NavTab>("dashboard");
  const [asset, setAsset] = useState<Asset>("ETH");
  const [sim, setSim] = useState<SimState>({ sizeM: 100, buy: true });
  const [snap, setSnap] = useState<MarketSnapshot | null>(null);
  const [ticker, setTicker] = useState<Ticker | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/market", { cache: "no-store" });
      if (!res.ok) throw new Error(`snapshot ${res.status}`);
      const data: MarketSnapshot = await res.json();
      setSnap(data);
      setTicker((t) => t ?? data.ticker);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "network error");
    }
  }, []);

  useEffect(() => {
    const initial = setTimeout(load, 0);
    timer.current = setInterval(load, POLL_MS);
    return () => {
      clearTimeout(initial);
      if (timer.current) clearInterval(timer.current);
    };
  }, [load]);

  // Push stream: prices arrive over SSE the moment the market ticks.
  const [streaming, setStreaming] = useState(false);
  useEffect(() => {
    const es = new EventSource("/api/stream");
    const apply = (updates: { symbol: string; price: number }[]) => {
      if (!updates.length) return;
      setTicker((prev) => {
        const map = new Map((prev ?? []).map((t) => [t.symbol, t] as const));
        for (const u of updates) map.set(u.symbol, { symbol: u.symbol, price: u.price });
        const order = ["BTC", "ETH", "SOL", "XRP", "BNB", "AVAX"];
        return [...map.values()].sort(
          (x, y) => order.indexOf(x.symbol) - order.indexOf(y.symbol),
        );
      });
    };
    es.addEventListener("init", (e) => apply(JSON.parse(e.data)));
    es.addEventListener("price", (e) => apply([JSON.parse(e.data)]));
    es.onopen = () => setStreaming(true);
    es.onerror = () => setStreaming(false);
    return () => es.close();
  }, []);

  // Polling backstop: full fallback when the socket is down
  useEffect(() => {
    const streamed = new Set(["BTC", "ETH", "SOL", "XRP", "AVAX"]);
    const tick = async () => {
      try {
        const res = await fetch("/api/price", { cache: "no-store" });
        if (!res.ok) return;
        const data: { ticker: Ticker } = await res.json();
        setTicker((prev) => {
          if (!streaming || !prev) return data.ticker;
          const live = new Map(prev.map((t) => [t.symbol, t] as const));
          return data.ticker.map((t) => (streamed.has(t.symbol) ? live.get(t.symbol) ?? t : t));
        });
      } catch {}
    };
    const id = setInterval(tick, PRICE_POLL_MS);
    return () => clearInterval(id);
  }, [streaming]);

  const live = isOptionsAsset(asset);
  const a = snap?.assets[asset] ?? null;
  const livePrice = ticker?.find((t) => t.symbol === asset)?.price ?? a?.spot ?? 0;
  const hasHighRisk = Boolean(a && (a.score >= 70 || a.regime === "amplifying"));

  return (
    <div className="flex flex-col min-h-dvh bg-slate-50/40">
      <TopBar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        hasHighRiskAlert={hasHighRisk}
      />

      <div className="flex grow min-h-0">
        <AssetRail
          asset={asset}
          onAsset={setAsset}
          ticker={ticker}
          scores={
            snap
              ? (Object.fromEntries(
                  Object.entries(snap.assets).map(([k, v]) => [k, v.score]),
                ) as Record<Asset, number>)
              : null
          }
        />

        <div className="grow min-w-0 flex flex-col">
          {!snap && !error && <Booting />}
          {error && !snap && <Failed message={error} retry={load} />}

          {snap && (
            <>
              {/* Asset Header Strip */}
              <div className="flex items-center gap-3.5 px-6 py-3.5 border-b border-slate-100 bg-white shadow-2xs">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/coins/${asset.toLowerCase()}.svg`}
                  alt=""
                  width={24}
                  height={24}
                  className="size-6 shrink-0 self-center rounded-full"
                />
                <h1 className="text-[17px] font-bold text-slate-900 tracking-tight">
                  {ASSET_META[asset].name}
                </h1>
                <LivePrice
                  value={livePrice}
                  className="text-[17px] text-slate-500 font-medium"
                  format={(v) => `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}
                />
                {!live && (
                  <span
                    title="No live options market on Thetanuts yet — the book below is modeled from live spot so the full risk stack works."
                    className="hidden sm:inline-block self-center rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[10.5px] font-medium text-slate-500"
                  >
                    Modeled Book
                  </span>
                )}

                {/* Tab Switcher Indicator Pills on mobile/tablet */}
                <div className="flex items-center gap-1.5 ml-auto">
                  {(["dashboard", "copilot", "hedge"] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setActiveTab(tab)}
                      className={`px-3 py-1 text-[12px] rounded-lg font-medium capitalize transition ${
                        activeTab === tab
                          ? "bg-blue text-white font-semibold shadow-xs"
                          : "text-slate-500 hover:text-slate-800 hover:bg-slate-100"
                      }`}
                    >
                      {tab === "dashboard" ? "Analytics" : tab === "copilot" ? "Gonka Copilot" : "Hedge"}
                    </button>
                  ))}
                </div>
              </div>

              {a && (
                <>
                  {/* TAB 1: Analytics & GEX View */}
                  {activeTab === "dashboard" && (
                    <div className="p-6 grid grid-cols-1 xl:grid-cols-[1fr_400px] gap-6 bg-slate-50/60 grow">
                      <div className="flex flex-col gap-6 min-w-0">
                        <PriceChart asset={asset} flip={a.flipStrike} livePrice={livePrice} />
                        <WhaleControls asset={asset} sim={sim} onChange={setSim} />
                        <GexChart snap={a} />
                        <Heatmap snap={a} />
                      </div>

                      <div className="flex flex-col gap-6 min-w-0">
                        <ScorePanel snap={a} />
                        <ImpactCard snap={a} sim={sim} />
                        <BookCard rows={snap.feed} snap={a} asset={asset} />
                      </div>
                    </div>
                  )}

                  {/* TAB 2: Dedicated Gonka AI Copilot View (Unified Chat) */}
                  {activeTab === "copilot" && (
                    <CopilotView
                      snap={a}
                      onNavigateToHedge={(strike) => {
                        setActiveTab("hedge");
                      }}
                    />
                  )}

                  {/* TAB 3: Dedicated Thetanuts Autonomous Hedging View */}
                  {activeTab === "hedge" && (
                    <HedgeView
                      snap={a}
                      feed={snap.feed}
                      asset={asset}
                    />
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Booting() {
  return (
    <div className="h-full min-h-[50vh] flex flex-col items-center justify-center gap-3 text-slate-400">
      <span className="live-dot inline-block size-2.5 rounded-full bg-blue" />
      <span className="text-[13px] font-medium">Connecting to Base Mainnet & Thetanuts OptionBook…</span>
    </div>
  );
}

function Failed({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="h-full min-h-[50vh] flex flex-col items-center justify-center gap-4">
      <span className="text-[13px] text-rose-600 font-medium">Couldn&apos;t reach the live book — {message}</span>
      <button
        onClick={retry}
        className="h-9 px-4 rounded-xl bg-blue text-white text-[13px] font-semibold hover:brightness-110 transition"
      >
        Try again
      </button>
    </div>
  );
}
