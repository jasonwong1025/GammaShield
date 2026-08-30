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
    <div className="grid grow grid-cols-1 xl:grid-cols-[1fr_380px] gap-px bg-edge">
      {/* Main Column: Unified Copilot Chat (What-If Trade Simulator + Rumor Fact-Checker) */}
      <div className="flex flex-col gap-px min-w-0">
        <UnifiedCopilotChat snap={snap} onNavigateToHedge={onNavigateToHedge} />
        <div className="grow bg-panel" />
      </div>

      {/* Right Column: Clean Action-Oriented Risk Sidebar */}
      <div className="flex flex-col gap-px min-w-0">
        <ScorePanel snap={snap} />
        <div className="grow bg-panel" />
      </div>
    </div>
  );
}
