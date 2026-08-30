"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import type { Asset } from "@/lib/assets";
import type { ThetanutsPosition } from "@/lib/positions";
import { fmtContracts, fmtCountdown, fmtExpiryDate, fmtStrike, fmtUsd } from "@/lib/format";

export function ThetanutsPositions({ asset, refreshKey = 0 }: { asset: Asset; refreshKey?: number }) {
  const { address } = useAccount();
  const [positions, setPositions] = useState<ThetanutsPosition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const load = useCallback(async (wallet: string) => {
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch(`/api/positions?address=${encodeURIComponent(wallet)}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `positions ${res.status}`);
      setPositions(data.positions);
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
    const id = setTimeout(() => void load(address), 0);
    return () => clearTimeout(id);
  }, [address, load]);

  useEffect(() => {
    if (!address || !refreshKey) return;
    const retry = setTimeout(() => void load(address), 8_000);
    return () => clearTimeout(retry);
  }, [address, load, refreshKey]);

  const filtered = positions.filter((position) => position.asset === asset);
  if (!address) return <Empty label="Connect wallet from the top bar to view Base-mainnet Thetanuts positions." />;
  if (!loaded) return <p className="px-5 py-10 text-center text-[12px] text-faint">Reading Thetanuts indexer…</p>;
  if (error) return <Empty action={() => void load(address)} label={error} />;
  if (!filtered.length) return <Empty action={() => void load(address)} label={`No open ${asset} positions indexed for this wallet.`} />;

  return (
    <div className="feed-scroll overflow-auto grow min-h-0 max-h-[430px]">
      <div className="flex items-center justify-end gap-2 px-4 pt-2 text-[10px] text-faint">
        <span>{refreshing ? "Refreshing…" : "Thetanuts indexer"}</span>
        <button onClick={() => void load(address)} disabled={refreshing} aria-label="Refresh Thetanuts positions" title="Refresh Thetanuts positions" className="text-blue hover:text-fg disabled:opacity-50">↻</button>
      </div>
      <table className="w-full min-w-[560px] text-[12px]">
        <thead className="sticky top-0 bg-panel z-10 text-[10px] text-faint"><tr>
          <th className="text-left font-medium px-4 py-1.5">Type</th><th className="text-right font-medium px-2 py-1.5">Strike</th><th className="text-right font-medium px-2 py-1.5">Expiry</th><th className="text-right font-medium px-2 py-1.5">PnL</th><th className="text-right font-medium px-2 py-1.5">Contracts</th><th className="text-right font-medium px-4 py-1.5">Transaction</th>
        </tr></thead>
        <tbody className="font-mono text-[11px]">{filtered.map((position) => <tr key={position.id} className="border-t border-edge/50">
          <td className="px-4 py-2 font-sans"><span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${position.isCall ? "text-calm bg-calm/10" : "text-crit bg-crit/10"}`}>{position.isCall ? "CALL" : "PUT"}</span><span className="ml-1.5 text-[10px] text-faint">{position.status}</span></td>
          <td className="px-2 py-2 text-right num text-fg">{fmtStrike(position.strike)}</td>
          <td className="px-2 py-2 text-right text-muted whitespace-nowrap">{fmtExpiryDate(position.expiryTs)} <span className="text-faint">· {fmtCountdown(position.expiryTs, now)}</span></td>
          <td className="px-2 py-2 text-right num" title="Reported by the Thetanuts indexer.">{position.pnlUsd == null ? <span className="text-faint">—</span> : <span style={{ color: position.pnlUsd >= 0 ? "var(--calm)" : "var(--crit)" }}>{position.pnlUsd >= 0 ? "+" : "−"}{fmtUsd(Math.abs(position.pnlUsd), false, 6)}</span>}</td>
          <td className="px-2 py-2 text-right num text-fg">{fmtContracts(position.contracts)}</td>
          <td className="px-4 py-2 text-right">{position.entryTxHash ? <a href={`${process.env.NEXT_PUBLIC_BASE_EXPLORER_URL ?? "https://basescan.org"}/tx/${position.entryTxHash}`} target="_blank" rel="noopener noreferrer" className="text-blue hover:underline">View fill</a> : <span className="text-faint">—</span>}</td>
        </tr>)}</tbody>
      </table>
      <p className="px-4 py-2 text-[10px] text-faint">Open OptionBook positions, including indexer-reported PnL. New fills can take a short time to index.</p>
    </div>
  );
}

function Empty({ action, label }: { action?: () => void; label: string }) {
  return <div className="px-5 py-10 text-center text-[12px] text-faint"><p>{label}</p>{action && <button onClick={action} className="mt-3 text-blue hover:underline">Refresh</button>}</div>;
}
