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
    <div className="agent-workspace grid grow grid-cols-1 items-stretch gap-px bg-edge xl:grid-cols-[5fr_7fr]">
      {/* Each column grows to fill the tab's full height, same as the
          Dashboard tab's TradingArea — otherwise a short account (no
          positions, policy not yet set up) leaves the raw page background
          exposed below it instead of the panel it belongs to. The settings
          side has no natural "grow" content, so it gets a trailing filler;
          the positions card grows itself via BookCard's own `fill` prop
          (see its doc comment — it exists for exactly this tab) so a long
          list scrolls to fit the space instead of capping at 430px and
          leaving the rest blank. */}
      <div className="flex min-w-0 flex-col">
        <PolicyAccountPanel asset={asset} spot={spot} />
        <div className="grow bg-panel" />
      </div>
      <div className="flex min-w-0 flex-col">
        <BookCard rows={feed} snap={snap} asset={asset} live={live} spot={spot} tabs={["positions"]} fill />
      </div>
    </div>
  );
}
