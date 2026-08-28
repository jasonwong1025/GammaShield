"use client";

// Connect-wallet button for the top bar. Talks to the wallets' injected
// EIP-1193 providers directly (no wallet library): MetaMask via
// window.ethereum, Phantom via its EVM provider at window.phantom.ethereum.
// On connect we nudge the wallet onto Base (8453), where the Thetanuts book
// lives — but a refusal is non-fatal since the dashboard itself is read-only.

import { useCallback, useEffect, useRef, useState } from "react";

type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: never[]) => void) => void;
  removeListener?: (event: string, handler: (...args: never[]) => void) => void;
  isMetaMask?: boolean;
  isPhantom?: boolean;
  providers?: Eip1193Provider[];
};

type WalletKey = "metamask" | "phantom";

const WALLETS: { key: WalletKey; name: string; icon: string; installUrl: string }[] = [
  { key: "metamask", name: "MetaMask", icon: "/wallets/metamask.svg", installUrl: "https://metamask.io/download/" },
  { key: "phantom", name: "Phantom", icon: "/wallets/phantom.svg", installUrl: "https://phantom.com/download" },
];

const BASE_RPC_URL = process.env.NEXT_PUBLIC_BASE_RPC_URL ?? "https://mainnet.base.org";
const EXPLORER_URL = process.env.NEXT_PUBLIC_BASE_EXPLORER_URL ?? "https://basescan.org";

const BASE_CHAIN = {
  chainId: "0x2105", // 8453
  chainName: "Base",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: [BASE_RPC_URL],
  blockExplorerUrls: [EXPLORER_URL],
};

const LAST_WALLET_KEY = "gs-wallet";

function getProvider(key: WalletKey): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    ethereum?: Eip1193Provider;
    phantom?: { ethereum?: Eip1193Provider };
  };
  if (key === "phantom") return w.phantom?.ethereum ?? null;
  // Phantom (and others) can shadow window.ethereum and spoof isMetaMask,
  // so prefer the multi-provider list and exclude Phantom explicitly.
  const eth = w.ethereum;
  if (!eth) return null;
  if (eth.providers?.length) {
    return eth.providers.find((p) => p.isMetaMask && !p.isPhantom) ?? null;
  }
  return eth.isMetaMask && !eth.isPhantom ? eth : null;
}

function shortAddress(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

async function switchToBase(provider: Eip1193Provider) {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: BASE_CHAIN.chainId }],
    });
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code === 4902) {
      try {
        await provider.request({ method: "wallet_addEthereumChain", params: [BASE_CHAIN] });
      } catch {
        /* declining the chain is fine — dashboard is read-only */
      }
    }
  }
}

export function WalletConnect() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<WalletKey | null>(null);
  const [connected, setConnected] = useState<{ wallet: WalletKey; address: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close the menu on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const bindAccountEvents = useCallback((provider: Eip1193Provider, wallet: WalletKey) => {
    provider.on?.("accountsChanged", ((accounts: string[]) => {
      if (accounts.length) setConnected({ wallet, address: accounts[0] });
      else {
        setConnected(null);
        try {
          localStorage.removeItem(LAST_WALLET_KEY);
        } catch {}
      }
    }) as never);
  }, []);

  // Silent reconnect to the wallet used last time (no prompt).
  useEffect(() => {
    let stale = false;
    let saved: WalletKey | null = null;
    try {
      saved = localStorage.getItem(LAST_WALLET_KEY) as WalletKey | null;
    } catch {}
    if (saved !== "metamask" && saved !== "phantom") return;
    const provider = getProvider(saved);
    if (!provider) return;
    const wallet = saved;
    provider
      .request({ method: "eth_accounts" })
      .then((accounts) => {
        const list = accounts as string[];
        if (!stale && list.length) {
          setConnected({ wallet, address: list[0] });
          bindAccountEvents(provider, wallet);
        }
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [bindAccountEvents]);

  const connect = async (key: WalletKey) => {
    const wallet = WALLETS.find((w) => w.key === key)!;
    const provider = getProvider(key);
    if (!provider) {
      window.open(wallet.installUrl, "_blank", "noopener");
      return;
    }
    setBusy(key);
    try {
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      if (accounts.length) {
        await switchToBase(provider);
        setConnected({ wallet: key, address: accounts[0] });
        bindAccountEvents(provider, key);
        try {
          localStorage.setItem(LAST_WALLET_KEY, key);
        } catch {}
        setOpen(false);
      }
    } catch {
      /* user rejected the prompt */
    } finally {
      setBusy(null);
    }
  };

  const disconnect = () => {
    setConnected(null);
    setOpen(false);
    try {
      localStorage.removeItem(LAST_WALLET_KEY);
    } catch {}
  };

  const copyAddress = async () => {
    if (!connected) return;
    try {
      await navigator.clipboard.writeText(connected.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };

  const walletMeta = connected ? WALLETS.find((w) => w.key === connected.wallet)! : null;

  return (
    <div ref={rootRef} className="relative">
      {connected && walletMeta ? (
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="h-9 pl-2.5 pr-3 rounded-lg bg-panel2 border border-edge text-[13px] font-medium text-fg hover:bg-panel3 transition flex items-center gap-2"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={walletMeta.icon} alt={walletMeta.name} className="size-4.5 rounded" />
          <span className="num">{shortAddress(connected.address)}</span>
        </button>
      ) : (
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="h-9 px-4 rounded-lg bg-blue text-white text-[13px] font-medium hover:brightness-110 transition"
        >
          Connect wallet
        </button>
      )}

      {open && (
        <div className="absolute right-0 top-full mt-2 w-56 rounded-xl border border-edge bg-panel shadow-lg overflow-hidden z-50">
          {connected && walletMeta ? (
            <div className="py-1.5">
              <div className="px-4 py-2 text-[11px] text-muted border-b border-edge/60">
                {walletMeta.name} · Base
              </div>
              <MenuItem onClick={copyAddress}>{copied ? "Copied ✓" : "Copy address"}</MenuItem>
              <MenuItem
                onClick={() =>
                  window.open(`${EXPLORER_URL}/address/${connected.address}`, "_blank", "noopener")
                }
              >
                View on BaseScan
              </MenuItem>
              <MenuItem onClick={disconnect} danger>
                Disconnect
              </MenuItem>
            </div>
          ) : (
            <div className="py-1.5">
              <div className="px-4 py-2 text-[11px] text-muted border-b border-edge/60">
                Connect a wallet
              </div>
              {WALLETS.map((w) => {
                const detected = !!getProvider(w.key);
                return (
                  <button
                    key={w.key}
                    onClick={() => connect(w.key)}
                    disabled={busy !== null}
                    className="w-full px-4 py-2.5 flex items-center gap-3 text-[13px] text-fg hover:bg-panel2 transition disabled:opacity-60"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={w.icon} alt="" className="size-5 rounded" />
                    <span className="font-medium">{w.name}</span>
                    <span className="ml-auto text-[11px] text-faint">
                      {busy === w.key ? "Connecting…" : detected ? "" : "Install"}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full px-4 py-2.5 text-left text-[13px] hover:bg-panel2 transition ${
        danger ? "text-crit" : "text-fg"
      }`}
    >
      {children}
    </button>
  );
}
