"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { useAccount, useBytecode, useReadContract } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import { isAddress, zeroHash, type Address } from "viem";
import type { Asset } from "@/lib/assets";
import type { ShadowPosition } from "@/lib/shadow";
import { mandateAccountFactoryAbi } from "@/lib/generated/contracts";
import { fmtContracts, fmtCountdown, fmtExpiryDate, fmtStrike, fmtUsd } from "@/lib/format";
import { ExplorerLink } from "./ExplorerLink";
import { PositionStrategyPanel } from "./PositionStrategyPanel";
import type { PositionChangeDetail } from "@/lib/positionEvents";

const factoryFromEnv = process.env.NEXT_PUBLIC_BASE_SEPOLIA_MANDATE_FACTORY_ADDRESS;
const FACTORY_ADDRESS: Address | undefined = factoryFromEnv && isAddress(factoryFromEnv) ? factoryFromEnv : undefined;
type DisplayPosition = ShadowPosition & { custody: "wallet" | "policy" };
const POLL_INTERVAL_MS = 4_000;
const POLL_MAX_ATTEMPTS = 10;

// buyShadow() always signs from the connected wallet, never a policy
// account, same as the mainnet buy path — so a pending row is always
// "wallet" custody. Negative ids can never collide with a real receipt id;
// deriving it from the tx hash (rather than a counter) keeps this pure and
// safe to compute during render.
function pendingIdFromTxHash(txHash: string): number {
  const n = parseInt(txHash.replace(/^0x/, "").slice(-8) || "0", 16);
  return -(Number.isFinite(n) ? n : 0) - 1;
}

function pendingToDisplay(p: PositionChangeDetail, buyer: string): DisplayPosition | null {
  if (p.isCall == null || p.strike == null || p.expiryTs == null || p.contracts == null || p.premiumUsd == null) return null;
  return {
    id: pendingIdFromTxHash(p.txHash),
    closedAt: null,
    buyer,
    asset: p.asset,
    isCall: p.isCall,
    strike: p.strike,
    expiryTs: p.expiryTs,
    contracts: p.contracts,
    premiumUsd: p.premiumUsd,
    txHash: p.txHash,
    mark: null,
    custody: "wallet",
  };
}

export function ShadowPositions({
  asset,
  refreshKey = 0,
  fill = false,
  pendingFill = null,
}: {
  asset: Asset;
  refreshKey?: number;
  fill?: boolean;
  pendingFill?: PositionChangeDetail | null;
}) {
  // One row expanded at a time, matching the OptionBook feed's drill-down.
  // A closed receipt is history, so it never opens.
  const [expandedKey, setExpandedKey] = useState<number | null>(null);
  const { address } = useAccount();
  const { data: policyAccount } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: mandateAccountFactoryAbi,
    functionName: "getAddress",
    args: address ? [address, zeroHash] : undefined,
    chainId: baseSepolia.id,
    query: { enabled: Boolean(address && FACTORY_ADDRESS) },
  });
  const { data: policyBytecode } = useBytecode({
    address: policyAccount,
    chainId: baseSepolia.id,
    query: { enabled: Boolean(policyAccount) },
  });
  const deployedPolicy = policyBytecode != null && policyBytecode !== "0x";
  const [positions, setPositions] = useState<DisplayPosition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [optimistic, setOptimistic] = useState<DisplayPosition | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => clearInterval(id);
  }, []);

  const load = useCallback(async (wallet: string, policy?: string) => {
    setRefreshing(true);
    setError(null);
    try {
      const buyers = [wallet];
      if (policy && policy.toLowerCase() !== wallet.toLowerCase()) buyers.push(policy);
      const query = new URLSearchParams();
      buyers.forEach((buyer) => query.append("buyer", buyer));
      const res = await fetch(`/api/shadow/positions?${query}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `positions ${res.status}`);
      setPositions((data.positions as ShadowPosition[]).map((position) => ({
        ...position,
        custody: policy && position.buyer.toLowerCase() === policy.toLowerCase() ? "policy" : "wallet",
      })));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load shadow positions");
    } finally {
      setLoaded(true);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!address) return;
    const policy = deployedPolicy ? policyAccount : undefined;
    const initial = setTimeout(() => void load(address, policy), 0);
    const id = setInterval(() => void load(address, policy), 10_000);
    return () => {
      clearTimeout(initial);
      clearInterval(id);
    };
  }, [address, deployedPolicy, load, policyAccount]);

  // A fresh fill: show it immediately as a pending row, and catch up the
  // steady 10s poll above with a faster one until it's found.
  const [lastPendingTxHash, setLastPendingTxHash] = useState<string | null>(null);
  if (pendingFill && pendingFill.txHash !== lastPendingTxHash) {
    setLastPendingTxHash(pendingFill.txHash);
    const display = pendingToDisplay(pendingFill, address ?? pendingFill.txHash);
    if (display) setOptimistic(display);
  }

  useEffect(() => {
    if (!address || !refreshKey) return;
    const policy = deployedPolicy ? policyAccount : undefined;
    let attempts = 0;
    const poll = () => {
      attempts += 1;
      void load(address, policy);
      if (attempts >= POLL_MAX_ATTEMPTS) clearInterval(interval);
    };
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    poll();
    return () => clearInterval(interval);
  }, [address, deployedPolicy, load, policyAccount, refreshKey]);

  const confirmedTxHashes = new Set(
    positions.flatMap((p) => (p.txHash ? [p.txHash.toLowerCase()] : [])),
  );
  const optimisticStillPending = optimistic && !confirmedTxHashes.has((optimistic.txHash ?? "").toLowerCase());
  const displayPositions = optimisticStillPending ? [optimistic!, ...positions] : positions;
  const filtered = displayPositions.filter((position) => position.asset === asset);
  if (!address) {
    return <Empty fill={fill} label="Connect wallet from the top bar to view Base Sepolia shadow positions." />;
  }
  if (!loaded) return <Empty fill={fill} label="Reading shadow positions…" />;
  if (error) return <Empty fill={fill} action={() => void load(address, deployedPolicy ? policyAccount : undefined)} label={error} />;
  if (!filtered.length) return <Empty fill={fill} action={() => void load(address, deployedPolicy ? policyAccount : undefined)} label={`No ${asset} shadow positions for ${deployedPolicy ? "this wallet or policy account" : "this wallet"}.`} />;

  return (
    <div className={`feed-scroll overflow-auto grow min-h-0 ${fill ? "" : "max-h-[430px]"}`}>
      <div className="flex items-center justify-end gap-2 px-4 pt-2 text-[10px] text-faint">
        <span>{refreshing ? "Refreshing…" : deployedPolicy ? "Wallet + policy account · refreshes every 10s" : "Auto-refreshes every 10s"}</span>
        <button onClick={() => void load(address, deployedPolicy ? policyAccount : undefined)} disabled={refreshing} aria-label="Refresh shadow positions" title="Refresh shadow positions" className="text-blue hover:text-fg disabled:opacity-50">↻</button>
      </div>
      <table className="w-full min-w-[560px] text-[12px]">
        <thead className="sticky top-0 bg-panel z-10 text-[10px] text-faint">
          <tr>
            <th className="text-left font-medium px-4 py-1.5">Type</th>
            <th className="text-right font-medium px-2 py-1.5">Strike</th>
            <th className="text-right font-medium px-2 py-1.5">Expiry</th>
            <th className="text-right font-medium px-2 py-1.5">Premium</th>
            <th className="text-right font-medium px-2 py-1.5">Est. PnL</th>
            <th className="text-right font-medium px-2 py-1.5">Contracts</th>
            <th className="text-right font-medium px-4 py-1.5">Receipt</th>
          </tr>
        </thead>
        <tbody className="font-mono text-[11px]">
          {filtered.map((position) => {
            const expanded = expandedKey === position.id;
            const pending = position.id < 0;
            const openable = !position.closedAt && !pending;
            return (
            <Fragment key={position.id}>
            <tr
              onClick={() => openable && setExpandedKey((current) => (current === position.id ? null : position.id))}
              aria-expanded={openable ? expanded : undefined}
              className={`border-t border-edge/50 transition-colors ${openable ? "cursor-pointer hover:bg-panel2/60" : ""} ${pending ? "opacity-60" : ""} ${expanded ? "bg-panel2/60" : ""}`}
            >
              <td className="px-4 py-2 font-sans"><span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${position.isCall ? "text-calm bg-calm/10" : "text-crit bg-crit/10"}`}>{position.isCall ? "CALL" : "PUT"}</span>{position.custody === "policy" && <span className="ml-1 text-[9px] font-semibold text-blue">AGENT</span>}{pending && <span className="ml-1 text-[9px] font-semibold text-warn">PENDING · NOT YET INDEXED</span>}{position.closedAt && <span className="ml-1 text-[9px] font-semibold text-faint">CLOSED</span>}</td>
              <td className="px-2 py-2 text-right num text-fg">{fmtStrike(position.strike)}</td>
              <td className="px-2 py-2 text-right text-muted whitespace-nowrap">{fmtExpiryDate(position.expiryTs)} <span className="text-faint">· {fmtCountdown(position.expiryTs, now)}</span></td>
              <td className="px-2 py-2 text-right num text-fg">{fmtUsd(position.premiumUsd, false, 6)} USDC</td>
              <td className="px-2 py-2 text-right num" title={position.mark ? `Modeled from ${position.mark.source}; not a fillable Thetanuts price or settlement.` : "No live IV mark is available."}>
                {position.mark ? <><span style={{ color: position.mark.pnlUsd >= 0 ? "var(--calm)" : "var(--crit)" }}>{position.mark.pnlUsd >= 0 ? "+" : "−"}{fmtUsd(Math.abs(position.mark.pnlUsd), false, 6)}</span><span className="block text-[10px] text-faint">{position.mark.source}</span></> : <span className="text-faint">{position.closedAt ? "Closed by the agent" : pending ? "Indexing…" : "No live mark"}</span>}
              </td>
              <td className="px-2 py-2 text-right num text-fg">{fmtContracts(position.contracts)}</td>
              <td className="px-4 py-2 text-right">{position.txHash ? <ExplorerLink network="sepolia" resource="tx" value={position.txHash} className="text-blue hover:underline">View receipt</ExplorerLink> : <span className="text-muted">#{position.id}</span>}</td>
            </tr>
            {expanded && (
              <tr className="bg-panel2/40">
                <td colSpan={7} className="px-4 py-3">
                  <PositionStrategyPanel
                    position={{ id: String(position.id), asset: position.asset, isCall: position.isCall, strike: position.strike, expiryTs: position.expiryTs, contracts: position.contracts, custody: position.custody }}
                    network="sepolia"
                    policyAccount={deployedPolicy ? policyAccount : null}
                  />
                </td>
              </tr>
            )}
            </Fragment>
            );
          })}
        </tbody>
      </table>
      <p className="px-4 py-2 text-[10px] text-faint">Estimated PnL uses live spot and current Thetanuts IV; it is not a fillable price or settlement.</p>
    </div>
  );
}

/** Centered and grown to fill the card when `fill` is set — otherwise this
 *  message sits pinned to the top of a tall, mostly-blank column, which is
 *  exactly the "wasted space" a lone card on the AI Agent tab used to leave. */
function Empty({ action, label, fill }: { action?: () => void; label: string; fill?: boolean }) {
  return (
    <div className={`flex flex-col items-center justify-center gap-3 px-5 text-center text-[12px] text-faint ${fill ? "grow min-h-[160px]" : "py-10"}`}>
      <p>{label}</p>
      {action && <button onClick={action} className="text-blue hover:underline">Refresh</button>}
    </div>
  );
}
