"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useConnectors, useDisconnect, useSwitchChain } from "wagmi";
import { base } from "wagmi/chains";

const EXPLORER_URL = process.env.NEXT_PUBLIC_BASE_EXPLORER_URL ?? "https://basescan.org";

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function WalletConnect() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { address, connector, isConnected } = useAccount();
  const connectors = useConnectors();
  const { connectAsync, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const connect = async (nextConnector: (typeof connectors)[number]) => {
    try {
      await connectAsync({ connector: nextConnector });
      try {
        await switchChainAsync({ chainId: base.id });
      } catch {
        // A wallet can remain connected while the read-only dashboard is open.
      }
      setOpen(false);
    } catch {
      // Wallet rejection is intentionally silent.
    }
  };

  const copyAddress = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };

  return (
    <div ref={rootRef} className="relative">
      {isConnected && address ? (
        <button
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="h-9 px-3 rounded-lg bg-panel2 border border-edge text-[13px] font-medium text-fg hover:bg-panel3 transition flex items-center gap-2"
        >
          <span className="size-2 rounded-full bg-calm" aria-hidden />
          <span className="num">{shortAddress(address)}</span>
        </button>
      ) : (
        <button
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="h-9 px-4 rounded-lg bg-blue text-white text-[13px] font-medium hover:brightness-110 transition"
        >
          Connect wallet
        </button>
      )}

      {open && (
        <div className="absolute right-0 top-full mt-2 w-56 rounded-xl border border-edge bg-panel shadow-lg overflow-hidden z-50">
          {isConnected && address ? (
            <div className="py-1.5">
              <div className="px-4 py-2 text-[11px] text-muted border-b border-edge/60">
                {connector?.name ?? "Wallet"} · Base
              </div>
              <MenuItem onClick={copyAddress}>{copied ? "Copied ✓" : "Copy address"}</MenuItem>
              <MenuItem onClick={() => window.open(`${EXPLORER_URL}/address/${address}`, "_blank", "noopener")}>
                View on BaseScan
              </MenuItem>
              <MenuItem onClick={() => { disconnect(); setOpen(false); }} danger>
                Disconnect
              </MenuItem>
            </div>
          ) : (
            <div className="py-1.5">
              <div className="px-4 py-2 text-[11px] text-muted border-b border-edge/60">Connect a wallet</div>
              {connectors.map((nextConnector) => (
                <button
                  key={nextConnector.uid}
                  onClick={() => void connect(nextConnector)}
                  disabled={isPending}
                  className="w-full px-4 py-2.5 flex items-center text-left text-[13px] text-fg hover:bg-panel2 transition disabled:opacity-60"
                >
                  <span className="font-medium">{nextConnector.name}</span>
                  {isPending && <span className="ml-auto text-[11px] text-faint">Connecting…</span>}
                </button>
              ))}
              {!connectors.length && <p className="px-4 py-3 text-[12px] text-muted">Install or open an injected wallet such as Phantom.</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return <button onClick={onClick} className={`w-full px-4 py-2.5 text-left text-[13px] hover:bg-panel2 transition ${danger ? "text-crit" : "text-fg"}`}>{children}</button>;
}
