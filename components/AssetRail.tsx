"use client";

import { LivePrice } from "./LivePrice";
import { riskColor } from "@/lib/format";

type Props = {
  asset: "BTC" | "ETH";
  onAsset: (a: "BTC" | "ETH") => void;
  ticker: { symbol: string; price: number }[] | null;
  scores: { BTC: number; ETH: number } | null;
};

const TRADEABLE: { symbol: "BTC" | "ETH"; name: string }[] = [
  { symbol: "BTC", name: "Bitcoin" },
  { symbol: "ETH", name: "Ethereum" },
];

const SPOT_ONLY: { symbol: string; name: string }[] = [
  { symbol: "SOL", name: "Solana" },
  { symbol: "XRP", name: "XRP" },
  { symbol: "BNB", name: "BNB" },
  { symbol: "AVAX", name: "Avalanche" },
];

function CoinLogo({ symbol, className }: { symbol: string; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/coins/${symbol.toLowerCase()}.svg`}
      alt=""
      width={16}
      height={16}
      className={`size-4 shrink-0 rounded-full ${className ?? ""}`}
    />
  );
}

function fmtPrice(v: number) {
  return `$${v >= 100 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v.toFixed(2)}`;
}

export function AssetRail({ asset, onAsset, ticker, scores }: Props) {
  const price = (symbol: string) => ticker?.find((t) => t.symbol === symbol)?.price ?? null;

  return (
    <aside className="hidden md:flex flex-col w-[212px] shrink-0 border-r border-edge bg-panel">
      <div className="px-4 pt-3.5 pb-2 text-[10px] uppercase tracking-wide text-faint">
        Markets
      </div>

      {TRADEABLE.map(({ symbol, name }) => {
        const active = asset === symbol;
        const p = price(symbol);
        const score = scores?.[symbol] ?? null;
        return (
          <button
            key={symbol}
            onClick={() => onAsset(symbol)}
            aria-pressed={active}
            className={`relative px-4 py-2.5 text-left transition-colors ${
              active ? "bg-panel2" : "hover:bg-panel2/50"
            }`}
          >
            {active && <span className="absolute inset-y-0 left-0 w-[2px] bg-blue" />}
            <span className="flex items-baseline justify-between gap-2">
              <span className="flex items-center gap-2 text-[13px] font-semibold text-fg">
                <CoinLogo symbol={symbol} />
                {symbol}
              </span>
              {p !== null ? (
                <LivePrice value={p} className="text-[12px] text-fg" format={fmtPrice} />
              ) : (
                <span className="text-[12px] text-faint">—</span>
              )}
            </span>
            <span className="mt-0.5 flex items-baseline justify-between gap-2 pl-6">
              <span className="text-[11px] text-faint">{name}</span>
              {score !== null && (
                <span className="text-[11px] num" style={{ color: riskColor(score) }}>
                  risk {score}
                </span>
              )}
            </span>
          </button>
        );
      })}

      <div className="px-4 pt-4 pb-2 text-[10px] uppercase tracking-wide text-faint">
        Spot only
      </div>

      {SPOT_ONLY.map(({ symbol, name }) => {
        const p = price(symbol);
        return (
          <div
            key={symbol}
            className="px-4 py-2 cursor-default"
            title="No on-chain options market yet"
          >
            <span className="flex items-baseline justify-between gap-2">
              <span className="flex items-center gap-2 text-[12.5px] font-medium text-muted">
                <CoinLogo symbol={symbol} className="opacity-80 saturate-[.85]" />
                {symbol}
              </span>
              {p !== null ? (
                <LivePrice value={p} className="text-[12px] text-muted" format={fmtPrice} />
              ) : (
                <span className="text-[12px] text-faint">—</span>
              )}
            </span>
            <span className="mt-0.5 block pl-6 text-[10.5px] text-faint">{name}</span>
          </div>
        );
      })}

      <div className="mt-auto px-4 py-3 border-t border-edge text-[10px] leading-4 text-faint">
        Risk scores update every 10s from the live Thetanuts book.
      </div>
    </aside>
  );
}
