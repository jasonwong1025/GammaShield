"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { useAccount, useBalance, useReadContracts } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { isAddress, zeroAddress, type Address } from "viem";
import type { FeedRow } from "@/lib/snapshot";
import type { AssetSnapshot, StrikeGex } from "@/lib/engine";
import type { Asset } from "@/lib/assets";
import type { AiRiskAssessment } from "@/lib/aiRisk";
import { erc20Abi } from "@/lib/generated/contracts";
import {
  fmtCountdown,
  fmtExpiryDate,
  fmtIv,
  fmtStrike,
  fmtUsd,
  riskColor,
} from "@/lib/format";
import { ContractRiskPanel, RiskScoreChip } from "./ContractRiskPanel";
import { MarketImpactPanel } from "./MarketImpactPanel";
import { ShadowPositions } from "./ShadowPositions";
import { ThetanutsPositions } from "./ThetanutsPositions";
import { EXECUTION_NETWORK } from "@/lib/explorer";
import { useExecutionNetwork } from "./ExecutionNetworkProvider";
import { POSITION_CHANGED_EVENT, type PositionChangeDetail } from "@/lib/positionEvents";

type BookCardTab = "book" | "expiries" | "positions";

const ALL_TABS: readonly BookCardTab[] = ["book", "expiries", "positions"];

const shadowUsdcFromEnv = process.env.NEXT_PUBLIC_BASE_SEPOLIA_SHADOW_USDC_ADDRESS;
const SHADOW_USDC_ADDRESS: Address | undefined =
  shadowUsdcFromEnv && isAddress(shadowUsdcFromEnv) ? shadowUsdcFromEnv : undefined;

export function BookCard({
  rows,
  snap,
  asset,
  live,
  spot,
  volBaseline,
  fill = false,
  tabs = ALL_TABS,
  onBuyRow,
}: {
  rows: FeedRow[];
  snap: AssetSnapshot;
  asset: Asset;
  /** True for BTC/ETH (real Thetanuts OptionBook); false = modeled book. */
  live: boolean;
  /** Live spot price — informational context for the AI risk read. */
  spot: number;
  /** Realized-vol reference behind the IV component of contract risk. */
  volBaseline?: { vol: number; windowDays: number; lookbackDays: number; source: string } | null;
  /** True when this card is the only thing in its column and should grow to
   *  fill it, instead of capping its list at a fixed height. On the
   *  Dashboard, BookCard is one of three stacked cards, so the cap keeps
   *  it from crowding out its siblings; on the AI Agent tab it is alone in
   *  the side rail, and the cap used to leave the rest of the column blank. */
  fill?: boolean;
  /** Which tabs this instance offers. Defaults to all three; the Dashboard
   *  and AI Agent tab each surface a different subset of this same card. */
  tabs?: readonly BookCardTab[];
  /** Targets a specific book row for purchase (opens it in the trade panel).
   *  Omitted where there's no trade panel to target, e.g. the AI Agent tab. */
  onBuyRow?: (row: FeedRow) => void;
}) {
  const [tab, setTab] = useState<BookCardTab>(tabs[0]);
  const [positionsRefresh, setPositionsRefresh] = useState(0);
  const [pendingFill, setPendingFill] = useState<PositionChangeDetail | null>(null);
  const { network } = useExecutionNetwork();
  useEffect(() => {
    const showPosition = (e: Event) => {
      const detail = (e as CustomEvent<PositionChangeDetail>).detail;
      setPositionsRefresh((value) => value + 1);
      if (detail) setPendingFill(detail);
      if (tabs.includes("positions")) setTab("positions");
    };
    window.addEventListener(POSITION_CHANGED_EVENT, showPosition);
    return () => window.removeEventListener(POSITION_CHANGED_EVENT, showPosition);
  }, [tabs]);

  // A per-row Buy button (see BookTable) only targets an order for the
  // trade panel — the real approve/preflight/fill still happens there. But
  // greying it out for insufficient balance needs real numbers, checked
  // against each row's own settlement token — book orders often settle in a
  // wrapped variant (aBasUSDC/aBasWETH/aBascbBTC), not the plain
  // USDC/WETH/cbBTC RFQs use, so guessing a fixed token gets it wrong. Batch
  // one multicall for the small set of distinct tokens actually resting in
  // this asset's book, rather than a read per row.
  //
  // Row clicks can now fill against either network (ShadowOptionBook mirrors
  // this exact strike/expiry, see lib/shadow.ts), so the check has to follow
  // whichever network the execution toggle is on rather than hardcoding Base
  // mainnet — a shadow-mode wallet with no mainnet ETH would otherwise always
  // read as "insufficient", even with plenty of Sepolia test funds.
  const { address: walletAddress } = useAccount();
  const executionChainId = network === "mainnet" ? base.id : baseSepolia.id;
  const distinctTokens =
    onBuyRow && network === "mainnet"
      ? [
          ...new Map(
            rows
              .filter((r) => r.collateralToken)
              .map((r) => [r.collateralToken!.address.toLowerCase(), r.collateralToken!] as const),
          ).values(),
        ]
      : [];
  const { data: tokenBalanceResults } = useReadContracts({
    contracts: distinctTokens.map((t) => ({
      address: t.address as Address,
      abi: erc20Abi,
      functionName: "balanceOf" as const,
      args: [walletAddress ?? zeroAddress] as const,
      chainId: base.id,
    })),
    query: { enabled: Boolean(onBuyRow && walletAddress && distinctTokens.length) },
  });
  // Shadow mode always settles in the one fixed test-USDC token regardless of
  // side (lib/shadow.ts's fillShadow), unlike mainnet's per-side collateral.
  const { data: shadowUsdcBalanceData } = useReadContracts({
    contracts: [
      {
        address: (SHADOW_USDC_ADDRESS ?? zeroAddress) as Address,
        abi: erc20Abi,
        functionName: "balanceOf" as const,
        args: [walletAddress ?? zeroAddress] as const,
        chainId: baseSepolia.id,
      },
    ],
    query: { enabled: Boolean(onBuyRow && walletAddress && network === "sepolia" && SHADOW_USDC_ADDRESS) },
  });
  const { data: ethBalanceData } = useBalance({
    address: walletAddress,
    chainId: executionChainId,
    query: { enabled: Boolean(onBuyRow && walletAddress) },
  });
  const tokenBalances = new Map<string, number>(
    distinctTokens.map((t, i) => {
      const raw = tokenBalanceResults?.[i];
      const value = raw?.status === "success" ? Number(raw.result as bigint) / 10 ** t.decimals : NaN;
      return [t.address.toLowerCase(), value];
    }),
  );
  const shadowUsdcRaw = shadowUsdcBalanceData?.[0];
  const shadowUsdcBalance =
    shadowUsdcRaw?.status === "success" ? Number(shadowUsdcRaw.result as bigint) / 1e6 : NaN;
  const ethBalance = ethBalanceData ? Number(ethBalanceData.value) / 1e18 : null;

  // The same 1-contract-or-less size TradePanel defaults to for a fresh
  // quote; the real fill amount and its exact required collateral are only
  // known once the panel fetches an authoritative quote for this order.
  // Returns why it's unaffordable (gas vs. the specific settlement token),
  // not just whether — a bare "insufficient balance" reads as a bug when the
  // one token the user checked (often not the one actually short) is fine.
  const rowInsufficientReason = (row: FeedRow): string | null => {
    if (!walletAddress) return null;
    if (ethBalance != null && ethBalance < 0.0003) {
      return network === "mainnet" ? "Insufficient ETH for gas" : "Insufficient Sepolia ETH for gas";
    }
    if (row.pricePerContractUsd == null) return null;
    if (network === "sepolia") {
      if (Number.isNaN(shadowUsdcBalance) || shadowUsdcBalance >= row.pricePerContractUsd) return null;
      return `Insufficient USDC balance — need ~${row.pricePerContractUsd.toPrecision(3)}, have ${shadowUsdcBalance.toPrecision(3)}`;
    }
    if (!row.collateralToken) return null;
    const requiredToken = row.isCall ? row.pricePerContractUsd / Math.max(spot, 1) : row.pricePerContractUsd;
    const balance = tokenBalances.get(row.collateralToken.address.toLowerCase());
    if (balance == null || Number.isNaN(balance) || balance >= requiredToken) return null;
    return `Insufficient ${row.collateralToken.symbol} balance — need ~${requiredToken.toPrecision(3)}, have ${balance.toPrecision(3)}`;
  };
  const filtered = rows.filter((r) => r.asset === asset);
  const bookLabel = live ? "OptionBook (live)" : "Modeled book";
  const labelOf: Record<BookCardTab, string> = {
    book: bookLabel,
    expiries: "Expiries",
    positions: "My positions",
  };

  return (
    <section className={`card flex flex-col min-h-0 overflow-hidden ${fill ? "flex-1" : ""}`} aria-label={bookLabel}>
      <div className="flex items-center justify-between px-5 pt-4 pb-3">
        {tabs.length > 1 ? (
          <div className="flex items-center gap-1 rounded-lg bg-panel2 p-0.5">
            {tabs.map((key) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                aria-pressed={tab === key}
                className={`h-7 whitespace-nowrap rounded-md px-2.5 text-[12px] font-medium transition ${
                  tab === key ? "bg-panel3 text-fg" : "text-muted hover:text-fg"
                }`}
              >
                {labelOf[key]}
              </button>
            ))}
          </div>
        ) : (
          <span className="text-[12px] font-medium text-fg">{labelOf[tab]}</span>
        )}
        <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[11px] text-muted">
          {live && <span className="live-dot inline-block size-1.5 rounded-full bg-calm" />}
          {tab === "book" ? `${filtered.length} orders` : tab === "expiries" ? `${snap.expiries.length} dates` : EXECUTION_NETWORK[network].label}
        </span>
      </div>

      {tab === "book" ? (
        <BookTable
          rows={filtered}
          asset={asset}
          spot={spot}
          volBaseline={volBaseline}
          gexByStrike={snap.gexByStrike}
          fill={fill}
          onBuyRow={onBuyRow}
          rowInsufficientReason={rowInsufficientReason}
        />
      ) : tab === "expiries" ? (
        <Expiries snap={snap} fill={fill} />
      ) : network === "mainnet" ? (
        <ThetanutsPositions
          asset={asset}
          refreshKey={positionsRefresh}
          fill={fill}
          pendingFill={pendingFill?.network === "mainnet" && pendingFill.asset === asset ? pendingFill : null}
        />
      ) : (
        <ShadowPositions
          asset={asset}
          refreshKey={positionsRefresh}
          fill={fill}
          pendingFill={pendingFill?.network === "shadow" && pendingFill.asset === asset ? pendingFill : null}
        />
      )}
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

function BookTable({
  rows,
  asset,
  spot,
  volBaseline,
  gexByStrike,
  fill = false,
  onBuyRow,
  rowInsufficientReason,
}: {
  rows: FeedRow[];
  asset: string;
  spot: number;
  volBaseline?: { vol: number; windowDays: number; lookbackDays: number; source: string } | null;
  /** Strike ladder for this asset — one array shared by every row's market
   *  impact estimate, rather than repeated on all 200 of them. */
  gexByStrike: StrikeGex[];
  fill?: boolean;
  onBuyRow?: (row: FeedRow) => void;
  rowInsufficientReason?: (row: FeedRow) => string | null;
}) {
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
    <div className={`feed-scroll overflow-auto grow min-h-0 ${fill ? "" : "max-h-[430px]"}`}>
      <table className="w-full min-w-[560px] text-[12px]">
        <thead className="sticky top-0 bg-panel z-10">
          <tr className="text-[10px] text-faint">
            <th className="text-left font-medium px-4 py-1.5">Type</th>
            <th className="text-right font-medium px-2 py-1.5">Strike</th>
            <th className="text-right font-medium px-2 py-1.5">Expiry</th>
            <th className="text-right font-medium px-2 py-1.5">Premium</th>
            <th className="text-right font-medium px-2 py-1.5">Delta</th>
            <th className="text-right font-medium px-2 py-1.5">IV</th>
            <th className="text-right font-medium px-2 py-1.5">Size</th>
            <th className="text-right font-medium px-4 py-1.5" title="Per-contract risk, 0-100">
              Risk
            </th>
            {onBuyRow && <th className="text-right font-medium px-4 py-1.5">Trade</th>}
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
                  <td className="px-2 py-1.5 text-right num text-fg">{fmtUsd(r.collateralUsd)}</td>
                  <td className="px-4 py-1.5 text-right">
                    <RiskScoreChip risk={r.risk} />
                  </td>
                  {onBuyRow && (
                    <td className="px-4 py-1.5 text-right">
                      {r.strikes.length === 1 && r.takerIsLong ? (
                        (() => {
                          const reason = rowInsufficientReason?.(r) ?? null;
                          return (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onBuyRow(r);
                              }}
                              disabled={!!reason}
                              title={reason ?? "Buy this exact listed order"}
                              className="rounded-md bg-blue px-2.5 py-1 text-[11px] font-semibold text-white hover:brightness-110 transition disabled:opacity-40"
                            >
                              Buy
                            </button>
                          );
                        })()
                      ) : (
                        <span
                          className="text-faint"
                          title="Multi-leg orders can't be filled directly — GammaShield doesn't submit atomic multi-leg fills."
                        >
                          —
                        </span>
                      )}
                    </td>
                  )}
                </tr>
                {expanded && (
                  <tr key={`${key}-detail`} className="border-t border-edge/50">
                    <td colSpan={onBuyRow ? 9 : 8} className="px-4 py-3 bg-panel2/40 font-sans">
                      <RowRiskDetail
                        row={r}
                        volBaseline={volBaseline}
                        gexByStrike={gexByStrike}
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
              <td colSpan={onBuyRow ? 9 : 8} className="px-5 py-10 text-center text-faint font-sans">
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
  volBaseline,
  gexByStrike,
  aiRisk,
  aiRiskLoading,
  aiRiskError,
  onGetAiRead,
}: {
  row: FeedRow;
  volBaseline?: { vol: number; windowDays: number; lookbackDays: number; source: string } | null;
  gexByStrike: StrikeGex[];
  aiRisk: AiRiskAssessment | null;
  aiRiskLoading: boolean;
  aiRiskError: string | null;
  onGetAiRead: () => void;
}) {
  return (
    <div className="flex flex-col gap-2.5 text-[12px]" onClick={(e) => e.stopPropagation()}>
      <div className="grid grid-cols-5 gap-x-3 gap-y-1 num text-muted">
        <span>Delta <span className="text-fg">{fmtGreek(row.delta, 3)}</span></span>
        <span>Gamma <span className="text-fg">{fmtGreek(row.gamma, 5)}</span></span>
        <span>Theta <span className="text-fg">{fmtGreek(row.theta, 2)}</span></span>
        <span>Vega <span className="text-fg">{fmtGreek(row.vega, 2)}</span></span>
        <span>Rho <span className="text-fg">{fmtGreek(row.rho, 2)}</span></span>
      </div>

      {row.risk ? (
        <ContractRiskPanel risk={row.risk} volBaseline={volBaseline} />
      ) : (
        <p className="text-faint">
          {row.strikes.length > 1
            ? "Multi-leg order — the pricing API returns one blended premium and greeks block, so per-leg contract risk is not scored."
            : "No greeks or premium on this order — contract risk unavailable."}
        </p>
      )}

      {row.impactBasis ? (
        <MarketImpactPanel
          basis={{ ...row.impactBasis, gexByStrike }}
          defaultContracts={row.collateralUsd / Math.max(row.strike, 1)}
          asset={row.asset}
        >
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-muted text-[12px] font-medium">
                AI desk explainer <span className="text-faint font-normal">(GonkaRouter)</span>
              </span>
              {aiRisk && (
                <span
                  className="eyebrow rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
                  style={{
                    color: riskColor(aiRisk.score),
                    backgroundColor: `color-mix(in srgb, ${riskColor(aiRisk.score)} 15%, transparent)`,
                  }}
                >
                  {aiRisk.label}
                </span>
              )}
            </div>
            {aiRisk ? (
              <div className="flex flex-col gap-1.5 rounded-lg border border-edge bg-panel2 p-2.5 text-[12px]">
                <p className="font-semibold text-fg leading-snug">
                  {aiRisk.verdict || aiRisk.rationale}
                </p>
                {aiRisk.rationale && aiRisk.verdict && (
                  <p className="text-muted text-[11px] leading-relaxed">
                    {aiRisk.rationale}
                  </p>
                )}
                {aiRisk.keyPoints && aiRisk.keyPoints.length > 0 && (
                  <ul className="mt-1 flex flex-col gap-1 border-t border-edge/60 pt-1.5 text-[11px] text-faint">
                    {aiRisk.keyPoints.map((pt, i) => (
                      <li key={i} className="flex items-start gap-1.5">
                        <span className="text-blue shrink-0">•</span>
                        <span>{pt}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-0.5 flex items-center justify-between text-[10px] text-faint">
                  <span>AI Risk Explainer ({aiRisk.model.split("/").pop()})</span>
                  <span>
                    Read at {new Date(aiRisk.generatedAt).toLocaleTimeString([], { hour12: false })}
                  </span>
                </div>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onGetAiRead}
                  disabled={aiRiskLoading}
                  className="self-start rounded-md border border-edge px-2.5 py-1 text-[12px] font-medium text-fg hover:bg-panel2 disabled:opacity-60 transition"
                >
                  {aiRiskLoading ? "Analyzing market structure…" : "Get AI read"}
                </button>
                {aiRiskError && !aiRiskLoading && (
                  <p className="text-crit text-[11px]">Unavailable — {aiRiskError}</p>
                )}
              </>
            )}
          </div>
        </MarketImpactPanel>
      ) : (
        <p className="text-faint">No greeks on this order — market impact unavailable.</p>
      )}
    </div>
  );
}

function Expiries({ snap, fill = false }: { snap: AssetSnapshot; fill?: boolean }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => clearInterval(id);
  }, []);

  const top = snap.expiries;
  const maxNotional = Math.max(...top.map((e) => e.notionalUsd), 1);

  return (
    <div className={`feed-scroll overflow-y-auto grow min-h-0 ${fill ? "" : "max-h-[430px]"} px-5 pb-4 flex flex-col gap-2.5`}>
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
