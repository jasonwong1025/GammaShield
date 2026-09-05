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
    <div className="grid grow grid-cols-1 xl:grid-cols-[5fr_7fr] gap-px bg-edge">
      {/* Settings rail: what the agent is doing now, then the setup it came
          from — both are about the agent itself rather than the market it
          trades, and the console orders them by how often they're read. */}
      <div className="flex flex-col gap-px min-w-0">
        <PolicyAccountPanel asset={asset} spot={spot} />
        <div className="grow bg-panel" />
      </div>

      {/* Main column: the live book and the account's own positions. */}
      <div className="flex flex-col gap-px min-w-0">
        <BookCard rows={feed} snap={snap} asset={asset} live={live} spot={spot} fill tabs={["positions"]} />
      </div>
    </div>
  );
}
