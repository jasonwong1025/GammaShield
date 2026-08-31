"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, useReadContract, useSignTypedData, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { hashStruct, parseUnits, zeroHash, type Address, type Hex } from "viem";
import { mandateAccountAbi } from "@/lib/generated/contracts";
import { MANDATE_EIP712_TYPES, mandateDomain, mandateMessage, type Mandate } from "@/lib/mandate";
import { fmtExpiryDate, fmtStrike, fmtUsd, shortAddr } from "@/lib/format";
import type { AiMandateDraft, MandateDraftTerms } from "@/lib/mandateDraft";
import type { OptionsAsset } from "@/lib/assets";
import type { TradeSide } from "@/lib/trade";
import { ExplorerLink } from "./ExplorerLink";
import { policyNetwork } from "@/lib/policyNetwork";
import type { ExecutionNetwork } from "@/lib/explorer";
import { ensureWalletChain, walletActionError } from "@/lib/walletChain";

type Terms = Omit<MandateDraftTerms, "side"> & { side: TradeSide };

const DEFAULT_TERMS: Terms = {
  asset: "ETH",
  side: "put",
  premiumPerFill: "2",
  premiumTotal: "5",
  contracts: "1",
  minTenorDays: "1",
  maxTenorDays: "14",
  riskScore: "75",
  persistenceMinutes: "10",
  cooldownMinutes: "60",
  validityHours: "24",
};

export function MandateSigningPanel({ owner, account, network }: { owner: Address; account: Address; network: ExecutionNetwork }) {
  const policy = policyNetwork(network);
  const [terms, setTerms] = useState<Terms>(DEFAULT_TERMS);
  const [nonce] = useState(() => BigInt(Date.now()));
  const [signed, setSigned] = useState<{ mandate: Mandate; signature: Hex } | null>(null);
  const [draft, setDraft] = useState<AiMandateDraft | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const effectiveTerms = policy.autonomousSide === "put" ? { ...terms, side: "put" as const } : terms;
  const { connector } = useAccount();
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();
  const { signTypedDataAsync, isPending: isSigning } = useSignTypedData();
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
  const configured = Boolean(policy.optionBook && policy.collateral && policy.agent);
  const signedHash = useMemo(() => signed && hashStruct({ data: mandateMessage(signed.mandate), primaryType: "Mandate", types: MANDATE_EIP712_TYPES }), [signed]);
  const active = activeMandateHash && activeMandateHash !== zeroHash ? activeMandateHash : null;
  const busy = isSwitching || isSigning || isSubmitting || isConfirming;

  const updateTerms = (change: Partial<Terms>) => {
    setTerms((value) => ({ ...value, ...change }));
    setSigned(null);
  };

  useEffect(() => {
    if (!isSuccess) return;
    void refetchActiveMandate();
    void refetchControl();
  }, [isSuccess, refetchActiveMandate, refetchControl]);

  const signMandate = async () => {
    if (!policy.optionBook || !policy.collateral || !policy.agent) return;
    setError(null);
    setSigned(null);
    try {
      await ensureWalletChain(policy.chainId, connector, switchChainAsync);
      const mandate = buildMandate(owner, account, effectiveTerms, nonce, policy.optionBook, policy.collateral, policy.agent);
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
      const response = await fetch("/api/mandate-draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ asset: terms.asset }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `AI draft ${response.status}`);
      setDraft(data.draft as AiMandateDraft);
    } catch (error) {
      setError(error instanceof Error ? error.message : "AI draft was unavailable.");
    } finally {
      setDrafting(false);
    }
  };

  return (
    <section className="mt-4 border-t border-edge pt-4" aria-label="Sign execution mandate">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-blue">Step 2 · EIP-712</p>
          <h3 className="mt-1 text-[14px] font-bold text-fg">Sign execution mandate</h3>
          <p className="mt-1 text-[12px] text-muted">Review the immutable limits below. Your wallet signs, then registers the exact policy on this account. It never moves funds.</p>
        </div>
        <span className="rounded-full bg-panel2 px-2.5 py-1 text-[10px] font-semibold text-muted">Revocable before every fill</span>
      </div>

      {!configured ? (
        <p className="mt-3 rounded-lg border border-crit/30 bg-crit/10 p-3 text-[12px] text-crit">The {network === "mainnet" ? "Base-mainnet" : "Base Sepolia"} policy configuration is incomplete.</p>
      ) : (
        <>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Select label="Asset" value={terms.asset} onChange={(asset) => updateTerms({ asset: asset as OptionsAsset })} options={["BTC", "ETH"]} />
            <Select label="Option side" value={effectiveTerms.side} onChange={(side) => updateTerms({ side: side as TradeSide })} options={policy.autonomousSide === "both" ? ["put", "call"] : [policy.autonomousSide]} />
            <NumberField label="Max premium / fill" value={terms.premiumPerFill} suffix={policy.collateralLabel} onChange={(premiumPerFill) => updateTerms({ premiumPerFill })} />
            <NumberField label="Max premium / mandate" value={terms.premiumTotal} suffix={policy.collateralLabel} onChange={(premiumTotal) => updateTerms({ premiumTotal })} />
            <NumberField label="Contracts / fill" value={terms.contracts} suffix="contracts" onChange={(contracts) => updateTerms({ contracts })} />
            <NumberField label="Risk trigger" value={terms.riskScore} suffix="/ 100" onChange={(riskScore) => updateTerms({ riskScore })} />
            <NumberField label="Min tenor" value={terms.minTenorDays} suffix="days" onChange={(minTenorDays) => updateTerms({ minTenorDays })} />
            <NumberField label="Max tenor" value={terms.maxTenorDays} suffix="days" onChange={(maxTenorDays) => updateTerms({ maxTenorDays })} />
            <NumberField label="Risk persistence" value={terms.persistenceMinutes} suffix="minutes" onChange={(persistenceMinutes) => updateTerms({ persistenceMinutes })} />
            <NumberField label="Fill cooldown" value={terms.cooldownMinutes} suffix="minutes" onChange={(cooldownMinutes) => updateTerms({ cooldownMinutes })} />
            <NumberField label="Mandate validity" value={terms.validityHours} suffix="hours" onChange={(validityHours) => updateTerms({ validityHours })} />
          </div>

          {draft && <div className="mt-3 rounded-lg border border-blue/30 bg-blue/5 p-3 text-[12px] text-muted"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold text-fg">AI policy draft <span className="ml-1 rounded bg-panel px-1.5 py-0.5 text-[10px] text-blue">{draft.source === "gonka" ? "Gonka advisory" : "Deterministic fallback"}</span></p><button type="button" onClick={() => updateTerms(draft.terms)} disabled={busy} className="h-8 rounded-lg bg-blue px-3 text-[11px] font-semibold text-white disabled:opacity-60">Apply draft</button></div><p className="mt-2">{draft.quote.liquidity === "book" ? "Fresh listed Thetanuts OptionBook PUT" : "Thetanuts MM estimate · RFQ-only"}: {fmtStrike(draft.quote.strike)} · {fmtExpiryDate(draft.quote.expiryTs)} · {draft.quote.contracts} contracts · {fmtUsd(draft.quote.premiumUsd, false, 6)}.</p><p className="mt-1">{draft.rationale}</p><p className="mt-2 text-[10px] text-faint">Applying only edits this form. You still review, sign, and register the policy; it cannot execute a trade{draft.quote.liquidity === "mm" ? "; the agent waits for a fresh listed OptionBook order" : ""}.</p></div>}

          <div className="mt-3 grid gap-2 rounded-lg border border-edge bg-panel2 p-3 text-[11px] sm:grid-cols-[110px_1fr]">
            <span className="text-faint">Policy account</span><ExplorerLink network={network} resource="address" value={account} className="font-mono text-fg hover:text-blue">{shortAddr(account)}</ExplorerLink>
            <span className="text-faint">Policy agent</span><ExplorerLink network={network} resource="address" value={policy.agent!} className="font-mono text-fg hover:text-blue">{shortAddr(policy.agent!)}</ExplorerLink>
            <span className="text-faint">Policy nonce</span><span className="font-mono text-fg">{nonce.toString()}</span>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void createDraft()} disabled={busy || drafting} className="h-9 rounded-lg bg-panel3 px-3 text-[12px] font-semibold text-blue hover:bg-panel2 disabled:cursor-wait disabled:opacity-60">{drafting ? "Reading fresh OptionBook…" : "Generate AI draft"}</button>
            <button type="button" onClick={() => void signMandate()} disabled={busy || isReadingMandate || Boolean(activeMandateError)} className="h-9 rounded-lg bg-blue px-3 text-[12px] font-semibold text-white hover:brightness-110 disabled:cursor-wait disabled:opacity-60">
              {isSwitching ? "Switching network…" : isSigning ? "Confirm in wallet…" : "Review and sign mandate"}
            </button>
            <span className="text-[11px] text-faint">The agent cannot change these terms.</span>
          </div>
        </>
      )}

      {signed && signedHash !== active && <div className="mt-3 rounded-lg border border-calm/30 bg-calm/10 p-3 text-[12px] text-calm"><p>Signature ready. Registering records this exact policy on-chain{active ? " and supersedes the active policy" : ""}; it does not fund the account.</p><button type="button" onClick={() => void registerMandate()} disabled={busy || isReadingMandate || Boolean(activeMandateError)} className="mt-2 h-8 rounded-lg bg-calm px-3 text-[11px] font-semibold text-white disabled:cursor-wait disabled:opacity-60">{isSubmitting ? "Confirm in wallet…" : isConfirming ? "Registering policy…" : "Register signed mandate"}</button></div>}
      {isConfirming && transactionHash && <p className="mt-3 rounded-lg border border-edge bg-panel2 p-3 text-[12px] text-muted">Policy transaction submitted; awaiting Base confirmation. <ExplorerLink network={network} resource="tx" value={transactionHash} className="underline">View transaction</ExplorerLink></p>}
      {signed && active && signedHash === active && <p className="mt-3 rounded-lg border border-calm/30 bg-calm/10 p-3 text-[12px] text-calm">This signed mandate is active on-chain. Funding status appears in Step 3. {transactionHash && <ExplorerLink network={network} resource="tx" value={transactionHash} className="underline">View registration</ExplorerLink>}</p>}
      {isReadingMandate && <p className="mt-3 text-[12px] text-muted">Checking the current on-chain policy…</p>}
      {activeMandateError && <p className="mt-3 rounded-lg border border-crit/30 bg-crit/10 p-3 text-[12px] text-crit">Could not verify the current on-chain policy. Signing and registration are disabled until the Base RPC read recovers.</p>}
      {active && <div className="mt-3 rounded-lg border border-edge bg-panel2 p-3 text-[12px] text-muted"><p>Active policy <span className="font-mono text-fg">{shortAddr(active)}</span>{control?.[0] ? " · paused" : " · executable only within its limits"}</p>{isReadingControl ? <p className="mt-2">Checking pause/revocation state…</p> : controlError ? <p className="mt-2 text-crit">Could not verify pause/revocation state. Controls are disabled until the Base RPC read recovers.</p> : <div className="mt-2 flex flex-wrap gap-2"><button type="button" onClick={() => void changeControl(control?.[0] ? "resumeMandate" : "pauseMandate")} disabled={busy} className="h-8 rounded-lg bg-panel3 px-3 text-[11px] font-semibold text-fg disabled:cursor-wait disabled:opacity-60">{control?.[0] ? "Resume" : "Pause"}</button><button type="button" onClick={() => void changeControl("revokeMandate")} disabled={busy} className="h-8 rounded-lg border border-crit/40 px-3 text-[11px] font-semibold text-crit disabled:cursor-wait disabled:opacity-60">Revoke</button></div>}</div>}
      {(transactionFailed || error) && <p className="mt-3 rounded-lg border border-crit/30 bg-crit/10 p-3 text-[12px] text-crit">{transactionFailed ? `Policy transaction did not succeed on-chain: ${walletActionError(transactionError, "check the linked transaction before retrying.")} The active policy is unchanged; network gas may have been charged.` : error}</p>}
    </section>
  );
}

function buildMandate(owner: Address, account: Address, terms: Terms, nonce: bigint, optionBook: Address, collateral: Address, agent: Address): Mandate {
  const perFill = units(terms.premiumPerFill, "premium per fill");
  const total = units(terms.premiumTotal, "premium total");
  const minTenorDays = whole(terms.minTenorDays, "minimum tenor", 1, 28);
  const maxTenorDays = whole(terms.maxTenorDays, "maximum tenor", minTenorDays, 56);
  const validityHours = whole(terms.validityHours, "mandate validity", 1, 168);
  const persistenceMinutes = whole(terms.persistenceMinutes, "risk persistence", 0, validityHours * 60);
  const now = Math.floor(Date.now() / 1000);
  return {
    owner,
    account,
    agent,
    optionBook,
    collateral,
    asset: terms.asset,
    side: terms.side,
    maxPremiumPerFill: perFill,
    maxPremiumTotal: total,
    maxContractsPerFill: units(terms.contracts, "contracts"),
    minTenorSeconds: minTenorDays * 86400,
    maxTenorSeconds: maxTenorDays * 86400,
    riskThresholdBps: whole(terms.riskScore, "risk trigger", 0, 100) * 100,
    persistenceSeconds: persistenceMinutes * 60,
    minExecutionIntervalSeconds: whole(terms.cooldownMinutes, "fill cooldown", 0, validityHours * 60) * 60,
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

function NumberField({ label, value, suffix, onChange }: { label: string; value: string; suffix: string; onChange: (value: string) => void }) {
  return <label className="rounded-lg border border-edge bg-panel2 p-2.5 text-[11px] text-faint"><span className="block">{label}</span><span className="mt-1 flex items-center gap-1"><input inputMode="decimal" value={value} onChange={(event) => onChange(event.target.value)} className="min-w-0 flex-1 bg-transparent text-[13px] font-semibold text-fg outline-none" /><span>{suffix}</span></span></label>;
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return <label className="rounded-lg border border-edge bg-panel2 p-2.5 text-[11px] text-faint"><span className="block">{label}</span><select value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 w-full bg-transparent text-[13px] font-semibold text-fg outline-none">{options.map((option) => <option key={option} value={option}>{option.toUpperCase()}</option>)}</select></label>;
}
