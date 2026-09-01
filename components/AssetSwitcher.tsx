"use client";

import { useEffect, useRef, useState } from "react";
import { LivePrice } from "./LivePrice";
import { riskColor } from "@/lib/format";
import { ALL_ASSETS, ASSET_META, type Asset } from "@/lib/assets";

type Props = {
  asset: Asset;
  onAsset: (a: Asset) => void;
  ticker: { symbol: string; price: number }[] | null;
  scores: Record<Asset, number> | null;
};

function CoinLogo({ symbol, size = 22 }: { symbol: string; size?: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/coins/${symbol.toLowerCase()}.svg`}
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded-full"
      style={{ width: size, height: size }}
    />
  );
}

function fmtPrice(v: number) {
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

export function AssetSwitcher({ asset, onAsset, ticker, scores }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const price = (symbol: string) => ticker?.find((t) => t.symbol === symbol)?.price ?? null;
  const activePrice = price(asset);

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-2.5 -mx-1.5 -my-1 rounded-lg px-1.5 py-1 transition-colors hover:bg-panel2"
      >
        <CoinLogo symbol={asset} />
        <h1 className="text-[18px] font-semibold tracking-tight">{ASSET_META[asset].name}</h1>
        {activePrice !== null && (
          <LivePrice value={activePrice} className="text-[18px] text-muted" format={fmtPrice} />
        )}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          className={`shrink-0 text-faint transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-full z-20 mt-1 w-64 overflow-hidden rounded-lg border border-edge bg-panel shadow-lg"
        >
          {ALL_ASSETS.map((symbol) => {
            const { name } = ASSET_META[symbol];
            const p = price(symbol);
            const score = scores?.[symbol] ?? null;
            const active = symbol === asset;
            return (
              <button
                key={symbol}
                role="option"
                aria-selected={active}
                onClick={() => {
                  onAsset(symbol);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left transition-colors ${
                  active ? "bg-panel2" : "hover:bg-panel2/50"
                }`}
              >
                <span className="flex items-center gap-2">
                  <CoinLogo symbol={symbol} size={18} />
                  <span className="flex flex-col">
                    <span className="text-[13px] font-semibold text-fg">{symbol}</span>
                    <span className="text-[11px] text-faint">{name}</span>
                  </span>
                </span>
                <span className="flex flex-col items-end">
                  {p !== null ? (
                    <span className="num text-[12px] text-fg">{fmtPrice(p)}</span>
                  ) : (
                    <span className="text-[12px] text-faint">—</span>
                  )}
                  {score !== null && (
                    <span className="num text-[11px]" style={{ color: riskColor(score) }}>
                      risk {score}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
