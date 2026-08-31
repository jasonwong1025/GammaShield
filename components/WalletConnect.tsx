"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useConnectors, useDisconnect, useSwitchChain } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { executionNetworkForChainId } from "@/lib/explorer";
import { ExplorerLink } from "./ExplorerLink";
import { useExecutionNetwork } from "./ExecutionNetworkProvider";
import { chainLabel, ensureWalletChain, walletActionError } from "@/lib/walletChain";

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function walletIcon(name?: string) {
  const wallet = name?.toLowerCase();
  if (wallet?.includes("phantom")) return "/wallets/phantom.svg";
  if (wallet?.includes("metamask")) return "/wallets/metamask.svg";
  return null;
}

export function WalletConnect() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [chainMessage, setChainMessage] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const { address, chainId, connector, isConnected } = useAccount();
  const { network } = useExecutionNetwork();
  const connectors = useConnectors();
  const { connectAsync, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();
  const connectedIcon = walletIcon(connector?.name);
  const targetChainId = network === "mainnet" ? base.id : baseSepolia.id;
  const targetChainLabel = chainLabel(targetChainId);
  const walletOnTargetChain = chainId === targetChainId;

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
      let chainReady = true;
      try {
        await ensureWalletChain(targetChainId, nextConnector, switchChainAsync);
        setChainMessage(null);
      } catch (error) {
        chainReady = false;
        setChainMessage(walletActionError(error, `Switch your wallet to ${targetChainLabel} before submitting transactions.`));
      }
      if (chainReady) setOpen(false);
    } catch (error) {
      setChainMessage(`Wallet connection was not completed: ${walletActionError(error, "retry from this menu.")}`);
    }
  };

  const switchWalletChain = async () => {
    try {
      await ensureWalletChain(targetChainId, connector, switchChainAsync);
      setChainMessage(null);
    } catch (error) {
      setChainMessage(walletActionError(error, `Switch your wallet to ${targetChainLabel} before submitting transactions.`));
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
          {connectedIcon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={connectedIcon} alt="" className="size-4.5 rounded" />
          ) : (
            <span className="size-2 rounded-full bg-calm" aria-hidden />
          )}
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
                {connector?.name ?? "Wallet"} · {walletOnTargetChain ? targetChainLabel : chainLabel(chainId)}
              </div>
              {!walletOnTargetChain && <div className="border-b border-edge/60 px-4 py-3"><p className="text-[11px] text-crit">Transactions require {targetChainLabel}.</p><button type="button" onClick={() => void switchWalletChain()} disabled={isSwitching} className="mt-2 h-8 rounded-lg bg-blue px-3 text-[11px] font-semibold text-white disabled:opacity-60">{isSwitching ? "Switching…" : `Switch to ${targetChainLabel}`}</button>{chainMessage && <p className="mt-2 text-[11px] text-crit">{chainMessage}</p>}</div>}
              <MenuItem onClick={copyAddress}>{copied ? "Copied ✓" : "Copy address"}</MenuItem>
              <ExplorerLink network={executionNetworkForChainId(chainId) ?? network} resource="address" value={address} className="block px-4 py-2.5 text-[13px] text-fg hover:bg-panel2 transition">
                View on explorer
              </ExplorerLink>
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
                  className="w-full px-4 py-2.5 flex items-center gap-3 text-left text-[13px] text-fg hover:bg-panel2 transition disabled:opacity-60"
                >
                  {walletIcon(nextConnector.name) && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={walletIcon(nextConnector.name)!} alt="" className="size-5 rounded" />
                  )}
                  <span className="font-medium">{nextConnector.name}</span>
                  {isPending && <span className="ml-auto text-[11px] text-faint">Connecting…</span>}
                </button>
              ))}
              {!connectors.length && <p className="px-4 py-3 text-[12px] text-muted">Install or open an injected wallet such as Phantom.</p>}
              {chainMessage && <p className="border-t border-edge/60 px-4 py-3 text-[11px] text-crit">{chainMessage}</p>}
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
