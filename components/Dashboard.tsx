"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MarketSnapshot } from "@/lib/snapshot";
import { TopBar, type NavTab } from "./TopBar";
import { AssetSwitcher } from "./AssetSwitcher";
import { TradePanel } from "./TradePanel";
import { PriceChart } from "./PriceChart";
import { RiskView } from "./RiskView";
import { BookCard } from "./BookFeed";
import { CopilotWidget } from "./CopilotWidget";
import { AgentView } from "./AgentView";
import { ExecutionNetworkProvider } from "./ExecutionNetworkProvider";
import { ALL_ASSETS, isOptionsAsset, type Asset } from "@/lib/assets";

const POLL_MS = 10_000;
const PRICE_POLL_MS = 4_000;

type Ticker = { symbol: string; price: number }[];

export function Dashboard() {
  const [activeTab, setActiveTab] = useState<NavTab>("dashboard");
  const [asset, setAsset] = useState<Asset>("BTC");
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
        const order: readonly string[] = ALL_ASSETS;
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

  // Polling backstop: full fallback when the socket is down.
  useEffect(() => {
    const streamed = new Set<string>(ALL_ASSETS);
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
      } catch {
        // next tick retries
      }
    };
    const id = setInterval(tick, PRICE_POLL_MS);
    return () => clearInterval(id);
  }, [streaming]);

  const live = isOptionsAsset(asset);
  const a = snap?.assets[asset] ?? null;
  const livePrice = ticker?.find((t) => t.symbol === asset)?.price ?? a?.spot ?? 0;
  const hasHighRisk = Boolean(a && (a.score >= 70 || a.regime === "amplifying"));

  return (
    <ExecutionNetworkProvider>
    <div className="flex flex-col min-h-dvh">
      <TopBar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        hasHighRiskAlert={hasHighRisk}
      />

      <div className="flex grow min-h-0 flex-col">
        {!snap && !error && <Booting />}
        {error && !snap && <Failed message={error} retry={load} />}

        {snap && (
          <>
            <div className="flex items-center gap-3 px-5 py-3 border-b border-edge bg-panel">
              <AssetSwitcher
                asset={asset}
                onAsset={setAsset}
                ticker={ticker}
                scores={
                  Object.fromEntries(
                    Object.entries(snap.assets).map(([k, v]) => [k, v.score]),
                  ) as Record<Asset, number>
                }
              />
            </div>

            {a && (
              <>
                {/* TAB 1: Main Dashboard (Trading, OptionBook, RiskView from main) */}
                {activeTab === "dashboard" && (
                  <div className="grid grow grid-cols-1 xl:grid-cols-[1fr_380px] gap-px bg-edge">
                    <div className="flex flex-col gap-px min-w-0">
                      <PriceChart asset={asset} flip={a.flipStrike} livePrice={livePrice} />
                      <BookCard
                        rows={snap.feed}
                        snap={a}
                        asset={asset}
                        live={live}
                        spot={livePrice}
                        volBaseline={snap.volBaseline?.[asset] ?? null}
                        tabs={["book", "expiries"]}
                      />
                      <RiskView snap={a} />
                      <div className="grow bg-panel" />
                    </div>

                    <div className="flex flex-col gap-px min-w-0">
                      <TradePanel key={asset} asset={asset} live={live} hedgeIntent={null} />
                      <div className="grow bg-panel" />
                    </div>
                  </div>
                )}

                {/* TAB 2: AI agent workspace — limits, policy, monitoring */}
                {activeTab === "agent" && (
                  <AgentView
                    snap={a}
                    feed={snap.feed}
                    asset={asset}
                    live={live}
                    spot={livePrice}
                  />
                )}
              </>
            )}
          </>
        )}
      </div>

      <CopilotWidget
        snap={a}
        onNavigateToAgent={() => {
          setActiveTab("agent");
        }}
      />
    </div>
    </ExecutionNetworkProvider>
  );
}

function Booting() {
  return (
    <div className="h-full min-h-[50vh] flex flex-col items-center justify-center gap-3 text-muted">
      <span className="live-dot inline-block size-2.5 rounded-full bg-blue" />
      <span className="text-[13px]">Reading the live options book on Base…</span>
    </div>
  );
}

function Failed({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="h-full min-h-[50vh] flex flex-col items-center justify-center gap-4">
      <span className="text-[13px] text-crit">Couldn&apos;t reach the live book — {message}</span>
      <button
        onClick={retry}
        className="h-9 px-4 rounded-lg bg-blue text-white text-[13px] font-medium hover:brightness-110 transition"
      >
        Try again
      </button>
    </div>
  );
}
