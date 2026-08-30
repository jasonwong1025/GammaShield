"use client";

import type { AssetSnapshot } from "@/lib/engine";
import type { FeedRow } from "@/lib/snapshot";
import type { Asset } from "@/lib/assets";
import { ExecutionTerminal } from "./ExecutionTerminal";
import type { HedgeIntent } from "./TradePanel";
import { ScorePanel } from "./ScorePanel";
import { BookCard } from "./BookFeed";

type Props = {
  snap: AssetSnapshot;
  feed: FeedRow[];
  asset: Asset;
  live: boolean;
  spot: number;
  onOpenDashboard: (intent: HedgeIntent) => void;
};

export function HedgeView({ snap, feed, asset, live, spot, onOpenDashboard }: Props) {
  return (
    <div className="grid grow grid-cols-1 xl:grid-cols-[1fr_380px] gap-px bg-edge">
      {/* Main Column: Execution Terminal */}
      <div className="flex flex-col gap-px min-w-0">
        <ExecutionTerminal snap={snap} onOpenDashboard={onOpenDashboard} />
        <div className="grow bg-panel" />
      </div>

      {/* Side Rail: Risk Score & Live Options Book */}
      <div className="flex flex-col gap-px min-w-0">
        <ScorePanel snap={snap} />
        <BookCard rows={feed} snap={snap} asset={asset} live={live} spot={spot} />
        <div className="grow bg-panel" />
      </div>
    </div>
  );
}
