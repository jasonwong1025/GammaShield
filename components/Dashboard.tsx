"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MarketSnapshot } from "@/lib/snapshot";
import { TopBar } from "./TopBar";
import { AssetRail } from "./AssetRail";
import { ScorePanel } from "./ScorePanel";
import { PriceChart } from "./PriceChart";
import { GexChart } from "./GexChart";
import { Heatmap } from "./Heatmap";
import { BookCard } from "./BookFeed";
import { WhaleControls, ImpactCard, type SimState } from "./WhaleSim";
import { LivePrice } from "./LivePrice";

const POLL_MS = 10_000;
const PRICE_POLL_MS = 4_000;

const ASSET_NAMES = { BTC: "Bitcoin", ETH: "Ethereum" } as const;

type Ticker = { symbol: string; price: number }[];

export function Dashboard() {
  const [asset, setAsset] = useState<"BTC" | "ETH">("BTC");
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

  const a = snap?.assets[asset] ?? null;
  const livePrice = ticker?.find((t) => t.symbol === asset)?.price ?? a?.spot ?? 0;

  return (
    <div className="flex flex-col min-h-dvh">
      <TopBar connected={!!snap && !error} />

      <div className="flex grow min-h-0">
        <AssetRail
          asset={asset}
          onAsset={setAsset}
          ticker={ticker}
          scores={
            snap ? { BTC: snap.assets.BTC.score, ETH: snap.assets.ETH.score } : null
          }
        />

        <div className="grow min-w-0 flex flex-col">
          {!snap && !error && <Booting />}
          {error && !snap && <Failed message={error} retry={load} />}

          {snap && a && (
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
                  {ASSET_NAMES[asset]}
                </h1>
                <LivePrice
                  value={livePrice}
                  className="text-[18px] text-muted"
                  format={(v) => `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}
                />
                <span className="md:hidden ml-auto">
                  <button
                    onClick={() => setAsset(asset === "BTC" ? "ETH" : "BTC")}
                    className="text-[12px] text-blue"
                  >
                    Switch to {asset === "BTC" ? "ETH" : "BTC"}
                  </button>
                </span>
              </div>

              <div className="grid grow grid-cols-1 xl:grid-cols-[1fr_380px] gap-px bg-edge">
                <div className="flex flex-col gap-px min-w-0">
                  <PriceChart asset={asset} flip={a.flipStrike} livePrice={livePrice} />
                  <WhaleControls asset={asset} sim={sim} onChange={setSim} />
                  <GexChart snap={a} />
                  <Heatmap snap={a} />
                  <div className="grow bg-panel" />
                </div>

                <div className="flex flex-col gap-px min-w-0">
                  <ScorePanel snap={a} />
                  <ImpactCard snap={a} sim={sim} />
                  <BookCard rows={snap.feed} snap={a} asset={asset} />
                  <div className="grow bg-panel" />
                </div>
              </div>
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
