"use client";

import { useEffect, useState } from "react";
import type { FeedRow } from "@/lib/snapshot";
import type { AssetSnapshot } from "@/lib/engine";
import type { Asset } from "@/lib/assets";
import {
  fmtCountdown,
  fmtExpiryDate,
  fmtIv,
  fmtStrike,
  fmtUsd,
} from "@/lib/format";

export function BookCard({
  rows,
  snap,
  asset,
  live,
}: {
  rows: FeedRow[];
  snap: AssetSnapshot;
  asset: Asset;
  /** True for BTC/ETH (real Thetanuts OptionBook); false = modeled book. */
  live: boolean;
}) {
  const [tab, setTab] = useState<"book" | "expiries">("book");
  const filtered = rows.filter((r) => r.asset === asset);
  const bookLabel = live ? "OptionBook (live)" : "Modeled book";

  return (
    <section className="card flex flex-col min-h-0 overflow-hidden" aria-label={bookLabel}>
      <div className="flex items-center justify-between px-5 pt-4 pb-3">
        <div className="flex items-center gap-1 rounded-lg bg-panel2 p-0.5">
          {(
            [
              ["book", bookLabel],
              ["expiries", "Expiries"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              aria-pressed={tab === key}
              className={`px-3 h-7 rounded-md text-[12px] font-medium transition ${
                tab === key ? "bg-panel3 text-fg" : "text-muted hover:text-fg"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="flex items-center gap-1.5 text-[11px] text-muted">
          {live && <span className="live-dot inline-block size-1.5 rounded-full bg-calm" />}
          {tab === "book" ? `${filtered.length} orders` : `${snap.expiries.length} dates`}
        </span>
      </div>

      {tab === "book" ? <BookTable rows={filtered} asset={asset} /> : <Expiries snap={snap} />}
    </section>
  );
}

function fmtDaysOut(ts: number, now: number) {
  const d = (ts - now) / 86400;
  return d < 1 ? `${Math.max(0, Math.round(d * 24))}h` : `${Math.round(d)}d`;
}

function fmtDelta(v: number | null) {
  return v === null ? "—" : v.toFixed(2);
}

function BookTable({ rows, asset }: { rows: FeedRow[]; asset: string }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="feed-scroll overflow-auto grow min-h-0 max-h-[430px]">
      <table className="w-full min-w-[560px] text-[12px]">
        <thead className="sticky top-0 bg-panel z-10">
          <tr className="text-[10px] text-faint">
            <th className="text-left font-medium px-4 py-1.5">Type</th>
            <th className="text-right font-medium px-2 py-1.5">Strike</th>
            <th className="text-right font-medium px-2 py-1.5">Expiry</th>
            <th className="text-right font-medium px-2 py-1.5">Premium</th>
            <th className="text-right font-medium px-2 py-1.5">Delta</th>
            <th className="text-right font-medium px-2 py-1.5">IV</th>
            <th className="text-right font-medium px-4 py-1.5">Size</th>
          </tr>
        </thead>
        <tbody className="font-mono text-[11px]">
          {rows.map((r, i) => (
            <tr
              key={`${r.maker}-${r.strike}-${r.expiryTs}-${i}`}
              className="border-t border-edge/50 hover:bg-panel2/60 transition-colors"
            >
              <td className="px-4 py-1.5 whitespace-nowrap font-sans">
                <span
                  className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                  style={{
                    color: r.isCall ? "var(--calm)" : "var(--crit)",
                    background: `color-mix(in srgb, ${r.isCall ? "var(--calm)" : "var(--crit)"} 12%, transparent)`,
                  }}
                >
                  {r.structure}
                </span>
              </td>
              <td className="px-2 py-1.5 text-right num text-fg">
                <span
                  className="inline-block max-w-[92px] truncate align-bottom"
                  title={r.strikes.map(fmtStrike).join(" / ")}
                >
                  {r.strikes.length > 1 ? r.strikes.map(fmtStrike).join("/") : fmtStrike(r.strike)}
                </span>
              </td>
              <td className="px-2 py-1.5 text-right text-muted whitespace-nowrap">
                {fmtExpiryDate(r.expiryTs)} <span className="text-faint">· {fmtDaysOut(r.expiryTs, now)}</span>
              </td>
              <td className="px-2 py-1.5 text-right num text-fg">
                {r.pricePerContractUsd === null ? "—" : fmtUsd(r.pricePerContractUsd, false)}
              </td>
              <td className="px-2 py-1.5 text-right num text-muted">{fmtDelta(r.delta)}</td>
              <td className="px-2 py-1.5 text-right num text-muted">{fmtIv(r.iv)}</td>
              <td className="px-4 py-1.5 text-right num text-fg">{fmtUsd(r.collateralUsd)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="px-5 py-10 text-center text-faint font-sans">
                No live {asset} orders on the book right now.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Expiries({ snap }: { snap: AssetSnapshot }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => clearInterval(id);
  }, []);

  const top = snap.expiries;
  const maxNotional = Math.max(...top.map((e) => e.notionalUsd), 1);

  return (
    <div className="feed-scroll overflow-y-auto grow min-h-0 max-h-[430px] px-5 pb-4 flex flex-col gap-2.5">
      {top.map((e) => {
        const urgent = e.daysOut < 2;
        return (
          <div key={e.ts} className="flex items-center gap-3 text-[12px]">
            <span className="w-14 text-muted">{fmtExpiryDate(e.ts)}</span>
            <span className="w-16 num" style={{ color: urgent ? "var(--warn)" : "var(--text)" }}>
              {fmtCountdown(e.ts, now)}
            </span>
            <div className="grow h-1.5 rounded-full bg-panel3 overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${(e.notionalUsd / maxNotional) * 100}%`,
                  background: urgent ? "var(--warn)" : "var(--blue)",
                  opacity: urgent ? 1 : 0.55,
                }}
              />
            </div>
            <span className="w-16 text-right num text-muted">{fmtUsd(e.notionalUsd)}</span>
          </div>
        );
      })}
      {top.length === 0 && (
        <div className="py-8 text-center text-[12px] text-faint">No upcoming expiries.</div>
      )}
    </div>
  );
}
