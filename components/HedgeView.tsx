"use client";

import type { AssetSnapshot } from "@/lib/engine";
import type { FeedRow } from "@/lib/snapshot";
import type { Asset } from "@/lib/assets";
import { ExecutionTerminal } from "./ExecutionTerminal";
import { ScorePanel } from "./ScorePanel";
import { BookCard } from "./BookFeed";

type Props = {
  snap: AssetSnapshot;
  feed: FeedRow[];
  asset: Asset;
};

export function HedgeView({ snap, feed, asset }: Props) {
  return (
    <div className="p-6 grid grid-cols-1 xl:grid-cols-[1fr_400px] gap-6 bg-slate-50/60 grow">
      {/* Main Column: Execution Terminal */}
      <div className="min-w-0 flex flex-col">
        <ExecutionTerminal snap={snap} />
      </div>

      {/* Side Rail: Risk Score & Live Options Book */}
      <div className="min-w-0 flex flex-col gap-6">
        <ScorePanel snap={snap} />
        <BookCard rows={feed} snap={snap} asset={asset} />
      </div>
    </div>
  );
}
