"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useBytecode, useReadContract } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import { isAddress, zeroHash, type Address } from "viem";
import type { Asset } from "@/lib/assets";
import type { ShadowPosition } from "@/lib/shadow";
import { mandateAccountFactoryAbi } from "@/lib/generated/contracts";
import { fmtContracts, fmtCountdown, fmtExpiryDate, fmtStrike, fmtUsd } from "@/lib/format";

const factoryFromEnv = process.env.NEXT_PUBLIC_BASE_SEPOLIA_MANDATE_FACTORY_ADDRESS;
const FACTORY_ADDRESS: Address | undefined = factoryFromEnv && isAddress(factoryFromEnv) ? factoryFromEnv : undefined;
type DisplayPosition = ShadowPosition & { custody: "wallet" | "policy" };

export function ShadowPositions({ asset }: { asset: Asset }) {
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

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => clearInterval(id);
  }, []);

  const load = useCallback(async (wallet: string, policy?: string) => {
    setRefreshing(true);
    setError(null);
    try {
      const buyers: { address: string; custody: DisplayPosition["custody"] }[] = [{ address: wallet, custody: "wallet" }];
      if (policy && policy.toLowerCase() !== wallet.toLowerCase()) buyers.push({ address: policy, custody: "policy" });
      const results = await Promise.all(buyers.map(async (buyer) => {
        const res = await fetch(`/api/shadow/positions?${new URLSearchParams({ buyer: buyer.address })}`, { cache: "no-store" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `positions ${res.status}`);
        return (data.positions as ShadowPosition[]).map((position) => ({ ...position, custody: buyer.custody }));
      }));
      setPositions(results.flat());
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

  const filtered = positions.filter((position) => position.asset === asset);
  if (!address) {
    return <Empty label="Connect wallet from the top bar to view Base Sepolia shadow positions." />;
  }
  if (!loaded) return <p className="px-5 py-10 text-center text-[12px] text-faint">Reading shadow positions…</p>;
  if (error) return <Empty action={() => void load(address, deployedPolicy ? policyAccount : undefined)} label={error} />;
  if (!filtered.length) return <Empty action={() => void load(address, deployedPolicy ? policyAccount : undefined)} label={`No ${asset} shadow positions for ${deployedPolicy ? "this wallet or policy account" : "this wallet"}.`} />;

  return (
    <div className="feed-scroll overflow-auto grow min-h-0 max-h-[430px]">
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
          {filtered.map((position) => (
            <tr key={position.id} className="border-t border-edge/50">
              <td className="px-4 py-2 font-sans"><span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${position.isCall ? "text-calm bg-calm/10" : "text-crit bg-crit/10"}`}>{position.isCall ? "CALL" : "PUT"}</span>{position.custody === "policy" && <span className="ml-1 text-[9px] font-semibold text-blue">AGENT</span>}</td>
              <td className="px-2 py-2 text-right num text-fg">{fmtStrike(position.strike)}</td>
              <td className="px-2 py-2 text-right text-muted whitespace-nowrap">{fmtExpiryDate(position.expiryTs)} <span className="text-faint">· {fmtCountdown(position.expiryTs, now)}</span></td>
              <td className="px-2 py-2 text-right num text-fg">{fmtUsd(position.premiumUsd, false, 6)} USDC</td>
              <td className="px-2 py-2 text-right num" title={position.mark ? `Modeled from ${position.mark.source}; not a fillable Thetanuts price or settlement.` : "No live IV mark is available."}>
                {position.mark ? <><span style={{ color: position.mark.pnlUsd >= 0 ? "var(--calm)" : "var(--crit)" }}>{position.mark.pnlUsd >= 0 ? "+" : "−"}{fmtUsd(Math.abs(position.mark.pnlUsd), false, 6)}</span><span className="block text-[10px] text-faint">{position.mark.source}</span></> : <span className="text-faint">No live mark</span>}
              </td>
              <td className="px-2 py-2 text-right num text-fg">{fmtContracts(position.contracts)}</td>
              <td className="px-4 py-2 text-right">{position.txHash && process.env.NEXT_PUBLIC_BASE_SEPOLIA_EXPLORER_URL ? <a href={`${process.env.NEXT_PUBLIC_BASE_SEPOLIA_EXPLORER_URL}/tx/${position.txHash}`} target="_blank" rel="noopener noreferrer" className="text-blue hover:underline">View receipt</a> : <span className="text-muted">#{position.id}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-4 py-2 text-[10px] text-faint">Estimated PnL uses live spot and current Thetanuts IV; it is not a fillable price or settlement.</p>
    </div>
  );
}

function Empty({ action, label }: { action?: () => void; label: string }) {
  return <div className="px-5 py-10 text-center text-[12px] text-faint"><p>{label}</p>{action && <button onClick={action} className="mt-3 text-blue hover:underline">Refresh</button>}</div>;
}
