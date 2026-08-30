"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MarketSnapshot } from "@/lib/snapshot";
import { TopBar, type NavTab } from "./TopBar";
import { AssetRail } from "./AssetRail";
import { TradePanel } from "./TradePanel";
import { PriceChart } from "./PriceChart";
import { RiskView } from "./RiskView";
import { BookCard } from "./BookFeed";
import { LivePrice } from "./LivePrice";
import { CopilotView } from "./CopilotView";
import { HedgeView } from "./HedgeView";
import { ASSET_META, isOptionsAsset, type Asset } from "@/lib/assets";

const POLL_MS = 10_000;
const PRICE_POLL_MS = 4_000;

type Ticker = { symbol: string; price: number }[];

export function Dashboard() {
  const [activeTab, setActiveTab] = useState<NavTab>("dashboard");
  const [asset, setAsset] = useState<Asset>("BTC");
  const [snap, setSnap] = useState<MarketSnapshot | null>(null);
  const [ticker, setTicker] = useState<Ticker | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedHedgeStrike, setSelectedHedgeStrike] = useState<number | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/market", { cache: "no-store" });
      if (!res.ok) throw new Error(`snapshot ${res.status}`);
      const data: MarketSnapshot = await res.json();
      setSnap(data);
      setTicker((t) => t ?? data.ticker);
      setError(null);

      // Background Autopilot check: if risk score >= 75 on Base options asset, check Autopilot
      const currentAssetSnap = data.assets[asset];
      if (currentAssetSnap && currentAssetSnap.score >= 75) {
        fetch("/api/hedge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "checkAutopilot",
            asset,
            fragilityScore: currentAssetSnap.score,
          }),
        }).catch(() => {});
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "network error");
    }
  }, [asset]);

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

  // Polling backstop: full fallback when the socket is down, and the only
  // source for symbols the stream doesn't carry (e.g. BNB).
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
    <div className="flex flex-col min-h-dvh">
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
              <div className="flex items-baseline gap-3 px-5 py-3 border-b border-edge bg-panel">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/coins/${asset.toLowerCase()}.svg`}
                  alt=""
                  width={22}
                  height={22}
                  className="size-[22px] shrink-0 self-center rounded-full"
                />
                <h1 className="text-[18px] font-semibold tracking-tight">
                  {ASSET_META[asset].name}
                </h1>
                <LivePrice
                  value={livePrice}
                  className="text-[18px] text-muted"
                  format={(v) => `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}
                />
                {!live && (
                  <span
                    title="No live options market on Thetanuts yet — the book below is modeled from live spot so the full risk stack works. Options flow becomes real the moment a book launches on Base."
                    className="hidden sm:inline-block self-center rounded-full border border-edge px-2 py-0.5 text-[10px] uppercase tracking-wide text-faint"
                  >
                    Modeled book
                  </span>
                )}
                <span className="md:hidden ml-auto">
                  <button
                    onClick={() => setAsset(asset === "BTC" ? "ETH" : "BTC")}
                    className="text-[12px] text-blue"
                  >
                    Switch to {asset === "BTC" ? "ETH" : "BTC"}
                  </button>
                </span>
              </div>

              {a && (
                <>
                  {/* TAB 1: Main Dashboard (Trading, OptionBook, RiskView from main) */}
                  {activeTab === "dashboard" && (
                    <div className="grid grow grid-cols-1 xl:grid-cols-[1fr_380px] gap-px bg-edge">
                      <div className="flex flex-col gap-px min-w-0">
                        <PriceChart asset={asset} flip={a.flipStrike} livePrice={livePrice} />
                        <BookCard rows={snap.feed} snap={a} asset={asset} live={live} spot={livePrice} />
                        <RiskView snap={a} />
                        <div className="grow bg-panel" />
                      </div>

                      <div className="flex flex-col gap-px min-w-0">
                        <TradePanel key={asset} asset={asset} live={live} hedgeIntent={null} />
                        <div className="grow bg-panel" />
                      </div>
                    </div>
                  )}

                  {/* TAB 2: Gonka AI Copilot Workspace */}
                  {activeTab === "copilot" && (
                    <CopilotView
                      snap={a}
                      onNavigateToHedge={(strike) => {
                        setSelectedHedgeStrike(strike);
                        setActiveTab("hedge");
                      }}
                    />
                  )}

                  {/* TAB 3: Autonomous Thetanuts Hedging Workspace */}
                  {activeTab === "hedge" && (
                    <HedgeView
                      snap={a}
                      feed={snap.feed}
                      asset={asset}
                      live={live}
                      spot={livePrice}
                      initialStrike={selectedHedgeStrike}
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
