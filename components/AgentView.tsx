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
      {/* Settings rail: configure the account and its limits. Kept narrow and
          collapsible — this is the form the agent reads once, not the thing
          worth watching. */}
      <div className="flex flex-col gap-px min-w-0">
        <PolicyAccountPanel spot={spot} onAgentActive={setActiveAgent} />
        <div className="grow bg-panel" />
      </div>

      {/* Main column: what the agent is actually doing, then the book it is
          watching. This is the surface worth returning to. */}
      <div className="flex flex-col gap-px min-w-0">
        {activeAgent && (
          <section className="card p-5" aria-label="Agent activity">
            <AgentMonitoringPanel account={activeAgent.account} mandateHash={activeAgent.mandateHash} network={activeAgent.network} />
          </section>
        )}
        <BookCard rows={feed} snap={snap} asset={asset} live={live} spot={spot} fill tabs={["positions"]} />
      </div>
    </div>
  );
}
