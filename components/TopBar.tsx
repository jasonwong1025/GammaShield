"use client";

export type NavTab = "dashboard" | "copilot" | "hedge";

type Props = {
  activeTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  hasHighRiskAlert?: boolean;
};

export function TopBar({ activeTab, onTabChange, hasHighRiskAlert }: Props) {
  return (
    <div className="shrink-0">
      <header className="flex items-center gap-6 px-6 h-16 border-b border-slate-100 bg-white/90 backdrop-blur-md">
        {/* Logo */}
        <div
          className="flex items-center gap-3 cursor-pointer"
          onClick={() => onTabChange("dashboard")}
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
            onClick={() => onTabChange("dashboard")}
            className={`px-3.5 py-1.5 rounded-xl transition font-medium ${
              activeTab === "dashboard"
                ? "bg-blue/10 text-blue font-semibold"
                : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
            }`}
          >
            Analytics & GEX
          </button>

          <button
            type="button"
            onClick={() => onTabChange("copilot")}
            className={`px-3.5 py-1.5 rounded-xl transition font-medium flex items-center gap-2 ${
              activeTab === "copilot"
                ? "bg-blue/10 text-blue font-semibold"
                : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
            }`}
          >
            <span>Gonka Copilot</span>
            <span className="size-1.5 rounded-full bg-blue animate-pulse" />
          </button>

          <button
            type="button"
            onClick={() => onTabChange("hedge")}
            className={`px-3.5 py-1.5 rounded-xl transition font-medium flex items-center gap-2 ${
              activeTab === "hedge"
                ? "bg-blue/10 text-blue font-semibold"
                : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
            }`}
          >
            <span>Autonomous Hedge</span>
            {hasHighRiskAlert && (
              <span className="size-2 rounded-full bg-rose-500 animate-ping" title="Danger Zone: High Fragility" />
            )}
          </button>
        </nav>

        {/* Right side status & action */}
        <div className="ml-auto flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-2 px-3 py-1 rounded-full bg-slate-50 border border-slate-200/60 text-[12px] text-slate-500 font-medium">
            <span className="size-2 rounded-full bg-emerald-500" />
            <span>Base Mainnet</span>
          </div>

          <button
            type="button"
            onClick={() => onTabChange("hedge")}
            className="h-9 px-4 rounded-xl bg-blue text-white text-[13px] font-semibold hover:brightness-110 active:scale-[0.98] transition shadow-xs"
          >
            1-Click Hedge
          </button>
        </div>
      </header>
    </div>
  );
}
