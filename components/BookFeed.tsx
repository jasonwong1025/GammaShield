"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import type { FeedRow } from "@/lib/snapshot";
import type { AssetSnapshot } from "@/lib/engine";
import type { Asset } from "@/lib/assets";
import type { AiRiskAssessment } from "@/lib/aiRisk";
import {
  fmtCountdown,
  fmtExpiryDate,
  fmtIv,
  fmtStrike,
  fmtUsd,
  riskColor,
} from "@/lib/format";
import { ShadowPositions } from "./ShadowPositions";
import { ThetanutsPositions } from "./ThetanutsPositions";

export function BookCard({
  rows,
  snap,
  asset,
  live,
  spot,
}: {
  rows: FeedRow[];
  snap: AssetSnapshot;
  asset: Asset;
  /** True for BTC/ETH (real Thetanuts OptionBook); false = modeled book. */
  live: boolean;
  /** Live spot price — informational context for the AI risk read. */
  spot: number;
}) {
  const [tab, setTab] = useState<"book" | "expiries" | "thetanuts" | "shadow">("book");
  const [positionsRefresh, setPositionsRefresh] = useState(0);
  useEffect(() => {
    const showPosition = () => {
      setPositionsRefresh((value) => value + 1);
      setTab("thetanuts");
    };
    window.addEventListener("thetanuts-position-changed", showPosition);
    return () => window.removeEventListener("thetanuts-position-changed", showPosition);
  }, []);
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
              ["thetanuts", "My Thetanuts positions"],
              ["shadow", "My shadow positions"],
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
          {tab === "book" ? `${filtered.length} orders` : tab === "expiries" ? `${snap.expiries.length} dates` : tab === "thetanuts" ? "Base mainnet" : "Base Sepolia"}
        </span>
      </div>

      {tab === "book" ? <BookTable rows={filtered} asset={asset} spot={spot} /> : tab === "expiries" ? <Expiries snap={snap} /> : tab === "thetanuts" ? <ThetanutsPositions asset={asset} refreshKey={positionsRefresh} /> : <ShadowPositions asset={asset} />}
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

// Deliberately excludes the array index: the feed reorders/reshuffles across
// the 10s poll refresh (lib/snapshot.ts sorts by expiry, ties unordered), and
// an index-based key would let the accordion's expandedKey silently latch
// onto a different row after a refresh — same position, different option.
function rowKey(r: FeedRow) {
  return `${r.maker}-${r.strike}-${r.expiryTs}-${r.structure}`;
}

function BookTable({ rows, asset, spot }: { rows: FeedRow[]; asset: string; spot: number }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, []);

  // Accordion: one row expanded at a time, each with its own AI request
  // state that resets the moment a different row is opened.
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [aiRisk, setAiRisk] = useState<AiRiskAssessment | null>(null);
  const [aiRiskLoading, setAiRiskLoading] = useState(false);
  const [aiRiskError, setAiRiskError] = useState<string | null>(null);
  const aiSeq = useRef(0);

  const toggleRow = (key: string) => {
    setExpandedKey((cur) => (cur === key ? null : key));
    setAiRisk(null);
    setAiRiskError(null);
  };

  const fetchAiRisk = async (r: FeedRow) => {
    const id = ++aiSeq.current;
    setAiRiskLoading(true);
    setAiRiskError(null);
    try {
      // Same convention lib/engine.ts's orderGex uses to turn listed
      // collateral into a contract count.
      const contracts = r.collateralUsd / Math.max(r.strike, 1);
      const greeks =
        r.delta != null && r.gamma != null && r.theta != null && r.vega != null && r.rho != null && r.iv != null
          ? { delta: r.delta, gamma: r.gamma, theta: r.theta, vega: r.vega, rho: r.rho, iv: r.iv }
          : null;
      const res = await fetch("/api/risk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          asset: r.asset,
          side: r.isCall ? "call" : "put",
          strike: r.strike,
          expiryTs: r.expiryTs,
          contracts,
          spot,
          greeks,
          scoreBefore: r.impact?.scoreBefore,
          scoreAfter: r.impact?.scoreAfter,
          netGexBefore: r.impact?.netGexBefore,
          netGexAfter: r.impact?.netGexAfter,
          regimeBefore: r.impact?.regimeBefore,
          regimeAfter: r.impact?.regimeAfter,
        }),
      });
      const data = await res.json();
      if (aiSeq.current !== id) return;
      if (!res.ok) throw new Error(data.error ?? `risk ${res.status}`);
      setAiRisk(data);
    } catch (e) {
      if (aiSeq.current !== id) return;
      setAiRiskError(e instanceof Error ? e.message : "AI risk read failed");
    } finally {
      if (aiSeq.current === id) setAiRiskLoading(false);
    }
  };

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
          {rows.map((r, i) => {
            const key = rowKey(r);
            const expanded = expandedKey === key;
            return (
              <Fragment key={`${key}-${i}`}>
                <tr
                  onClick={() => toggleRow(key)}
                  aria-expanded={expanded}
                  className={`border-t border-edge/50 hover:bg-panel2/60 transition-colors cursor-pointer ${expanded ? "bg-panel2/60" : ""}`}
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
                {expanded && (
                  <tr key={`${key}-detail`} className="border-t border-edge/50">
                    <td colSpan={7} className="px-4 py-3 bg-panel2/40 font-sans">
                      <RowRiskDetail
                        row={r}
                        aiRisk={aiRisk}
                        aiRiskLoading={aiRiskLoading}
                        aiRiskError={aiRiskError}
                        onGetAiRead={() => fetchAiRisk(r)}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
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

function fmtGreek(v: number | null, digits: number) {
  return v === null ? "—" : v.toFixed(digits);
}

// Risk drill-down for one order: the deterministic what-if impact
// (lib/engine.ts, precomputed server-side — see lib/snapshot.ts, so this
// renders instantly) plus an optional AI second opinion (GonkaRouter,
// manual-only — /api/risk is only ever called from the button below).
function RowRiskDetail({
  row,
  aiRisk,
  aiRiskLoading,
  aiRiskError,
  onGetAiRead,
}: {
  row: FeedRow;
  aiRisk: AiRiskAssessment | null;
  aiRiskLoading: boolean;
  aiRiskError: string | null;
  onGetAiRead: () => void;
}) {
  const { impact } = row;
  return (
    <div className="flex flex-col gap-2.5 text-[12px]" onClick={(e) => e.stopPropagation()}>
      <div className="grid grid-cols-5 gap-x-3 gap-y-1 num text-muted">
        <span>Delta <span className="text-fg">{fmtGreek(row.delta, 3)}</span></span>
        <span>Gamma <span className="text-fg">{fmtGreek(row.gamma, 5)}</span></span>
        <span>Theta <span className="text-fg">{fmtGreek(row.theta, 2)}</span></span>
        <span>Vega <span className="text-fg">{fmtGreek(row.vega, 2)}</span></span>
        <span>Rho <span className="text-fg">{fmtGreek(row.rho, 2)}</span></span>
      </div>

      {impact ? (
        <div className="rounded-lg border border-edge bg-panel p-2.5 flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-muted">Amplification risk impact</span>
            <span className="num font-semibold">
              <span style={{ color: riskColor(impact.scoreBefore) }}>{impact.scoreBefore}</span>
              <span className="text-faint"> → </span>
              <span style={{ color: riskColor(impact.scoreAfter) }}>{impact.scoreAfter}</span>
            </span>
          </div>
          <p className="text-faint leading-relaxed">
            Filling this order&apos;s full size pushes dealers shorter gamma: net GEX{" "}
            {fmtUsd(impact.netGexBefore)} → {fmtUsd(impact.netGexAfter)} per 1% move
            {impact.regimeAfter !== impact.regimeBefore
              ? ` — regime flips to ${impact.regimeAfter}.`
              : ` (${impact.regimeAfter} regime).`}
          </p>

          <div className="border-t border-edge/60 my-0.5" />

          <div className="flex items-center justify-between">
            <span className="text-muted">
              AI second opinion <span className="text-faint">(GonkaRouter)</span>
            </span>
            {aiRisk && (
              <span className="num font-semibold" style={{ color: riskColor(aiRisk.score) }}>
                {aiRisk.score}
              </span>
            )}
          </div>
          {aiRisk ? (
            <>
              <p className="text-faint leading-relaxed">{aiRisk.rationale}</p>
              <p className="text-faint text-[11px]">
                {aiRisk.label} · {Math.round(aiRisk.confidence * 100)}% confidence · read at{" "}
                {new Date(aiRisk.generatedAt).toLocaleTimeString([], { hour12: false })}
              </p>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onGetAiRead}
                disabled={aiRiskLoading}
                className="self-start rounded-md border border-edge px-2.5 py-1 text-[12px] font-medium text-fg hover:bg-panel2 disabled:opacity-60"
              >
                {aiRiskLoading ? "Asking the model…" : "Get AI read"}
              </button>
              {aiRiskError && !aiRiskLoading && (
                <p className="text-crit text-[11px]">Unavailable — {aiRiskError}</p>
              )}
            </>
          )}
        </div>
      ) : (
        <p className="text-faint">No greeks on this order — risk impact unavailable.</p>
      )}
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
