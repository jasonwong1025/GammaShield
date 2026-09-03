"use client";

import type { AssetSnapshot } from "@/lib/engine";
import type { FeedRow } from "@/lib/snapshot";
import type { Asset } from "@/lib/assets";
import { PolicyAccountPanel } from "./PolicyAccountPanel";
import { BookCard } from "./BookFeed";

type Props = {
  snap: AssetSnapshot;
  feed: FeedRow[];
  asset: Asset;
  live: boolean;
  spot: number;
};

export function AgentView({ snap, feed, asset, live, spot }: Props) {
  return (
    <div className="grid grow grid-cols-1 xl:grid-cols-[1fr_380px] gap-px bg-edge">
      {/* Main Column: Policy account setup */}
      <div className="flex flex-col gap-px min-w-0">
        <PolicyAccountPanel spot={spot} />
        <div className="grow bg-panel" />
      </div>

      {/* Side Rail: Live Options Book */}
      <div className="flex flex-col gap-px min-w-0">
        <BookCard rows={feed} snap={snap} asset={asset} live={live} spot={spot} />
        <div className="grow bg-panel" />
      </div>
    </div>
  );
}
