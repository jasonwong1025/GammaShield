"use client";

import { useState } from "react";
import type { Address, Hex } from "viem";
import type { AssetSnapshot } from "@/lib/engine";
import type { FeedRow } from "@/lib/snapshot";
import type { Asset } from "@/lib/assets";
import type { ExecutionNetwork } from "@/lib/explorer";
import { PolicyAccountPanel } from "./PolicyAccountPanel";
import { AgentMonitoringPanel } from "./AgentMonitoringPanel";
import { BookCard } from "./BookFeed";

type Props = {
  snap: AssetSnapshot;
  feed: FeedRow[];
  asset: Asset;
  live: boolean;
  spot: number;
};

type ActiveAgent = { account: Address; mandateHash: Hex; network: ExecutionNetwork };

export function AgentView({ snap, feed, asset, live, spot }: Props) {
  const [activeAgent, setActiveAgent] = useState<ActiveAgent | null>(null);

  return (
    <div className="grid grow grid-cols-1 xl:grid-cols-[5fr_7fr] gap-px bg-edge">
      {/* Settings rail: configure the account and its limits, then watch what
          it's doing right below that — same column, since both are about
          the agent's own setup rather than the market it trades. */}
      <div className="flex flex-col gap-px min-w-0">
        <PolicyAccountPanel spot={spot} onAgentActive={setActiveAgent} />
        {activeAgent && (
          <section className="card p-5" aria-label="Agent activity">
            <AgentMonitoringPanel account={activeAgent.account} mandateHash={activeAgent.mandateHash} network={activeAgent.network} />
          </section>
        )}
        <div className="grow bg-panel" />
      </div>

      {/* Main column: the live book and the account's own positions. */}
      <div className="flex flex-col gap-px min-w-0">
        <BookCard rows={feed} snap={snap} asset={asset} live={live} spot={spot} fill tabs={["positions"]} />
      </div>
    </div>
  );
}
