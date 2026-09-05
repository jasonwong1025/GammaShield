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
    <div className="agent-workspace grid grid-cols-1 items-start gap-px bg-edge xl:grid-cols-[5fr_7fr]">
      <div className="min-w-0 self-start">
        <PolicyAccountPanel asset={asset} spot={spot} />
      </div>
      <div className="min-w-0 self-start">
        <BookCard rows={feed} snap={snap} asset={asset} live={live} spot={spot} tabs={["positions"]} />
      </div>
    </div>
  );
}
