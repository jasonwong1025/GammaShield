"use client";

import { useCallback, useEffect, useState } from "react";
import type { Asset } from "@/lib/assets";
import type { ShadowPosition } from "@/lib/shadow";
import { fmtCountdown, fmtExpiryDate, fmtStrike, fmtUsd } from "@/lib/format";
import { getActiveProvider } from "./WalletConnect";

export function ShadowPositions({ asset }: { asset: Asset }) {
  const [address, setAddress] = useState<string | null>(null);
  const [positions, setPositions] = useState<ShadowPosition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => clearInterval(id);
  }, []);

  const load = useCallback(async (buyer: string) => {
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch(`/api/shadow/positions?buyer=${buyer}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `positions ${res.status}`);
      setPositions(data.positions);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load shadow positions");
    } finally {
      setLoaded(true);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const provider = getActiveProvider();
    if (!provider) return;
    provider.request({ method: "eth_accounts" }).then((accounts) => {
      const buyer = (accounts as string[])[0];
      if (buyer) setAddress(buyer);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!address) return;
    const initial = setTimeout(() => void load(address), 0);
    const id = setInterval(() => void load(address), 10_000);
    return () => {
      clearTimeout(initial);
      clearInterval(id);
    };
  }, [address, load]);

  const connect = async () => {
    const provider = getActiveProvider();
    if (!provider) return setError("Connect a wallet to view shadow positions");
    const buyer = ((await provider.request({ method: "eth_requestAccounts" })) as string[])[0];
    if (!buyer) return;
    setAddress(buyer);
  };

  const filtered = positions.filter((position) => position.asset === asset);
  if (!address) {
    return <Empty action={connect} label="Connect wallet to view Base Sepolia shadow positions." />;
  }
  if (!loaded) return <p className="px-5 py-10 text-center text-[12px] text-faint">Reading shadow positions…</p>;
  if (error) return <Empty action={() => void load(address)} label={error} />;
  if (!filtered.length) return <Empty action={() => void load(address)} label={`No ${asset} shadow positions for this wallet.`} />;

  return (
    <div className="feed-scroll overflow-auto grow min-h-0 max-h-[430px]">
      <div className="flex items-center justify-end gap-2 px-4 pt-2 text-[10px] text-faint">
        <span>{refreshing ? "Refreshing…" : "Auto-refreshes every 10s"}</span>
        <button onClick={() => void load(address)} disabled={refreshing} aria-label="Refresh shadow positions" title="Refresh shadow positions" className="text-blue hover:text-fg disabled:opacity-50">↻</button>
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
          {filtered.map((position) => (
            <tr key={position.id} className="border-t border-edge/50">
              <td className="px-4 py-2 font-sans"><span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${position.isCall ? "text-calm bg-calm/10" : "text-crit bg-crit/10"}`}>{position.isCall ? "CALL" : "PUT"}</span></td>
              <td className="px-2 py-2 text-right num text-fg">{fmtStrike(position.strike)}</td>
              <td className="px-2 py-2 text-right text-muted whitespace-nowrap">{fmtExpiryDate(position.expiryTs)} <span className="text-faint">· {fmtCountdown(position.expiryTs, now)}</span></td>
              <td className="px-2 py-2 text-right num text-fg">{fmtUsd(position.premiumUsd, false, 6)} USDC</td>
              <td className="px-2 py-2 text-right num" title={position.mark ? `Modeled from ${position.mark.source}; not a fillable Thetanuts price or settlement.` : "No live IV mark is available."}>
                {position.mark ? <><span style={{ color: position.mark.pnlUsd >= 0 ? "var(--calm)" : "var(--crit)" }}>{position.mark.pnlUsd >= 0 ? "+" : "−"}{fmtUsd(Math.abs(position.mark.pnlUsd), false, 6)}</span><span className="block text-[10px] text-faint">{position.mark.source}</span></> : <span className="text-faint">No live mark</span>}
              </td>
              <td className="px-2 py-2 text-right num text-fg">{position.contracts.toFixed(3)}</td>
              <td className="px-4 py-2 text-right">{position.txHash && process.env.NEXT_PUBLIC_BASE_SEPOLIA_EXPLORER_URL ? <a href={`${process.env.NEXT_PUBLIC_BASE_SEPOLIA_EXPLORER_URL}/tx/${position.txHash}`} target="_blank" rel="noopener noreferrer" className="text-blue hover:underline">View receipt</a> : <span className="text-muted">#{position.id}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-4 py-2 text-[10px] text-faint">Estimated PnL uses live spot and current Thetanuts IV; it is not a fillable price or settlement.</p>
    </div>
  );
}

function Empty({ action, label }: { action: () => void; label: string }) {
  return <div className="px-5 py-10 text-center text-[12px] text-faint"><p>{label}</p><button onClick={action} className="mt-3 text-blue hover:underline">Refresh</button></div>;
}
