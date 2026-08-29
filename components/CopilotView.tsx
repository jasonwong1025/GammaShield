"use client";

import type { AssetSnapshot } from "@/lib/engine";
import { UnifiedCopilotChat } from "./UnifiedCopilotChat";
import { ScorePanel } from "./ScorePanel";

type Props = {
  snap: AssetSnapshot;
  onNavigateToHedge: (strike?: number) => void;
};

export function CopilotView({ snap, onNavigateToHedge }: Props) {
  return (
    <div className="p-6 grid grid-cols-1 xl:grid-cols-[1fr_400px] gap-6 bg-slate-50/60 grow">
      {/* Main Column: Unified Copilot Chat (What-If Trade Simulator + Rumor Fact-Checker) */}
      <div className="min-w-0 flex flex-col">
        <UnifiedCopilotChat snap={snap} onNavigateToHedge={onNavigateToHedge} />
      </div>

      {/* Right Column: Clean Action-Oriented Risk Sidebar */}
      <div className="min-w-0 flex flex-col gap-6">
        <ScorePanel snap={snap} />
      </div>
    </div>
  );
}
