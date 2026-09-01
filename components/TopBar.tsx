"use client";

import { WalletConnect } from "./WalletConnect";
import { EXECUTION_NETWORK } from "@/lib/explorer";
import { useExecutionNetwork } from "./ExecutionNetworkProvider";

export type NavTab = "dashboard" | "hedge";

type Props = {
  activeTab?: NavTab;
  onTabChange?: (tab: NavTab) => void;
  hasHighRiskAlert?: boolean;
};

export function TopBar({ activeTab = "dashboard", onTabChange, hasHighRiskAlert }: Props) {
  const { network, setNetwork } = useExecutionNetwork();
  return (
    <div className="shrink-0">
      <header className="flex items-center gap-6 px-5 h-16 border-b border-edge bg-bg/80 backdrop-blur">
        {/* Logo */}
        <div
          className="flex items-center gap-3 cursor-pointer"
          onClick={() => onTabChange?.("dashboard")}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/gammashield-lockup.png"
            alt="GammaShield"
            className="h-8 w-auto shrink-0"
          />
        </div>

        {/* Navigation Tabs */}
        <nav className="hidden md:flex items-center gap-1.5 ml-6 text-[13px]" aria-label="Sections">
          <button
            type="button"
            onClick={() => onTabChange?.("dashboard")}
            className={`px-3 py-1.5 rounded-lg transition font-medium ${
              activeTab === "dashboard"
                ? "bg-bluesoft text-blue font-semibold shadow-xs"
                : "text-muted hover:text-fg hover:bg-panel2"
            }`}
          >
            Dashboard
          </button>

          <button
            type="button"
            onClick={() => onTabChange?.("hedge")}
            className={`px-3 py-1.5 rounded-lg transition font-medium flex items-center gap-1.5 relative ${
              activeTab === "hedge"
                ? "bg-bluesoft text-blue font-semibold shadow-xs"
                : "text-muted hover:text-fg hover:bg-panel2"
            }`}
          >
            <span>🛡️ Autonomous Hedge</span>
            {hasHighRiskAlert ? (
              <span className="flex size-2 rounded-full bg-crit animate-ping" title="Danger Zone: Risk > 75%" />
            ) : (
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-calm/15 text-calm font-mono uppercase">
                Sepolia
              </span>
            )}
          </button>
        </nav>

        {/* Right side WalletConnect and actions */}
        <div className="ml-auto flex items-center gap-3">
          <div className="hidden sm:grid grid-cols-2 gap-1 rounded-lg bg-panel2 p-1" aria-label="Execution network">
            {(Object.entries(EXECUTION_NETWORK) as [keyof typeof EXECUTION_NETWORK, (typeof EXECUTION_NETWORK)[keyof typeof EXECUTION_NETWORK]][]).map(([key, value]) => (
              <button key={key} type="button" onClick={() => setNetwork(key)} aria-pressed={network === key} className={`h-7 rounded-md px-2 text-[11px] font-semibold ${network === key ? "bg-panel text-fg shadow-sm" : "text-muted hover:text-fg"}`}>
                {value.shortLabel}
              </button>
            ))}
          </div>
          <WalletConnect />
        </div>
      </header>
    </div>
  );
}
