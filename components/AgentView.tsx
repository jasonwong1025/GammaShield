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
    <div className="agent-workspace flex min-w-0 flex-col gap-px bg-edge">
      <PolicyAccountPanel asset={asset} spot={spot} />
      <BookCard rows={feed} snap={snap} asset={asset} live={live} spot={spot} tabs={["positions"]} />
    </div>
  );
}
