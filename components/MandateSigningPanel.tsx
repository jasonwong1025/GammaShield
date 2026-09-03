"use client";

// The AI agent's limits, and the policy the wallet signs to enforce them.
//
// The user sets seven things: which asset, how much they can lose in total, the
// largest single trade, which of the three predefined actions the agent may
// take, and — because the agent now manages positions rather than just opening
// cover — the objective and the standing view behind them. Everything else the
// mandate needs (tenor window, both risk triggers, persistence, cooldown,
// validity) is derived, and shown read-only next to the signature so nothing is
// signed unseen.
//
// The objective and the standing thesis are the newest controls and the only
// ones that are not limits. They exist because nothing on-chain records WHY a
// position was opened, and the decision to close, roll or hold turns on that.
// A position opened at the trade desk can override the standing view; anything
// without a view of its own inherits this one.
//
// Two limits behave differently and the panel has to say which is which:
//
//   Maximum loss     is exact and on-chain. A bought option cannot lose more
//                    than its premium, so the signed total-premium cap IS the
//                    loss cap; the contract meters it and closes credit it back.
//   Max trade size   is notional, which the mandate cannot express directly —
//                    it caps contracts, not contracts x strike. It is converted
//                    at a strike ceiling for the on-chain bound, and re-checked
//                    exactly against the real strike before any fill.
//
// The three action switches are off-chain. They can only narrow what the signed
// policy already permits, and the on-chain off switch stays pause/revoke.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, useReadContract, useSignMessage, useSignTypedData, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { hashStruct, parseUnits, zeroHash, type Address, type Hex } from "viem";
import { mandateAccountAbi } from "@/lib/generated/contracts";
import { MANDATE_EIP712_TYPES, mandateDomain, mandateMessage, type Mandate } from "@/lib/mandate";
import {
  ACTION_DESCRIPTION,
  ACTION_LABEL,
  AGENT_ACTIONS,
  DEFAULT_AGENT_LIMITS,
  DEFAULT_POSITION_RISK_TRIGGER,
  agentActionAvailability,
  deriveMandateCaps,
  toUnitString,
  type AgentAction,
  type AgentLimits,
  type DerivedCaps,
} from "@/lib/autonomous/policy";
import { fmtExpiryDate, fmtStrike, fmtUsd, shortAddr } from "@/lib/format";
import type { AiMandateDraft, MandateDraftTiming } from "@/lib/mandateDraft";
import {
  OBJECTIVE_DESCRIPTION,
  OBJECTIVE_LABEL,
  TRADING_OBJECTIVES,
  type ThesisDirection,
  type TradingObjective,
  type TradingThesis,
} from "@/lib/autonomous/types";
import { thesisMessage } from "@/lib/autonomous/thesisRules";
import type { OptionsAsset } from "@/lib/assets";
import { ExplorerLink } from "./ExplorerLink";
import { policyNetwork } from "@/lib/policyNetwork";
import type { ExecutionNetwork } from "@/lib/explorer";
import { ensureWalletChain, walletActionError } from "@/lib/walletChain";

/** Signed terms the five controls do not cover. Defaults until an AI draft
 *  proposes better ones; always rendered before signing. */
const DEFAULT_TIMING: MandateDraftTiming = {
  riskScore: "75",
  positionRiskScore: String(DEFAULT_POSITION_RISK_TRIGGER),
  persistenceMinutes: "10",
  cooldownMinutes: "60",
  validityHours: "24",
  minTenorDays: "1",
  maxTenorDays: "14",
};

const SHADOW_BOOK_VERSION_ABI = [
  { type: "function", name: "version", stateMutability: "pure", inputs: [], outputs: [{ type: "uint16" }] },
] as const;

export function MandateSigningPanel({
  owner,
  account,
  network,
  spot,
}: {
  owner: Address;
  account: Address;
  network: ExecutionNetwork;
  spot: number;
}) {
  const policy = policyNetwork(network);
  // The two money fields keep their raw text here so a half-typed number stays
  // on screen; `limits` is the parsed view the rest of the panel works from.
  const [asset, setAsset] = useState<OptionsAsset>(DEFAULT_AGENT_LIMITS.asset);
  const [actions, setActions] = useState<Record<AgentAction, boolean>>(DEFAULT_AGENT_LIMITS.actions);
  const [maxLossText, setMaxLossText] = useState(String(DEFAULT_AGENT_LIMITS.maxLossUsd));
  const [maxTradeText, setMaxTradeText] = useState(String(DEFAULT_AGENT_LIMITS.maxTradeNotionalUsd));
  const limits = useMemo<AgentLimits>(
    () => ({ asset, actions, maxLossUsd: Number(maxLossText), maxTradeNotionalUsd: Number(maxTradeText) }),
    [asset, actions, maxLossText, maxTradeText],
  );
  const [timing, setTiming] = useState<MandateDraftTiming>(DEFAULT_TIMING);
  const [objective, setObjective] = useState<TradingObjective>("HEDGE_EXISTING_POSITION");
  const [direction, setDirection] = useState<ThesisDirection>("NEUTRAL");
  const [targetText, setTargetText] = useState("");
  const [horizonText, setHorizonText] = useState("");
  const [savedThesis, setSavedThesis] = useState<TradingThesis | null>(null);
  const [positionTheses, setPositionTheses] = useState<Record<string, TradingThesis>>({});
  const [savedPositionTheses, setSavedPositionTheses] = useState<Record<string, TradingThesis>>({});
  const [savingThesis, setSavingThesis] = useState(false);
  const [savedActions, setSavedActions] = useState<Record<AgentAction, boolean> | null>(null);
  const [nonce] = useState(() => BigInt(Date.now()));
  /** Fixed at mount so the horizon memo stays pure. A view's horizon is set in
   *  days, so a reference a few minutes old changes nothing meaningful. */
  const [openedAt] = useState(() => Math.floor(Date.now() / 1000));
  const [signed, setSigned] = useState<{ mandate: Mandate; signature: Hex } | null>(null);
  const [draft, setDraft] = useState<AiMandateDraft | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [savingActions, setSavingActions] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { connector } = useAccount();
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();
  const { signTypedDataAsync, isPending: isSigning } = useSignTypedData();
  const { signMessageAsync } = useSignMessage();
  const { writeContractAsync, data: transactionHash, isPending: isSubmitting } = useWriteContract();
  const { isError: transactionFailed, error: transactionError, isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ chainId: policy.chainId, hash: transactionHash });

  const { data: activeMandateHash, error: activeMandateError, isPending: isReadingMandate, refetch: refetchActiveMandate } = useReadContract({
    address: account,
    abi: mandateAccountAbi,
    functionName: "activeMandateHash",
    chainId: policy.chainId,
  });
  const { data: control, error: controlError, isPending: isReadingControl, refetch: refetchControl } = useReadContract({
    address: account,
    abi: mandateAccountAbi,
    functionName: "controls",
    args: activeMandateHash && activeMandateHash !== zeroHash ? [activeMandateHash] : undefined,
    chainId: policy.chainId,
    query: { enabled: Boolean(activeMandateHash && activeMandateHash !== zeroHash) },
  });
  // Which shadow book is actually deployed decides whether closing and rolling
  // can run at all. An unreadable version means the old, fill-only deployment.
  const { data: shadowVersion } = useReadContract({
    address: policy.optionBook,
    abi: SHADOW_BOOK_VERSION_ABI,
    functionName: "version",
    chainId: policy.chainId,
    query: { enabled: network === "sepolia" && Boolean(policy.optionBook), retry: false },
  });

  const configured = Boolean(policy.optionBook && policy.collateral && policy.agent);
  const signedHash = useMemo(() => signed && hashStruct({ data: mandateMessage(signed.mandate), primaryType: "Mandate", types: MANDATE_EIP712_TYPES }), [signed]);
  const active = activeMandateHash && activeMandateHash !== zeroHash ? activeMandateHash : null;
  const busy = isSwitching || isSigning || isSubmitting || isConfirming;
  const availability = useMemo(
    () => agentActionAvailability(limits, network, network === "sepolia" ? (shadowVersion == null ? null : Number(shadowVersion)) : null),
    [limits, network, shadowVersion],
  );
  const caps = useMemo<{ value: DerivedCaps } | { error: string }>(() => {
    try {
      return { value: deriveMandateCaps(limits, spot) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "these limits cannot be expressed" };
    }
  }, [limits, spot]);
  const actionsDirty = savedActions != null && AGENT_ACTIONS.some((action) => savedActions[action] !== actions[action]);

  // The standing view, as it would be stored. `referenceSpot` is captured now,
  // because "spot moved against the view" is meaningless without the price the
  // view was taken at.
  const thesis = useMemo<TradingThesis>(() => {
    const days = Number(horizonText);
    return {
      direction,
      objective,
      targetPrice: Number(targetText) > 0 ? Number(targetText) : null,
      horizonEndsAt: Number.isFinite(days) && days > 0 ? openedAt + days * 86_400 : null,
      referenceSpot: spot > 0 ? spot : null,
      note: null,
    };
  }, [direction, objective, targetText, horizonText, spot, openedAt]);
  const thesisDirty =
    savedThesis == null ||
    savedThesis.direction !== thesis.direction ||
    savedThesis.objective !== thesis.objective ||
    savedThesis.targetPrice !== thesis.targetPrice ||
    JSON.stringify(Object.keys(positionTheses).sort().map((id) => [id, positionTheses[id]!.direction])) !==
      JSON.stringify(Object.keys(savedPositionTheses).sort().map((id) => [id, savedPositionTheses[id]!.direction]));

  // Load whatever switches this account last saved, so the panel shows the
  // agent's real configuration rather than a fresh set of defaults.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/agent-actions?network=${network}&account=${account}`, { cache: "no-store" });
        if (!response.ok) return;
        const state = (await response.json()) as { actions: Record<AgentAction, boolean> };
        if (cancelled || !state?.actions) return;
        setSavedActions(state.actions);
        setActions(state.actions);
      } catch {
        // The switches simply show as unsaved; nothing here is load-bearing.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account, network]);

  // The policy account's own open positions. Not the user's wallet positions:
  // the agent manages only what this account holds, so those are the only ones
  // a per-position view can govern.
  const [managedPositions, setManagedPositions] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const url =
          network === "sepolia"
            ? `/api/shadow/positions?buyer=${account}`
            : `/api/positions?address=${account}`;
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as {
          positions?: { id: string | number; strike: number; expiryTs: number; contracts: number; isCall: boolean; closedAt?: number | null }[];
        };
        if (cancelled || !data.positions) return;
        setManagedPositions(
          data.positions
            .filter((position) => !position.closedAt)
            .map((position) => ({
              id: String(position.id),
              label: `${position.isCall ? "CALL" : "PUT"} ${fmtStrike(position.strike)} · ${fmtExpiryDate(position.expiryTs)} · ${position.contracts} contracts`,
            })),
        );
      } catch {
        // No list simply means no per-position overrides can be edited here.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account, network]);

  // The stored view, loaded separately from the switches because they are
  // separate stores with separate signatures.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/agent-thesis?network=${network}&account=${account}`, { cache: "no-store" });
        if (!response.ok) return;
        const state = (await response.json()) as { thesis?: TradingThesis | null; positionTheses?: Record<string, TradingThesis> };
        if (cancelled) return;
        setPositionTheses(state.positionTheses ?? {});
        setSavedPositionTheses(state.positionTheses ?? {});
        if (!state.thesis) return;
        setSavedThesis(state.thesis);
        setObjective(state.thesis.objective);
        setDirection(state.thesis.direction);
        setTargetText(state.thesis.targetPrice ? String(state.thesis.targetPrice) : "");
        setHorizonText(
          state.thesis.horizonEndsAt
            ? String(Math.max(1, Math.round((state.thesis.horizonEndsAt - openedAt) / 86_400)))
            : "",
        );
      } catch {
        // The view simply shows as unsaved; nothing here is load-bearing.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account, network, openedAt]);

  useEffect(() => {
    if (!isSuccess) return;
    void refetchActiveMandate();
    void refetchControl();
  }, [isSuccess, refetchActiveMandate, refetchControl]);

  const saveActions = useCallback(async () => {
    setError(null);
    setSavingActions(true);
    try {
      const updatedAt = Math.floor(Date.now() / 1000);
      const message = [
        "GammaShield agent actions",
        `account: ${account.toLowerCase()}`,
        `network: ${network}`,
        `actions: ${AGENT_ACTIONS.map((action) => `${action}=${actions[action] ? "on" : "off"}`).join(",")}`,
        `updatedAt: ${updatedAt}`,
      ].join("\n");
      const signature = await signMessageAsync({ message });
      const response = await fetch("/api/agent-actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ network, account, actions, updatedAt, signature }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `switch update ${response.status}`);
      setSavedActions(data.actions as Record<AgentAction, boolean>);
    } catch (error) {
      setError(`The action switches were not saved: ${walletActionError(error, "the agent still uses the stored settings.")}`);
    } finally {
      setSavingActions(false);
    }
  }, [account, actions, network, signMessageAsync]);

  const saveThesis = useCallback(async () => {
    setError(null);
    setSavingThesis(true);
    try {
      const updatedAt = Math.floor(Date.now() / 1000);
      const record = { standing: thesis, positions: positionTheses, updatedAt };
      const signature = await signMessageAsync({ message: thesisMessage(account, network, record) });
      const response = await fetch("/api/agent-thesis", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ network, account, ...record, signature }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `thesis update ${response.status}`);
      setSavedThesis(data.thesis as TradingThesis);
      setSavedPositionTheses((data.positionTheses ?? {}) as Record<string, TradingThesis>);
    } catch (error) {
      setError(`The objective and view were not saved: ${walletActionError(error, "the agent still uses the stored view.")}`);
    } finally {
      setSavingThesis(false);
    }
  }, [account, network, positionTheses, signMessageAsync, thesis]);

  const signMandate = async () => {
    if (!policy.optionBook || !policy.collateral || !policy.agent || !("value" in caps)) return;
    setError(null);
    setSigned(null);
    try {
      await ensureWalletChain(policy.chainId, connector, switchChainAsync);
      const mandate = buildMandate(owner, account, limits, timing, caps.value, nonce, policy.optionBook, policy.collateral, policy.agent);
      const signature = await signTypedDataAsync({
        domain: mandateDomain(policy.chainId, account),
        types: MANDATE_EIP712_TYPES,
        primaryType: "Mandate",
        message: mandateMessage(mandate),
      });
      setSigned({ mandate, signature });
    } catch (error) {
      setError(`Mandate signing was not completed: ${walletActionError(error, "no policy was activated.")}`);
    }
  };

  const registerMandate = async () => {
    if (!signed) return;
    setError(null);
    try {
      await ensureWalletChain(policy.chainId, connector, switchChainAsync);
      await writeContractAsync({
        address: account,
        abi: mandateAccountAbi,
        functionName: "registerMandate",
        args: [mandateMessage(signed.mandate), signed.signature],
        chainId: policy.chainId,
      });
    } catch (error) {
      setError(`Mandate registration was not completed: ${walletActionError(error, "no policy changed.")}`);
    }
  };

  const changeControl = async (functionName: "pauseMandate" | "resumeMandate" | "revokeMandate") => {
    if (!active) return;
    setError(null);
    try {
      await ensureWalletChain(policy.chainId, connector, switchChainAsync);
      await writeContractAsync({ address: account, abi: mandateAccountAbi, functionName, args: [active], chainId: policy.chainId });
    } catch (error) {
      setError(`Mandate control was not completed: ${walletActionError(error, "the on-chain policy is unchanged.")}`);
    }
  };

  const createDraft = async () => {
    setError(null);
    setDrafting(true);
    try {
      const response = await fetch("/api/mandate-draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ asset }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `AI draft ${response.status}`);
      setDraft(data.draft as AiMandateDraft);
    } catch (error) {
      setError(error instanceof Error ? error.message : "AI draft was unavailable.");
    } finally {
      setDrafting(false);
    }
  };

  const applyDraft = (value: AiMandateDraft) => {
    setAsset(value.asset);
    setMaxLossText(String(value.maxLossUsd));
    setMaxTradeText(String(value.maxTradeNotionalUsd));
    setTiming(value.timing);
    setSigned(null);
  };

  return (
    <section className="mt-4 border-t border-edge pt-4" aria-label="Set agent limits">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-blue">Step 2 · EIP-712</p>
          <h3 className="mt-1 text-[14px] font-bold text-fg">Set the agent&apos;s limits</h3>
          <p className="mt-1 text-[12px] text-muted">The AI agent may only take the actions you switch on, only within these limits, and only from this account. Your wallet signs them; the agent cannot change them.</p>
        </div>
        <span className="rounded-full bg-panel2 px-2.5 py-1 text-[10px] font-semibold text-muted">Revocable before every action</span>
      </div>

      {!configured ? (
        <p className="mt-3 rounded-lg border border-crit/30 bg-crit/10 p-3 text-[12px] text-crit">The {network === "mainnet" ? "Base-mainnet" : "Base Sepolia"} policy configuration is incomplete.</p>
      ) : (
        <>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Select label="Asset" value={asset} onChange={(value) => { setAsset(value as OptionsAsset); setSigned(null); }} options={["BTC", "ETH"]} />
            <MoneyField
              label="Maximum loss"
              hint="total premium the agent may put at risk"
              value={maxLossText}
              onChange={(value) => { setMaxLossText(value); setSigned(null); }}
            />
            <MoneyField
              label="Do not execute trades above"
              hint="notional per trade, not premium"
              value={maxTradeText}
              onChange={(value) => { setMaxTradeText(value); setSigned(null); }}
            />
          </div>

          <div className="mt-3 rounded-lg border border-edge bg-panel2 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-faint">Objective and standing view</p>
            <p className="mt-1 text-[11px] leading-relaxed text-faint">
              Nothing on-chain records why a position was opened, and whether to close, roll or hold turns on exactly that. This
              is the view the agent assumes for anything it opens itself; a position opened at the trade desk can carry its own.
            </p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <label className="rounded-lg border border-edge bg-panel p-2.5 text-[11px] text-faint">
                <span className="block">Objective</span>
                <select
                  value={objective}
                  onChange={(event) => setObjective(event.target.value as TradingObjective)}
                  className="mt-1 h-8 w-full rounded-md border border-edge bg-panel2 px-2 text-[12px] font-semibold text-fg"
                >
                  {TRADING_OBJECTIVES.map((value) => (
                    <option key={value} value={value}>{OBJECTIVE_LABEL[value]}</option>
                  ))}
                </select>
                <span className="mt-1 block leading-relaxed">{OBJECTIVE_DESCRIPTION[objective]}</span>
              </label>
              <label className="rounded-lg border border-edge bg-panel p-2.5 text-[11px] text-faint">
                <span className="block">Direction</span>
                <select
                  value={direction}
                  onChange={(event) => setDirection(event.target.value as ThesisDirection)}
                  className="mt-1 h-8 w-full rounded-md border border-edge bg-panel2 px-2 text-[12px] font-semibold text-fg"
                >
                  <option value="BULLISH">Bullish</option>
                  <option value="BEARISH">Bearish</option>
                  <option value="NEUTRAL">Neutral</option>
                </select>
                <span className="mt-1 block leading-relaxed">
                  Measured against {fmtUsd(spot)} spot now. A 10% move against the view marks it broken.
                </span>
              </label>
              <MoneyField
                label="Price target (optional)"
                hint="reaching it can take profit, depending on the objective"
                value={targetText}
                onChange={setTargetText}
              />
              <MoneyField
                label="Time horizon in days (optional)"
                hint="the view expires with it; blank leaves it open-ended"
                value={horizonText}
                onChange={setHorizonText}
              />
            </div>
            {managedPositions.length > 0 && (
              <div className="mt-2 rounded-lg border border-edge bg-panel p-2.5">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-faint">Per-position overrides</p>
                <p className="mt-1 text-[11px] leading-relaxed text-faint">
                  A position with its own view ignores the standing one. Because a broken view can trigger an exit, these are keyed
                  to the position id the agent actually acts on — never inferred from a recent trade.
                </p>
                <ul className="mt-2 grid gap-1.5">
                  {managedPositions.map((position) => {
                    const override = positionTheses[position.id] ?? null;
                    return (
                      <li key={position.id} className="flex flex-wrap items-center gap-2 text-[11px]">
                        <span className="font-mono text-fg">#{position.id}</span>
                        <span className="text-faint">{position.label}</span>
                        <select
                          value={override ? override.direction : "STANDING"}
                          onChange={(event) => {
                            const value = event.target.value;
                            setPositionTheses((current) => {
                              const next = { ...current };
                              if (value === "STANDING") delete next[position.id];
                              else next[position.id] = { ...thesis, direction: value as ThesisDirection };
                              return next;
                            });
                          }}
                          className="h-7 rounded-md border border-edge bg-panel2 px-2 text-[11px] font-semibold text-fg"
                        >
                          <option value="STANDING">Use standing view</option>
                          <option value="BULLISH">Bullish</option>
                          <option value="BEARISH">Bearish</option>
                          <option value="NEUTRAL">Neutral</option>
                        </select>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-faint">
              <span>Stored off-chain and owner-signed, like the switches — a target price is a revisable opinion, not a spending limit.</span>
              {thesisDirty && (
                <button type="button" onClick={() => void saveThesis()} disabled={savingThesis} className="h-7 rounded-lg bg-blue px-2.5 text-[11px] font-semibold text-white disabled:cursor-wait disabled:opacity-60">
                  {savingThesis ? "Confirm in wallet…" : "Save view"}
                </button>
              )}
              {savedThesis && !thesisDirty && <span className="text-calm">View saved.</span>}
            </div>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            {availability.map((entry) => (
              <ActionToggle
                key={entry.action}
                entry={entry}
                onChange={(enabled) => setActions((value) => ({ ...value, [entry.action]: enabled }))}
              />
            ))}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-faint">
            <span>
              These switches are stored off-chain and only ever narrow the signed policy. The on-chain stop is Pause or Revoke.
            </span>
            {actionsDirty && (
              <button type="button" onClick={() => void saveActions()} disabled={savingActions} className="h-7 rounded-lg bg-blue px-2.5 text-[11px] font-semibold text-white disabled:cursor-wait disabled:opacity-60">
                {savingActions ? "Confirm in wallet…" : "Save switches"}
              </button>
            )}
            {savedActions && !actionsDirty && <span className="text-calm">Switches saved.</span>}
          </div>

          {"error" in caps ? (
            <p className="mt-3 rounded-lg border border-crit/30 bg-crit/10 p-3 text-[12px] text-crit">These limits cannot be signed: {caps.error}.</p>
          ) : (
            <SignedTerms caps={caps.value} limits={limits} timing={timing} spot={spot} collateralLabel={policy.collateralLabel} />
          )}

          {draft && (
            <div className="mt-3 rounded-lg border border-blue/30 bg-blue/5 p-3 text-[12px] text-muted">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold text-fg">
                  AI policy draft <span className="ml-1 rounded bg-panel px-1.5 py-0.5 text-[10px] text-blue">{draft.source === "gonka" ? "Gonka advisory" : "Deterministic fallback"}</span>
                </p>
                <button type="button" onClick={() => applyDraft(draft)} disabled={busy} className="h-8 rounded-lg bg-blue px-3 text-[11px] font-semibold text-white disabled:opacity-60">Apply draft</button>
              </div>
              <p className="mt-2">{draft.quote.liquidity === "book" ? "Fresh listed Thetanuts OptionBook PUT" : "Thetanuts MM estimate · RFQ-only"}: {fmtStrike(draft.quote.strike)} · {fmtExpiryDate(draft.quote.expiryTs)} · {draft.quote.contracts} contracts · {fmtUsd(draft.quote.premiumUsd, false, 6)}.</p>
              <p className="mt-1">{draft.rationale}</p>
              <p className="mt-2 text-[10px] text-faint">Applying only edits this form. You still review, sign, and register the policy; it cannot execute a trade{draft.quote.liquidity === "mm" ? "; the agent waits for a fresh listed OptionBook order" : ""}.</p>
            </div>
          )}

          <div className="mt-3 grid gap-2 rounded-lg border border-edge bg-panel2 p-3 text-[11px] sm:grid-cols-[110px_1fr]">
            <span className="text-faint">Policy account</span><ExplorerLink network={network} resource="address" value={account} className="font-mono text-fg hover:text-blue">{shortAddr(account)}</ExplorerLink>
            <span className="text-faint">Policy agent</span><ExplorerLink network={network} resource="address" value={policy.agent!} className="font-mono text-fg hover:text-blue">{shortAddr(policy.agent!)}</ExplorerLink>
            <span className="text-faint">Policy nonce</span><span className="font-mono text-fg">{nonce.toString()}</span>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void createDraft()} disabled={busy || drafting} className="h-9 rounded-lg bg-panel3 px-3 text-[12px] font-semibold text-blue hover:bg-panel2 disabled:cursor-wait disabled:opacity-60">{drafting ? "Reading fresh OptionBook…" : "Generate AI draft"}</button>
            <button type="button" onClick={() => void signMandate()} disabled={busy || isReadingMandate || Boolean(activeMandateError) || "error" in caps} className="h-9 rounded-lg bg-blue px-3 text-[12px] font-semibold text-white hover:brightness-110 disabled:cursor-wait disabled:opacity-60">
              {isSwitching ? "Switching network…" : isSigning ? "Confirm in wallet…" : "Review and sign limits"}
            </button>
            <span className="text-[11px] text-faint">The agent cannot change these terms.</span>
          </div>
        </>
      )}

      {signed && signedHash !== active && <div className="mt-3 rounded-lg border border-calm/30 bg-calm/10 p-3 text-[12px] text-calm"><p>Signature ready. Registering records this exact policy on-chain{active ? " and supersedes the active policy" : ""}; it does not fund the account.</p><button type="button" onClick={() => void registerMandate()} disabled={busy || isReadingMandate || Boolean(activeMandateError)} className="mt-2 h-8 rounded-lg bg-calm px-3 text-[11px] font-semibold text-white disabled:cursor-wait disabled:opacity-60">{isSubmitting ? "Confirm in wallet…" : isConfirming ? "Registering policy…" : "Register signed limits"}</button></div>}
      {isConfirming && transactionHash && <p className="mt-3 rounded-lg border border-edge bg-panel2 p-3 text-[12px] text-muted">Policy transaction submitted; awaiting Base confirmation. <ExplorerLink network={network} resource="tx" value={transactionHash} className="underline">View transaction</ExplorerLink></p>}
      {signed && active && signedHash === active && <p className="mt-3 rounded-lg border border-calm/30 bg-calm/10 p-3 text-[12px] text-calm">These limits are active on-chain. Funding status appears in Step 3. {transactionHash && <ExplorerLink network={network} resource="tx" value={transactionHash} className="underline">View registration</ExplorerLink>}</p>}
      {isReadingMandate && <p className="mt-3 text-[12px] text-muted">Checking the current on-chain policy…</p>}
      {activeMandateError && <p className="mt-3 rounded-lg border border-crit/30 bg-crit/10 p-3 text-[12px] text-crit">Could not verify the current on-chain policy. Signing and registration are disabled until the Base RPC read recovers.</p>}
      {active && <div className="mt-3 rounded-lg border border-edge bg-panel2 p-3 text-[12px] text-muted"><p>Active policy <span className="font-mono text-fg">{shortAddr(active)}</span>{control?.[0] ? " · paused" : " · executable only within its limits"}</p>{isReadingControl ? <p className="mt-2">Checking pause/revocation state…</p> : controlError ? <p className="mt-2 text-crit">Could not verify pause/revocation state. Controls are disabled until the Base RPC read recovers.</p> : <div className="mt-2 flex flex-wrap gap-2"><button type="button" onClick={() => void changeControl(control?.[0] ? "resumeMandate" : "pauseMandate")} disabled={busy} className="h-8 rounded-lg bg-panel3 px-3 text-[11px] font-semibold text-fg disabled:cursor-wait disabled:opacity-60">{control?.[0] ? "Resume" : "Pause"}</button><button type="button" onClick={() => void changeControl("revokeMandate")} disabled={busy} className="h-8 rounded-lg border border-crit/40 px-3 text-[11px] font-semibold text-crit disabled:cursor-wait disabled:opacity-60">Revoke</button></div>}</div>}
      {(transactionFailed || error) && <p className="mt-3 rounded-lg border border-crit/30 bg-crit/10 p-3 text-[12px] text-crit">{transactionFailed ? `Policy transaction did not succeed on-chain: ${walletActionError(transactionError, "check the linked transaction before retrying.")} The active policy is unchanged; network gas may have been charged.` : error}</p>}
    </section>
  );
}

/** Read-only view of what the five controls actually become on-chain. */
function SignedTerms({
  caps,
  limits,
  timing,
  spot,
  collateralLabel,
}: {
  caps: DerivedCaps;
  limits: AgentLimits;
  timing: MandateDraftTiming;
  spot: number;
  collateralLabel: string;
}) {
  return (
    <div className="mt-3 rounded-lg border border-edge bg-panel2 p-3 text-[11px]">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-faint">What gets signed</p>
      <div className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
        <Term label="Max premium, total" value={`${toUnitString(caps.maxPremiumTotal)} ${collateralLabel}`} />
        <Term label="Max premium, per fill" value={`${toUnitString(caps.maxPremiumPerFill)} ${collateralLabel}`} />
        <Term label="Max contracts, per fill" value={toUnitString(caps.maxContractsPerFill)} />
        <Term label="Hedge trigger, book risk" value={`${timing.riskScore} / 100`} />
        <Term label="Exit trigger, position risk" value={`${timing.positionRiskScore} / 100`} />
        <Term label="Tenor window" value={`${timing.minTenorDays}–${timing.maxTenorDays} days`} />
        <Term label="Risk persistence" value={`${timing.persistenceMinutes} min`} />
        <Term label="Cooldown between fills" value={`${timing.cooldownMinutes} min`} />
        <Term label="Policy validity" value={`${timing.validityHours} h`} />
      </div>
      <p className="mt-2 leading-relaxed text-faint">
        A bought option cannot lose more than its premium, so {fmtUsd(limits.maxLossUsd)} is metered exactly on-chain — closes credit
        recovered premium back to it. The {fmtUsd(limits.maxTradeNotionalUsd)} trade limit is notional, which the mandate cannot
        express directly: it becomes a {toUnitString(caps.maxContractsPerFill)}-contract cap, which holds notional at or under{" "}
        {fmtUsd(limits.maxTradeNotionalUsd)} for any strike up to {fmtUsd(caps.strikeCeiling)} (spot is {fmtUsd(spot)}). The agent
        re-checks the exact notional against the real strike before every fill.
      </p>
    </div>
  );
}

function Term({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-faint">{label}</span>
      <span className="num font-semibold text-fg">{value}</span>
    </div>
  );
}

function ActionToggle({
  entry,
  onChange,
}: {
  entry: { action: AgentAction; enabled: boolean; available: boolean; reason: string | null };
  onChange: (enabled: boolean) => void;
}) {
  const on = entry.enabled && entry.available;
  return (
    <div className={`rounded-lg border p-2.5 ${entry.available ? "border-edge bg-panel2" : "border-edge bg-panel2/50"}`}>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={entry.enabled}
          disabled={!entry.available}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-0.5 size-3.5 shrink-0 accent-[color:var(--blue)] disabled:opacity-40"
        />
        <span className="min-w-0">
          <span className={`block text-[12px] font-semibold ${entry.available ? "text-fg" : "text-faint"}`}>
            {ACTION_LABEL[entry.action]}
            <span className={`ml-1.5 text-[10px] font-medium ${on ? "text-calm" : "text-faint"}`}>{entry.available ? (entry.enabled ? "Enabled" : "Disabled") : "Unavailable"}</span>
          </span>
          <span className="mt-0.5 block text-[10px] leading-snug text-faint">{entry.reason ?? ACTION_DESCRIPTION[entry.action]}</span>
        </span>
      </label>
    </div>
  );
}

function buildMandate(
  owner: Address,
  account: Address,
  limits: AgentLimits,
  timing: MandateDraftTiming,
  caps: DerivedCaps,
  nonce: bigint,
  optionBook: Address,
  collateral: Address,
  agent: Address,
): Mandate {
  const minTenorDays = whole(timing.minTenorDays, "minimum tenor", 1, 28);
  const maxTenorDays = whole(timing.maxTenorDays, "maximum tenor", minTenorDays, 56);
  const validityHours = whole(timing.validityHours, "policy validity", 1, 168);
  const persistenceMinutes = whole(timing.persistenceMinutes, "risk persistence", 0, validityHours * 60);
  const now = Math.floor(Date.now() / 1000);
  return {
    owner,
    account,
    agent,
    optionBook,
    collateral,
    asset: limits.asset,
    // Every predefined action is built around a protective put; the agent has
    // no mandate to sell volatility on the user's behalf.
    side: "put",
    maxPremiumPerFill: units(toUnitString(caps.maxPremiumPerFill), "premium per fill"),
    maxPremiumTotal: units(toUnitString(caps.maxPremiumTotal), "maximum loss"),
    maxContractsPerFill: units(toUnitString(caps.maxContractsPerFill), "contracts per fill"),
    minTenorSeconds: minTenorDays * 86400,
    maxTenorSeconds: maxTenorDays * 86400,
    riskThresholdBps: whole(timing.riskScore, "risk trigger", 0, 100) * 100,
    // Arms close and roll. Its own trigger because a held position is scored
    // on four components rather than six — this venue publishes no implied
    // vol for a position — so 70 there is not 70 on the book scale.
    positionRiskThresholdBps: whole(timing.positionRiskScore, "position risk trigger", 1, 100) * 100,
    persistenceSeconds: persistenceMinutes * 60,
    minExecutionIntervalSeconds: whole(timing.cooldownMinutes, "fill cooldown", 0, validityHours * 60) * 60,
    validAfter: now,
    expiresAt: now + validityHours * 3600,
    nonce,
  };
}

function units(value: string, label: string): bigint {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value) || parseUnits(value, 6) <= 0n) throw new Error(`invalid ${label}`);
  return parseUnits(value, 6);
}

function whole(value: string, label: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`invalid ${label}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`invalid ${label}`);
  return number;
}

function MoneyField({ label, hint, value, onChange }: { label: string; hint: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="rounded-lg border border-edge bg-panel2 p-2.5 text-[11px] text-faint">
      <span className="block">{label}</span>
      <span className="mt-1 flex items-center gap-1">
        <span className="text-[13px] font-semibold text-fg">$</span>
        <input
          inputMode="decimal"
          value={value}
          onChange={(event) => onChange(event.target.value.replace(/[^0-9.]/g, ""))}
          className="min-w-0 flex-1 bg-transparent text-[13px] font-semibold text-fg outline-none"
        />
      </span>
      <span className="mt-1 block text-[10px] leading-snug">{hint}</span>
    </label>
  );
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return <label className="rounded-lg border border-edge bg-panel2 p-2.5 text-[11px] text-faint"><span className="block">{label}</span><select value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 w-full bg-transparent text-[13px] font-semibold text-fg outline-none">{options.map((option) => <option key={option} value={option}>{option.toUpperCase()}</option>)}</select></label>;
}
