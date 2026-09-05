"use client";

import { WalletConnect } from "./WalletConnect";
import { EXECUTION_NETWORK } from "@/lib/explorer";
import { useExecutionNetwork } from "./ExecutionNetworkProvider";
import { useTheme } from "./ThemeProvider";

export type NavTab = "dashboard" | "agent";

type Props = {
  activeTab?: NavTab;
  onTabChange?: (tab: NavTab) => void;
  hasHighRiskAlert?: boolean;
};

export function TopBar({ activeTab = "dashboard", onTabChange, hasHighRiskAlert }: Props) {
  const { network, setNetwork } = useExecutionNetwork();
  const { theme, setTheme } = useTheme();

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

        {/* Right side: network toggle + theme toggle + wallet */}
        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          {/* Base / Sepolia execution network switcher */}
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

          {/* Theme mode toggle */}
          <div className="flex items-center gap-0.5 rounded-md border border-edge p-0.5" aria-label="Theme mode">
            <button
              type="button"
              onClick={() => setTheme("dark")}
              aria-pressed={theme === "dark"}
              aria-label="Dark mode"
              title="Dark mode"
              className={`flex h-6 w-6 items-center justify-center rounded transition ${
                theme === "dark" ? "bg-panel3 text-fg" : "text-faint hover:text-muted"
              }`}
            >
              <MoonIcon className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setTheme("light")}
              aria-pressed={theme === "light"}
              aria-label="Light mode"
              title="Light mode"
              className={`flex h-6 w-6 items-center justify-center rounded transition ${
                theme === "light" ? "bg-panel3 text-fg" : "text-faint hover:text-muted"
              }`}
            >
              <SunIcon className="size-3.5" />
            </button>
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

function SunIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
      <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 1.5v1.5M8 13v1.5M1.5 8h1.5M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden>
      <path
        d="M13.5 9.8A5.5 5.5 0 016.2 2.5 6 6 0 1013.5 9.8z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
