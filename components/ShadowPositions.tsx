"use client";

import { useEffect, useState } from "react";
import type { Asset } from "@/lib/assets";
import type { ShadowPosition } from "@/lib/shadow";
import { fmtExpiryDate, fmtStrike, fmtUsd } from "@/lib/format";
import { getActiveProvider } from "./WalletConnect";

export function ShadowPositions({ asset }: { asset: Asset }) {
  const [address, setAddress] = useState<string | null>(null);
  const [positions, setPositions] = useState<ShadowPosition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (buyer: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/shadow/positions?buyer=${buyer}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `positions ${res.status}`);
      setPositions(data.positions);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load shadow positions");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const provider = getActiveProvider();
    if (!provider) return;
    provider.request({ method: "eth_accounts" }).then((accounts) => {
      const buyer = (accounts as string[])[0];
      if (buyer) {
        setAddress(buyer);
        void load(buyer);
      }
    }).catch(() => {});
  }, []);

  const connect = async () => {
    const provider = getActiveProvider();
    if (!provider) return setError("Connect a wallet to view shadow positions");
    const buyer = ((await provider.request({ method: "eth_requestAccounts" })) as string[])[0];
    if (!buyer) return;
    setAddress(buyer);
    await load(buyer);
  };

  const filtered = positions.filter((position) => position.asset === asset);
  if (!address) {
    return <Empty action={connect} label="Connect wallet to view Base Sepolia shadow positions." />;
  }
  if (loading) return <p className="px-5 py-10 text-center text-[12px] text-faint">Reading shadow positions…</p>;
  if (error) return <Empty action={() => void load(address)} label={error} />;
  if (!filtered.length) return <Empty action={() => void load(address)} label={`No ${asset} shadow positions for this wallet.`} />;

  return (
    <div className="feed-scroll overflow-auto grow min-h-0 max-h-[430px]">
      <table className="w-full min-w-[560px] text-[12px]">
        <thead className="sticky top-0 bg-panel z-10 text-[10px] text-faint">
          <tr>
            <th className="text-left font-medium px-4 py-1.5">Type</th>
            <th className="text-right font-medium px-2 py-1.5">Strike</th>
            <th className="text-right font-medium px-2 py-1.5">Expiry</th>
            <th className="text-right font-medium px-2 py-1.5">Premium</th>
            <th className="text-right font-medium px-2 py-1.5">Contracts</th>
            <th className="text-right font-medium px-4 py-1.5">Receipt</th>
          </tr>
        </thead>
        <tbody className="font-mono text-[11px]">
          {filtered.map((position) => (
            <tr key={position.id} className="border-t border-edge/50">
              <td className="px-4 py-2 font-sans"><span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${position.isCall ? "text-calm bg-calm/10" : "text-crit bg-crit/10"}`}>{position.isCall ? "CALL" : "PUT"}</span></td>
              <td className="px-2 py-2 text-right num text-fg">{fmtStrike(position.strike)}</td>
              <td className="px-2 py-2 text-right text-muted">{fmtExpiryDate(position.expiryTs)}</td>
              <td className="px-2 py-2 text-right num text-fg">{fmtUsd(position.premiumUsd, false)} USDC</td>
              <td className="px-2 py-2 text-right num text-fg">{position.contracts.toFixed(3)}</td>
              <td className="px-4 py-2 text-right text-muted">#{position.id}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Empty({ action, label }: { action: () => void; label: string }) {
  return <div className="px-5 py-10 text-center text-[12px] text-faint"><p>{label}</p><button onClick={action} className="mt-3 text-blue hover:underline">Refresh</button></div>;
}
