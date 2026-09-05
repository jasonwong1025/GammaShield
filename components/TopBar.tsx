"use client";

import { WalletConnect } from "./WalletConnect";
import { EXECUTION_NETWORK } from "@/lib/explorer";
import { useExecutionNetwork } from "./ExecutionNetworkProvider";

export type NavTab = "dashboard" | "agent";

type Props = {
  activeTab?: NavTab;
  onTabChange?: (tab: NavTab) => void;
  hasHighRiskAlert?: boolean;
};

export function TopBar({ activeTab = "dashboard", onTabChange, hasHighRiskAlert }: Props) {
  const { network, setNetwork } = useExecutionNetwork();
  return (
    <div className="shrink-0">
      <header className="flex items-center gap-5 px-4 h-14 border-b border-edge bg-bg">
        {/* Logo */}
        <div
          className="flex items-center gap-2.5 cursor-pointer"
          onClick={() => onTabChange?.("dashboard")}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/gammashield-lockup.png"
            alt="GammaShield"
            className="h-6 w-auto shrink-0"
          />
          <span className="chip eyebrow text-[9px] text-calm">
            <span className="live-dot size-1.5 rounded-full bg-current" />
            Live
          </span>
        </div>

        {/* Navigation tabs — a single hairline rule underneath the whole bar
            already reads as the boundary, so the active tab needs only an
            underline, not a pill. */}
        <nav className="hidden md:flex items-stretch gap-5 h-full text-[13px]" aria-label="Sections">
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
            onClick={() => onTabChange?.("agent")}
            aria-current={activeTab === "agent" ? "page" : undefined}
            className={`relative flex items-center gap-2 font-medium transition-colors ${
              activeTab === "agent" ? "text-fg" : "text-muted hover:text-fg"
            }`}
          >
            <ShieldIcon className="size-3.5 shrink-0" />
            AI Agent
            {hasHighRiskAlert && <span className="flex size-1.5 rounded-full bg-crit animate-ping" title="Danger zone: risk above 75" />}
            {activeTab === "agent" && <span className="absolute inset-x-0 -bottom-px h-[2px] bg-blue" />}
          </button>
        </nav>

        {/* Right side: network toggle + wallet */}
        <div className="ml-auto flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-1 rounded-md border border-edge p-0.5" aria-label="Execution network">
            {(Object.entries(EXECUTION_NETWORK) as [keyof typeof EXECUTION_NETWORK, (typeof EXECUTION_NETWORK)[keyof typeof EXECUTION_NETWORK]][]).map(([key, value]) => (
              <button
                key={key}
                type="button"
                onClick={() => setNetwork(key)}
                aria-pressed={network === key}
                className={`eyebrow h-6 rounded px-2 text-[10px] font-semibold transition ${
                  network === key ? "bg-panel3 text-fg" : "text-faint hover:text-muted"
                }`}
              >
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
