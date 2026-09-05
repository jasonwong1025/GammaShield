"use client";

// What the agent is allowed to spend, and how much of it is left.
//
// Every number here is read back from the chain rather than from the form that
// produced it: `controls` meters the premium actually spent and `getMandate`
// returns the terms actually signed. That matters because the form is local
// state — it happily shows whatever was last typed, including for a policy
// that was never registered, or one signed for a different asset.
//
// The loss cap is the one figure that can honestly be drawn as a meter. It is
// metered on-chain to the cent and a bought option cannot lose more than its
// premium, so the bar is a measurement rather than an estimate. The per-fill
// cap is deliberately shown as contracts, which is what the mandate signs; the
// notional the user typed is an approximation of it, and "What gets signed"
// below is where that conversion is spelled out.

import { useEffect, useState } from "react";
import { useReadContract } from "wagmi";
import { formatUnits, type Address, type Hex } from "viem";
import { mandateAccountAbi } from "@/lib/generated/contracts";
import { fmtUsd } from "@/lib/format";
import type { ExecutionNetwork } from "@/lib/explorer";

export function AgentStatusHeader({
  account,
  mandateHash,
  network,
  chainId,
}: {
  account: Address;
  mandateHash: Hex;
  network: ExecutionNetwork;
  chainId: 8453 | 84532;
}) {
  const { data: mandate } = useReadContract({ address: account, abi: mandateAccountAbi, functionName: "getMandate", args: [mandateHash], chainId });
  const { data: control } = useReadContract({ address: account, abi: mandateAccountAbi, functionName: "controls", args: [mandateHash], chainId });
  // Fixed after mount rather than read during render, so the countdown cannot
  // differ between the server and the first client paint.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, []);

  const cap = mandate ? Number(formatUnits(mandate.maxPremiumTotal, 6)) : null;
  const spent = control ? Number(formatUnits(control[2], 6)) : null;
  const remaining = cap != null && spent != null ? Math.max(0, cap - spent) : null;
  const used = cap && spent != null ? Math.min(1, spent / cap) : 0;
  const expiresAt = mandate ? Number(mandate.expiresAt) : null;
  const expired = expiresAt != null && now != null && expiresAt <= now;
  const state = control?.[1] ? "revoked" : control?.[0] ? "paused" : expired ? "expired" : "active";

  // This reads only the policy account. Monitoring is reported separately by
  // the worker panel below, so this must never imply that the agent is awake.
  return (
    <div className="border-b border-edge p-5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <StateHeading state={state} />
        <span className="text-[12px] text-faint">
          {network === "mainnet" ? "Base mainnet" : "Base Sepolia"}
          {!expired && expiresAt != null && now != null && <> · expires in {untilText(expiresAt - now)}</>}
        </span>
      </div>

      <p className="mt-2 text-[13px] text-muted">
        {cap != null && remaining != null ? (
          <>
            Risk budget: <span className="num text-[15px] font-semibold text-fg">{fmtUsd(remaining, false, 2)}</span> remaining of{" "}
            {fmtUsd(cap, false, 2)} maximum premium
            {spent != null && spent > 0 && <> · {fmtUsd(spent, false, 2)} spent</>}
          </>
        ) : (
          "Reading the signed loss cap…"
        )}
      </p>
      {/* An empty track reads as a stray rule, so the bar earns its place only
          once there is something to measure. */}
      {spent != null && spent > 0 && (
        <div className="meter mt-2" role="presentation">
          <span style={{ width: `${Math.max(2, Math.round(used * 100))}%` }} />
        </div>
      )}
      {expired && <p className="mt-2 text-[12px] text-warn">Sign new limits to let it act again.</p>}
    </div>
  );
}

function StateHeading({ state }: { state: string }) {
  if (state === "active") {
    return (
      <h3 className="flex items-center gap-2 text-[15px] font-bold tracking-[-0.01em] text-fg">
        <span className="inline-block size-2 shrink-0 rounded-full bg-calm" />
        Policy is active
      </h3>
    );
  }
  const tone = state === "revoked" ? "text-crit" : "text-warn";
  const label = state === "revoked" ? "Agent is revoked" : state === "paused" ? "Agent is paused" : "Policy has expired";
  return <h3 className={`text-[15px] font-bold tracking-[-0.01em] ${tone}`}>{label}</h3>;
}

function untilText(seconds: number) {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}
