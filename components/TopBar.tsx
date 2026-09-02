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

        {/* Navigation Tabs — an underline indicator flush with the header's
            own bottom rule, not a soft pill; matches the flat, hairline
            language used for panels elsewhere. */}
        <nav className="hidden md:flex items-stretch gap-6 ml-6 h-full text-[13px]" aria-label="Sections">
          <button
            type="button"
            onClick={() => onTabChange?.("dashboard")}
            aria-current={activeTab === "dashboard" ? "page" : undefined}
            className={`relative flex items-center font-medium transition-colors ${
              activeTab === "dashboard" ? "text-fg" : "text-muted hover:text-fg"
            }`}
          >
            Dashboard
            {activeTab === "dashboard" && <span className="absolute inset-x-0 -bottom-px h-[2px] bg-blue" />}
          </button>

          <button
            type="button"
            onClick={() => onTabChange?.("hedge")}
            aria-current={activeTab === "hedge" ? "page" : undefined}
            className={`relative flex items-center gap-2 font-medium transition-colors ${
              activeTab === "hedge" ? "text-fg" : "text-muted hover:text-fg"
            }`}
          >
            <ShieldIcon className="size-3.5 shrink-0" />
            Autonomous Hedge
            <span className="eyebrow text-[9px] px-1.5 py-0.5 rounded bg-calm/10 text-calm">{EXECUTION_NETWORK[network].shortLabel}</span>
            {hasHighRiskAlert && <span className="flex size-2 rounded-full bg-crit animate-ping" title="Danger Zone: Risk > 75%" />}
            {activeTab === "hedge" && <span className="absolute inset-x-0 -bottom-px h-[2px] bg-blue" />}
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

function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
      <path
        d="M8 1.5l5 1.8v3.9c0 3.4-2.1 5.9-5 7.3-2.9-1.4-5-3.9-5-7.3V3.3l5-1.8z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
