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
import { formatUnits, hashStruct, parseUnits, zeroHash, type Address, type Hex } from "viem";
import { mandateAccountAbi } from "@/lib/generated/contracts";
import { assetFromHex, MANDATE_EIP712_TYPES, mandateDomain, mandateMessage, type Mandate } from "@/lib/mandate";
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
import { Disclosure } from "./Disclosure";
import { StepHeader } from "./StepHeader";
import { policyNetwork } from "@/lib/policyNetwork";
import type { ExecutionNetwork } from "@/lib/explorer";
import { ensureWalletChain, walletActionError } from "@/lib/walletChain";

/** Signed terms the five controls do not cover. Defaults until an AI draft
 *  proposes better ones; always rendered before signing.
 *
 *  DEMO OVERRIDE: NEXT_PUBLIC_DEMO_RISK_THRESHOLD / _PERSISTENCE_MINUTES let a
 *  local presentation sign a mandate that clears Auto-Hedge's gate against the
 *  real live book score almost immediately, instead of waiting for it to cross
 *  75/100 for a full 10 minutes. Unset in .env.local when the demo is over —
 *  every mandate signed while they're set is more aggressive than the real
 *  default a production user would see. */
const DEFAULT_TIMING: MandateDraftTiming = {
  riskScore: process.env.NEXT_PUBLIC_DEMO_RISK_THRESHOLD ?? "75",
  positionRiskScore: String(DEFAULT_POSITION_RISK_TRIGGER),
  persistenceMinutes: process.env.NEXT_PUBLIC_DEMO_PERSISTENCE_MINUTES ?? "10",
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
  asset,
  spot,
}: {
  owner: Address;
  account: Address;
  network: ExecutionNetwork;
  /** Whichever asset the dashboard is currently showing — the mandate always
   *  targets that one; there is nothing here for the user to pick. */
  asset: OptionsAsset;
  spot: number;
}) {
  const policy = policyNetwork(network);
  // The two money fields keep their raw text here so a half-typed number stays
  // on screen; `limits` is the parsed view the rest of the panel works from.
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
  const [thesisRead, setThesisRead] = useState(false);
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
  const [isRegistering, setIsRegistering] = useState(false);
  const [showSignedTerms, setShowSignedTerms] = useState(false);
  const [editingLimits, setEditingLimits] = useState(false);

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
  // The terms actually signed, for the collapsed summary. The form's own state
  // is a draft — it follows the dashboard's asset and whatever was last typed,
  // which is not necessarily what this account is running under.
  const { data: signedMandate } = useReadContract({
    address: account,
    abi: mandateAccountAbi,
    functionName: "getMandate",
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

  const signedAsset = signedMandate ? assetFromHex(signedMandate.asset) : null;
  const configured = Boolean(policy.optionBook && policy.collateral && policy.agent);
  const signedHash = useMemo(() => signed && hashStruct({ data: mandateMessage(signed.mandate), primaryType: "Mandate", types: MANDATE_EIP712_TYPES }), [signed]);
  const active = activeMandateHash && activeMandateHash !== zeroHash ? activeMandateHash : null;
  const busy = isSwitching || isSigning || isSubmitting || isConfirming || isRegistering;
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
  // Once a policy is live, the editable form is noise on every return visit —
  // show what's signed and what's switched on, and only expand the form when
  // the user actually means to change something.
  const collapsed = Boolean(active) && !editingLimits;

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
      } finally {
        // Whether it resolved or failed, the read is over — which is what lets
        // the summary say "no view recorded" instead of guessing that while
        // the request is still out. A recorded view can trigger an exit, so
        // "none" and "not known yet" are not the same answer.
        if (!cancelled) setThesisRead(true);
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
    if (!signed || isRegistering) return;
    setError(null);
    setIsRegistering(true);
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
    } finally {
      setIsRegistering(false);
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
    setMaxLossText(String(value.maxLossUsd));
    setMaxTradeText(String(value.maxTradeNotionalUsd));
    setTiming(value.timing);
    setSigned(null);
  };

  return (
    <section className="@container py-5" aria-label="Set agent limits">
      <StepHeader title={collapsed ? "Limits in force" : "Set the agent's limits"}>
        {/* Settled terms do not need the explanation of what setting them
            means; it belongs on the step you are actually working through. */}
        {collapsed ? undefined : "The agent may only take the actions you switch on, only within these limits, and only from this account. You sign them; it cannot change them, and you can revoke before any action."}
      </StepHeader>

      {!configured ? (
        <p className="mt-3 text-[12px] text-crit">The {network === "mainnet" ? "Base-mainnet" : "Base Sepolia"} policy configuration is incomplete.</p>
      ) : collapsed ? (
        <LimitsSummary signed={signedMandate ?? null} hash={active ?? null} thesis={savedThesis} thesisRead={thesisRead} actions={savedActions ?? actions} onEdit={() => setEditingLimits(true)} />
      ) : (
        <>
          {/* Three independent groups — bounds, permissions, and the view
              behind them — laid out so a visit sets one and glances at the
              others, instead of scrolling a single column past controls
              that have nothing to do with the one being changed. */}
          <div className="mt-3 grid grid-cols-1 gap-3 @lg:grid-cols-5">
            <LimitCard
              title="Limits"
              description="The most this account can put at risk, in total and per fill."
              className="@lg:col-span-2 !self-stretch"
            >
              {/* The asset is not a control here — it follows the dashboard.
                  That is fine until the account already runs a policy on a
                  different one, because registering supersedes it: the
                  switch would be silent, one click from live, and in the
                  wrong market. */}
              <div className="flex items-baseline justify-between">
                <span className="text-[12px] text-muted">Asset</span>
                <span className="text-[13px] font-semibold text-fg">{asset}</span>
              </div>
              {signedAsset && signedAsset !== asset && (
                <p className="text-[12px] leading-relaxed text-warn">
                  The policy in force covers {signedAsset}. Signing now replaces it with {asset} — switch the dashboard back to{" "}
                  {signedAsset} to keep it.
                </p>
              )}
              <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2">
                <Field label="Maximum loss" hint="total premium at risk">
                  <MoneyInput wide label="Maximum loss" value={maxLossText} onChange={(value) => { setMaxLossText(value); setSigned(null); }} />
                </Field>
                <Field label="Maximum per trade" hint="notional of one fill">
                  <MoneyInput wide label="Maximum per trade" value={maxTradeText} onChange={(value) => { setMaxTradeText(value); setSigned(null); }} />
                </Field>
              </div>
            </LimitCard>

            <LimitCard
              title="What it may do"
              description="These switches only ever narrow the signed policy. The on-chain stop is Pause or Revoke, below."
              className="@lg:col-span-3 !self-stretch"
            >
              <div className="rowlist">
                {availability.map((entry) => (
                  <ActionToggle
                    key={entry.action}
                    entry={entry}
                    onChange={(enabled) => setActions((value) => ({ ...value, [entry.action]: enabled }))}
                  />
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {actionsDirty && (
                  <button type="button" onClick={() => void saveActions()} disabled={savingActions} className="h-8 rounded-lg bg-blue px-3 text-[12px] font-semibold text-white disabled:cursor-wait disabled:opacity-60">
                    {savingActions ? "Confirm in wallet…" : "Save switches"}
                  </button>
                )}
                {savedActions && !actionsDirty && <span className="text-[12px] text-calm">Switches saved.</span>}
              </div>
            </LimitCard>
          </div>

          <LimitCard
            title="Why you're holding"
            description="Nothing on-chain records why a position was opened, and whether to close, roll or hold turns on exactly that. The agent assumes this view for anything it opens itself."
            className="mt-3"
          >
            <div className="grid grid-cols-1 gap-3 @lg:grid-cols-2 @5xl:grid-cols-4">
              <Field label="Objective" hint={OBJECTIVE_DESCRIPTION[objective]}>
                <SelectInput wide label="Objective" value={objective} onChange={(value) => setObjective(value as TradingObjective)}>
                  {TRADING_OBJECTIVES.map((value) => (
                    <option key={value} value={value}>{OBJECTIVE_LABEL[value]}</option>
                  ))}
                </SelectInput>
              </Field>
              <Field label="Direction" hint={`vs. ${fmtUsd(spot)} spot now — 10% against it marks the view broken`}>
                <SelectInput wide label="Direction" value={direction} onChange={(value) => setDirection(value as ThesisDirection)}>
                  <option value="BULLISH">Bullish</option>
                  <option value="BEARISH">Bearish</option>
                  <option value="NEUTRAL">Neutral</option>
                </SelectInput>
              </Field>
              <Field label="Price target" hint="optional — can take profit, depending on the objective">
                <MoneyInput wide label="Price target" value={targetText} onChange={setTargetText} />
              </Field>
              <Field label="Time horizon" hint="optional — blank leaves it open-ended">
                <span className="field flex w-full items-baseline gap-1 px-2.5 py-1.5">
                  <input
                    inputMode="decimal"
                    aria-label="Time horizon in days"
                    value={horizonText}
                    onChange={(event) => setHorizonText(event.target.value.replace(/[^0-9.]/g, ""))}
                    className="num min-w-0 flex-1 bg-transparent text-right text-[13px] font-semibold text-fg outline-none"
                  />
                  <span className="text-[12px] text-faint">days</span>
                </span>
              </Field>
            </div>

            {managedPositions.length > 0 && (
              <div>
                <p className="text-[13px] font-semibold text-fg">Views on single positions</p>
                <p className="mt-0.5 max-w-[64ch] text-[12px] leading-relaxed text-faint">
                  Overrides the standing view for one position. Because a broken view can trigger an exit, each is keyed to the
                  position id the agent acts on, never inferred from a recent trade.
                </p>
                <div className="rowlist mt-1">
                  {managedPositions.map((position) => {
                    const override = positionTheses[position.id] ?? null;
                    return (
                      <SettingRow key={position.id} label={position.label} hint={`Position #${position.id}`}>
                        <SelectInput
                          label={`View on position ${position.id}`}
                          value={override ? override.direction : "STANDING"}
                          onChange={(value) => {
                            setPositionTheses((current) => {
                              const next = { ...current };
                              if (value === "STANDING") delete next[position.id];
                              else next[position.id] = { ...thesis, direction: value as ThesisDirection };
                              return next;
                            });
                          }}
                        >
                          <option value="STANDING">Standing view</option>
                          <option value="BULLISH">Bullish</option>
                          <option value="BEARISH">Bearish</option>
                          <option value="NEUTRAL">Neutral</option>
                        </SelectInput>
                      </SettingRow>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {thesisDirty && (
                <button type="button" onClick={() => void saveThesis()} disabled={savingThesis} className="h-8 rounded-lg bg-blue px-3 text-[12px] font-semibold text-white disabled:cursor-wait disabled:opacity-60">
                  {savingThesis ? "Confirm in wallet…" : "Save view"}
                </button>
              )}
              {savedThesis && !thesisDirty && <span className="text-[12px] text-calm">View saved.</span>}
              <span className="text-[12px] text-faint">Signed by you and kept off-chain — a target price is a revisable opinion, not a spending limit.</span>
            </div>
          </LimitCard>

          {draft && (
            <div className="note mt-4" style={{ borderLeftColor: "var(--blue)", background: "var(--blue-soft)" }}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[13px] font-semibold text-fg">Draft from the AI · {draft.source === "gonka" ? "Gonka advisory" : "deterministic fallback"}</p>
                <button type="button" onClick={() => applyDraft(draft)} disabled={busy} className="h-8 rounded-lg bg-blue px-3 text-[12px] font-semibold text-white disabled:opacity-60">Apply to the form</button>
              </div>
              <p className="mt-2 text-[12px] leading-relaxed text-muted">{draft.quote.liquidity === "book" ? "Fresh listed Thetanuts OptionBook put" : "Thetanuts market-maker estimate, RFQ only"}: {fmtStrike(draft.quote.strike)}, {fmtExpiryDate(draft.quote.expiryTs)}, {draft.quote.contracts} contracts, {fmtUsd(draft.quote.premiumUsd, false, 6)}.</p>
              <p className="mt-1 text-[12px] leading-relaxed text-muted">{draft.rationale}</p>
              <p className="mt-2 text-[12px] leading-relaxed text-faint">Applying only fills in this form. You still review, sign and register it, and it cannot trade{draft.quote.liquidity === "mm" ? "; the agent waits for a fresh listed OptionBook order" : ""}.</p>
            </div>
          )}

          {"error" in caps ? (
            <p className="note mt-4 text-[12px] text-crit" style={{ borderLeftColor: "var(--crit)" }}>These limits cannot be signed: {caps.error}.</p>
          ) : (
            <div className="mt-4">
              <button
                type="button"
                onClick={() => setShowSignedTerms((value) => !value)}
                className="text-[12px] font-semibold text-blue hover:underline"
                aria-expanded={showSignedTerms}
              >
                {showSignedTerms ? "Hide what gets signed" : "Show what gets signed"}
              </button>
              {showSignedTerms && (
                <SignedTerms caps={caps.value} limits={limits} timing={timing} spot={spot} collateralLabel={policy.collateralLabel} account={account} agent={policy.agent!} nonce={nonce} network={network} />
              )}
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void signMandate()} disabled={busy || isReadingMandate || Boolean(activeMandateError) || "error" in caps} className="h-9 rounded-lg bg-blue px-3.5 text-[12px] font-semibold text-white hover:brightness-110 disabled:cursor-wait disabled:opacity-60">
              {isSwitching ? "Switching network…" : isSigning ? "Confirm in wallet…" : "Review and sign limits"}
            </button>
            <button type="button" onClick={() => void createDraft()} disabled={busy || drafting} className="h-9 rounded-lg px-3 text-[12px] font-semibold text-blue hover:bg-panel2 disabled:cursor-wait disabled:opacity-60">{drafting ? "Reading the book…" : "Draft with AI"}</button>
            {active && (
              <button type="button" onClick={() => setEditingLimits(false)} className="ml-auto h-9 rounded-lg px-3 text-[12px] font-semibold text-muted hover:bg-panel2">Done</button>
            )}
          </div>
        </>
      )}

      {/* One status region rather than a stack of callouts: at most one of
          these is the thing you need to act on, and the rest are progress. */}
      {signed && signedHash !== active && (
        <div className="note mt-4" style={{ borderLeftColor: "var(--calm)", background: "color-mix(in srgb, var(--calm) 7%, transparent)" }}>
          <p className="text-[12px] leading-relaxed text-fg">Signed. Registering records these exact terms on-chain{active ? ", replacing the active policy" : ""}. It does not move any funds.</p>
          <button type="button" onClick={() => void registerMandate()} disabled={busy || isReadingMandate || Boolean(activeMandateError)} className="mt-2 h-8 rounded-lg bg-calm px-3 text-[12px] font-semibold text-white disabled:cursor-wait disabled:opacity-60">{isSubmitting ? "Confirm in wallet…" : isConfirming ? "Registering…" : "Register these limits"}</button>
        </div>
      )}
      {isConfirming && transactionHash && <p className="mt-3 text-[12px] text-muted">Registering on {network === "mainnet" ? "Base" : "Base Sepolia"}. <ExplorerLink network={network} resource="tx" value={transactionHash} className="text-blue underline">View transaction</ExplorerLink></p>}
      {signed && active && signedHash === active && <p className="mt-3 text-[12px] text-calm">These limits are live on-chain. {transactionHash && <ExplorerLink network={network} resource="tx" value={transactionHash} className="underline">View registration</ExplorerLink>}</p>}
      {isReadingMandate && <p className="mt-3 text-[12px] text-muted">Checking the current on-chain policy…</p>}
      {activeMandateError && <p className="note mt-3 text-[12px] text-crit" style={{ borderLeftColor: "var(--crit)" }}>Could not verify the current on-chain policy. Signing and registration stay disabled until the Base RPC read recovers.</p>}
      {active && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-edge pt-3">
          <span className="text-[12px] text-muted">
            {control?.[0] ? "Paused — it cannot act" : "Pause is temporary; revoke is permanent"}
            {isReadingControl && <span className="ml-1 text-faint">checking state…</span>}
          </span>
          {controlError ? (
            <span className="text-[12px] text-crit">Pause and revoke are disabled until the Base RPC read recovers.</span>
          ) : (
            <span className="flex gap-2">
              <button type="button" onClick={() => void changeControl(control?.[0] ? "resumeMandate" : "pauseMandate")} disabled={busy} className="h-8 rounded-lg bg-panel3 px-3 text-[12px] font-semibold text-fg disabled:cursor-wait disabled:opacity-60">{control?.[0] ? "Resume" : "Pause"}</button>
              <button type="button" onClick={() => void changeControl("revokeMandate")} disabled={busy} className="h-8 rounded-lg border border-crit/40 px-3 text-[12px] font-semibold text-crit disabled:cursor-wait disabled:opacity-60">Revoke</button>
            </span>
          )}
        </div>
      )}
      {(transactionFailed || error) && <p className="note mt-3 text-[12px] text-crit" style={{ borderLeftColor: "var(--crit)" }}>{transactionFailed ? `The policy transaction did not succeed on-chain: ${walletActionError(transactionError, "check the linked transaction before retrying.")} The active policy is unchanged; network gas may have been charged.` : error}</p>}
    </section>
  );
}

/** What is actually running, once a policy is registered.
 *
 *  Read back from the chain rather than from the form that produced it. The
 *  form is a draft: its asset follows whichever asset the dashboard is showing
 *  and its numbers are whatever was last typed, so on a signed account it can
 *  differ from the terms in force — which, on a panel whose whole job is
 *  saying what the agent may do, would be the worst possible place to be
 *  approximately right.
 *
 *  For the same reason the per-fill bound is shown as the contract cap that
 *  was signed, not as the notional that was typed to derive it. */
function LimitsSummary({
  signed,
  hash,
  thesis,
  thesisRead,
  actions,
  onEdit,
}: {
  signed: { asset: Hex; maxPremiumTotal: bigint; maxContractsPerFill: bigint } | null;
  /** The registered policy's hash — traceability, not something to read daily. */
  hash: Hex | null;
  thesis: TradingThesis | null;
  /** False until the stored view has been fetched, so an in-flight read is
   *  never reported as "no view recorded". */
  thesisRead: boolean;
  actions: Record<AgentAction, boolean>;
  onEdit: () => void;
}) {
  const enabledActions = AGENT_ACTIONS.filter((action) => actions[action]);
  const asset = (signed && assetFromHex(signed.asset)) ?? null;
  return (
    <div className="mt-2">
      {/* One line for the settled case. These are terms you set once and then
          trust; the full breakdown is a click away rather than a permanent
          five-row block on a panel you visit to check on the agent. */}
      <p className="text-[13px] leading-relaxed text-fg">
        {signed ? (
          <>
            {asset ?? "—"} · at most <span className="num font-semibold">{fmtUsd(Number(formatUnits(signed.maxPremiumTotal, 6)), false, 2)}</span> at risk ·{" "}
            {enabledActions.length > 0 ? enabledActions.map((action) => ACTION_LABEL[action]).join(", ") : "no actions switched on"}
          </>
        ) : (
          "Reading the terms in force…"
        )}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-3">
        <button type="button" onClick={onEdit} className="text-[12px] font-semibold text-blue hover:underline">Change limits</button>
        <Disclosure label="See all terms">
          <div className="rowlist mt-2 w-full">
            <Term label="Asset" value={asset ?? "Reading…"} />
            <Term label="Maximum loss" value={signed ? fmtUsd(Number(formatUnits(signed.maxPremiumTotal, 6)), false, 2) : "Reading…"} />
            <Term label="Maximum per fill" value={signed ? `${trimUnits(formatUnits(signed.maxContractsPerFill, 6))} contracts` : "Reading…"} />
            <Term label="View" value={thesis ? `${OBJECTIVE_LABEL[thesis.objective]}, ${thesis.direction[0]}${thesis.direction.slice(1).toLowerCase()}` : thesisRead ? "None recorded" : "Reading…"} />
            <Term label="Allowed to" value={enabledActions.length > 0 ? enabledActions.map((action) => ACTION_LABEL[action]).join(", ") : "Nothing — every switch is off"} />
            {hash && <Term label="Registered policy" value={<span className="font-mono text-fg">{shortAddr(hash)}</span>} />}
          </div>
        </Disclosure>
      </div>
    </div>
  );
}

/** Read-only view of what the seven controls actually become on-chain, plus
 *  the addresses the policy binds to — reference detail, folded away by
 *  default because it is read once and then trusted. */
function SignedTerms({
  caps,
  limits,
  timing,
  spot,
  collateralLabel,
  account,
  agent,
  nonce,
  network,
}: {
  caps: DerivedCaps;
  limits: AgentLimits;
  timing: MandateDraftTiming;
  spot: number;
  collateralLabel: string;
  account: Address;
  agent: Address;
  nonce: bigint;
  network: ExecutionNetwork;
}) {
  return (
    <div className="readout mt-3 p-3">
      <div className="rowlist">
        <Term label="Maximum premium, total" value={`${toUnitString(caps.maxPremiumTotal)} ${collateralLabel}`} />
        <Term label="Maximum premium, per fill" value={`${toUnitString(caps.maxPremiumPerFill)} ${collateralLabel}`} />
        <Term label="Maximum contracts, per fill" value={toUnitString(caps.maxContractsPerFill)} />
        <Term label="Hedge trigger, book risk" value={`${timing.riskScore} / 100`} />
        <Term label="Exit trigger, position risk" value={`${timing.positionRiskScore} / 100`} />
        <Term label="Tenor window" value={`${timing.minTenorDays}–${timing.maxTenorDays} days`} />
        <Term label="Risk persistence" value={`${timing.persistenceMinutes} min`} />
        <Term label="Cooldown between fills" value={`${timing.cooldownMinutes} min`} />
        <Term label="Policy validity" value={`${timing.validityHours} h`} />
        <Term label="Policy account" value={<ExplorerLink network={network} resource="address" value={account} className="font-mono text-fg hover:text-blue">{shortAddr(account)}</ExplorerLink>} />
        <Term label="Policy agent" value={<ExplorerLink network={network} resource="address" value={agent} className="font-mono text-fg hover:text-blue">{shortAddr(agent)}</ExplorerLink>} />
        <Term label="Policy nonce" value={<span className="font-mono text-fg">{nonce.toString()}</span>} />
      </div>
      <p className="mt-3 text-[12px] leading-relaxed text-faint">
        A bought option cannot lose more than its premium, so {fmtUsd(limits.maxLossUsd)} is metered exactly on-chain — a close
        credits recovered premium back to it. The {fmtUsd(limits.maxTradeNotionalUsd)} trade limit is notional, which the mandate
        cannot express directly: it becomes a {toUnitString(caps.maxContractsPerFill)}-contract cap, holding notional at or under{" "}
        {fmtUsd(limits.maxTradeNotionalUsd)} for any strike up to {fmtUsd(caps.strikeCeiling)} (spot is {fmtUsd(spot)}). The agent
        re-checks the exact notional against the real strike before every fill.
      </p>
    </div>
  );
}

function trimUnits(value: string) {
  const [whole, fraction] = value.split(".");
  const trimmed = fraction?.replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

function Term({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="text-[12px] text-muted">{label}</span>
      <span className="num text-[12px] font-semibold text-fg">{value}</span>
    </div>
  );
}

/** One row of a settings list: what it is and what it means on the left, the
 *  control on the right. The description sits with the name rather than under
 *  the control, so the values line up into a column you can read down. */
function SettingRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3">
      <span className="min-w-0 max-w-[32ch]">
        <span className="block text-[13px] font-semibold text-fg">{label}</span>
        {hint && <span className="mt-0.5 block text-[12px] leading-snug text-faint">{hint}</span>}
      </span>
      <span className="shrink-0">{children}</span>
    </div>
  );
}

function MoneyInput({ label, value, onChange, wide }: { label: string; value: string; onChange: (value: string) => void; wide?: boolean }) {
  return (
    <span className={`field flex items-baseline gap-1 px-2.5 py-1.5 ${wide ? "w-full" : "w-[8rem]"}`}>
      <span className="text-[13px] font-semibold text-faint">$</span>
      <input
        inputMode="decimal"
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/[^0-9.]/g, ""))}
        className="num min-w-0 flex-1 bg-transparent text-right text-[13px] font-semibold text-fg outline-none"
      />
    </span>
  );
}

function SelectInput({ label, value, onChange, children, wide }: { label: string; value: string; onChange: (value: string) => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <span className={`field ${wide ? "flex w-full" : "inline-flex"} px-2 py-1.5`}>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`bg-transparent text-[13px] font-semibold text-fg outline-none ${wide ? "w-full" : ""}`}
      >
        {children}
      </select>
    </span>
  );
}

/** One of the "Set the agent's limits" step's independent groups — bounds,
 *  permissions, the view behind them. A bordered block rather than another
 *  stacked heading, so the three read as separate settings you configure on
 *  their own terms instead of one long form. */
function LimitCard({
  title,
  description,
  className = "",
  children,
}: {
  title: string;
  description?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`card flex flex-col gap-3 p-4 ${className}`}>
      <div>
        <h4 className="text-[13px] font-bold tracking-[-0.01em] text-fg">{title}</h4>
        {description && <p className="mt-1 text-[12px] leading-relaxed text-muted">{description}</p>}
      </div>
      {children}
    </div>
  );
}

/** Label above, control below — a compact form field for a grid of two or
 *  four, unlike SettingRow's full-width label-left/control-right row. */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-semibold text-fg">{label}</span>
      {children}
      {hint && <span className="text-[11px] leading-snug text-faint">{hint}</span>}
    </label>
  );
}

/** An action the agent may take. Availability and permission are separate: a
 *  switch the deployment cannot honour reads as unavailable and says why,
 *  rather than quietly doing nothing. */
function ActionToggle({
  entry,
  onChange,
}: {
  entry: { action: AgentAction; enabled: boolean; available: boolean; reason: string | null };
  onChange: (enabled: boolean) => void;
}) {
  return (
    <label className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3">
      <span className="min-w-0 max-w-[38ch]">
        <span className={`block text-[13px] font-semibold ${entry.available ? "text-fg" : "text-faint"}`}>{ACTION_LABEL[entry.action]}</span>
        <span className="mt-0.5 block text-[12px] leading-snug text-faint">{entry.reason ?? ACTION_DESCRIPTION[entry.action]}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {!entry.available && <span className="text-[12px] text-faint">Unavailable</span>}
        <input
          type="checkbox"
          className="switch"
          checked={entry.enabled && entry.available}
          disabled={!entry.available}
          onChange={(event) => onChange(event.target.checked)}
        />
      </span>
    </label>
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
