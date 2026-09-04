"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { useAccount, useBytecode, useReadContract } from "wagmi";
import { zeroHash, type Address } from "viem";
import type { Asset } from "@/lib/assets";
import type { ThetanutsPosition } from "@/lib/positions";
import { fmtContracts, fmtCountdown, fmtExpiryDate, fmtStrike, fmtUsd } from "@/lib/format";
import { ExplorerLink } from "./ExplorerLink";
import { mandateAccountFactoryAbi } from "@/lib/generated/contracts";
import { policyNetwork } from "@/lib/policyNetwork";
import { PositionStrategyPanel } from "./PositionStrategyPanel";

const policy = policyNetwork("mainnet");
type DisplayPosition = ThetanutsPosition & { custody: "wallet" | "policy" };

export function ThetanutsPositions({ asset, refreshKey = 0, fill = false }: { asset: Asset; refreshKey?: number; fill?: boolean }) {
  // One row expanded at a time, matching the OptionBook feed's drill-down.
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const { address } = useAccount();
  const { data: policyAccount } = useReadContract({
    address: policy.factory,
    abi: mandateAccountFactoryAbi,
    functionName: "getAddress",
    args: address ? [address, zeroHash] : undefined,
    chainId: 8453,
    query: { enabled: Boolean(address && policy.factory) },
  });
  const { data: policyBytecode } = useBytecode({ address: policyAccount, chainId: 8453, query: { enabled: Boolean(policyAccount) } });
  const deployedPolicy = policyBytecode != null && policyBytecode !== "0x";
  const [positions, setPositions] = useState<DisplayPosition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const load = useCallback(async (wallet: string, account?: Address) => {
    setRefreshing(true);
    setError(null);
    try {
      const buyers = [wallet, ...(account && account.toLowerCase() !== wallet.toLowerCase() ? [account] : [])];
      const responses = await Promise.all(buyers.map(async (buyer) => {
        const res = await fetch(`/api/positions?address=${encodeURIComponent(buyer)}`, { cache: "no-store" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `positions ${res.status}`);
        return { buyer, positions: data.positions as ThetanutsPosition[] };
      }));
      setPositions(responses.flatMap(({ buyer, positions: current }) => current.map((position) => ({ ...position, custody: account && buyer.toLowerCase() === account.toLowerCase() ? "policy" as const : "wallet" as const }))));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load Thetanuts positions");
    } finally {
      setLoaded(true);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!address) return;
    const id = setTimeout(() => void load(address, deployedPolicy ? policyAccount : undefined), 0);
    return () => clearTimeout(id);
  }, [address, deployedPolicy, load, policyAccount]);

  useEffect(() => {
    if (!address || !refreshKey) return;
    const retry = setTimeout(() => void load(address, deployedPolicy ? policyAccount : undefined), 8_000);
    return () => clearTimeout(retry);
  }, [address, deployedPolicy, load, policyAccount, refreshKey]);

  const filtered = positions.filter((position) => position.asset === asset);
  if (!address) return <Empty label="Connect wallet from the top bar to view Base-mainnet Thetanuts positions." />;
  if (!loaded) return <p className="px-5 py-10 text-center text-[12px] text-faint">Reading Thetanuts indexer…</p>;
  if (error) return <Empty action={() => void load(address, deployedPolicy ? policyAccount : undefined)} label={error} />;
  if (!filtered.length) return <Empty action={() => void load(address, deployedPolicy ? policyAccount : undefined)} label={`No open ${asset} positions indexed for ${deployedPolicy ? "this wallet or policy account" : "this wallet"}.`} />;

  return (
    <div className={`feed-scroll overflow-auto grow min-h-0 ${fill ? "" : "max-h-[430px]"}`}>
      <div className="flex items-center justify-end gap-2 px-4 pt-2 text-[10px] text-faint">
        <span>{refreshing ? "Refreshing…" : deployedPolicy ? "Wallet + policy account · Thetanuts indexer" : "Thetanuts indexer"}</span>
        <button onClick={() => void load(address, deployedPolicy ? policyAccount : undefined)} disabled={refreshing} aria-label="Refresh Thetanuts positions" title="Refresh Thetanuts positions" className="text-blue hover:text-fg disabled:opacity-50">↻</button>
      </div>
      <table className="w-full min-w-[560px] text-[12px]">
        <thead className="sticky top-0 bg-panel z-10 text-[10px] text-faint"><tr>
          <th className="text-left font-medium px-4 py-1.5">Type</th><th className="text-right font-medium px-2 py-1.5">Strike</th><th className="text-right font-medium px-2 py-1.5">Expiry</th><th className="text-right font-medium px-2 py-1.5">PnL</th><th className="text-right font-medium px-2 py-1.5">Contracts</th><th className="text-right font-medium px-4 py-1.5">Transaction</th>
        </tr></thead>
        <tbody className="font-mono text-[11px]">{filtered.map((position) => {
          const key = `${position.custody}-${position.id}`;
          const expanded = expandedKey === key;
          return (
          <Fragment key={key}>
          <tr
            onClick={() => setExpandedKey((current) => (current === key ? null : key))}
            aria-expanded={expanded}
            className={`border-t border-edge/50 cursor-pointer transition-colors hover:bg-panel2/60 ${expanded ? "bg-panel2/60" : ""}`}
          >
          <td className="px-4 py-2 font-sans"><span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${position.isCall ? "text-calm bg-calm/10" : "text-crit bg-crit/10"}`}>{position.isCall ? "CALL" : "PUT"}</span>{position.custody === "policy" && <span className="ml-1 text-[9px] font-semibold text-blue">AGENT</span>}<span className="ml-1.5 text-[10px] text-faint">{position.status}</span></td>
          <td className="px-2 py-2 text-right num text-fg">{fmtStrike(position.strike)}</td>
          <td className="px-2 py-2 text-right text-muted whitespace-nowrap">{fmtExpiryDate(position.expiryTs)} <span className="text-faint">· {fmtCountdown(position.expiryTs, now)}</span></td>
          <td className="px-2 py-2 text-right num" title="Reported by the Thetanuts indexer.">{position.pnlUsd == null ? <span className="text-faint">—</span> : <span style={{ color: position.pnlUsd >= 0 ? "var(--calm)" : "var(--crit)" }}>{position.pnlUsd >= 0 ? "+" : "−"}{fmtUsd(Math.abs(position.pnlUsd), false, 6)}</span>}</td>
          <td className="px-2 py-2 text-right num text-fg">{fmtContracts(position.contracts)}</td>
          <td className="px-4 py-2 text-right">{position.entryTxHash ? <ExplorerLink network="mainnet" resource="tx" value={position.entryTxHash} className="text-blue hover:underline">View fill</ExplorerLink> : <span className="text-faint">—</span>}</td>
          </tr>
          {expanded && (
            <tr className="bg-panel2/40">
              <td colSpan={6} className="px-4 py-3">
                <PositionStrategyPanel
                  position={{ id: position.id, asset: position.asset, isCall: position.isCall, strike: position.strike, expiryTs: position.expiryTs, contracts: position.contracts, custody: position.custody }}
                  network="mainnet"
                  policyAccount={deployedPolicy ? policyAccount : null}
                />
              </td>
            </tr>
          )}
          </Fragment>
          );
        })}</tbody>
      </table>
      <p className="px-4 py-2 text-[10px] text-faint">Open OptionBook positions, including indexer-reported PnL. New fills can take a short time to index.</p>
    </div>
  );
}

function Empty({ action, label }: { action?: () => void; label: string }) {
  return <div className="px-5 py-10 text-center text-[12px] text-faint"><p>{label}</p>{action && <button onClick={action} className="mt-3 text-blue hover:underline">Refresh</button>}</div>;
}
