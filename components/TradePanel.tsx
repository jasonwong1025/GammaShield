"use client";

// Buy a call/put from the live Thetanuts book. Quotes come from /api/quote
// (server-side SDK); the wallet only signs the approve + fill transactions.
// Duration is one of the three standard periods the SDK's tenor grid is
// built around — 7/14/28 days — each resolved to its real, Friday-anchored
// expiry. A period with a listed maker order fills instantly; otherwise it
// trades for real through the Thetanuts RFQ auction (request → maker offers
// → accept best). The amplification-impact readout appears once direction,
// amount, and duration are all set.

import { useEffect, useRef, useState } from "react";
import { useAccount, useBalance, useSendTransaction, useSwitchChain } from "wagmi";
import { getPublicClient, readContract, waitForTransactionReceipt } from "wagmi/actions";
import { base, baseSepolia } from "wagmi/chains";
import { decodeFunctionData, type Address, type Hex, zeroAddress } from "viem";
import { isOptionsAsset, type Asset } from "@/lib/assets";
import type { TradeQuote, TradeSide } from "@/lib/trade";
import { TRADE_PERIODS, type TradePeriod } from "@/lib/tradePeriods";
import { COLLATERAL_TOKENS, RESERVE_BUFFER, collateralFor, decimalsForTokenSymbol } from "@/lib/collateral";
import type { RfqPrepared, RfqStatus } from "@/lib/rfq";
import type { AiRiskAssessment } from "@/lib/aiRisk";
import type { ShadowQuote } from "@/lib/shadow";
import { wagmiConfig } from "@/lib/wagmi";
import { erc20Abi, useReadErc20BalanceOf } from "@/lib/generated/contracts";
import { fmtContracts, fmtExpiryDate, fmtIv, fmtStrike, fmtUsd, riskColor } from "@/lib/format";
import { ContractRiskPanel } from "./ContractRiskPanel";
import { MarketImpactPanel } from "./MarketImpactPanel";
import { ExplorerLink } from "./ExplorerLink";
import { useExecutionNetwork } from "./ExecutionNetworkProvider";
import { ensureWalletChain } from "@/lib/walletChain";
import { StrategyBuilder } from "./StrategyBuilder";

const QUOTE_DEBOUNCE_MS = 250;
const QUOTE_REFRESH_MS = 15_000;
const rfqExecutionEnabled = process.env.NEXT_PUBLIC_ENABLE_RFQ_EXECUTION === "true";
type GammaShieldChainId = typeof base.id | typeof baseSepolia.id;

export type HedgeIntent = {
  asset: Asset;
  contracts: string;
  period: TradePeriod;
  maxPremiumUsd: number;
  nonce: number;
};

type TxPhase =
  | { step: "idle" }
  | { step: "connecting" | "preparing" | "approving" | "ready" | "preflighting" | "filling" }
  | { step: "done"; hash: string }
  | { step: "error"; message: string };

type RfqPhase =
  | { step: "idle" }
  | { step: "connecting" | "approving" | "requesting" }
  | { step: "auction"; status: RfqStatus | null; deadline: number }
  | { step: "accepting"; status: RfqStatus }
  | { step: "done"; hash: string; optionAddress: string | null }
  | { step: "error"; message: string };

type ShadowTxPhase =
  | { step: "idle" }
  | { step: "connecting" | "preparing" | "approving" | "ready" | "filling" }
  | { step: "done"; hash: string; quote: ShadowQuote }
  | { step: "error"; message: string };

// Skip the approve popup when the token allowance already covers the pull —
// fewer wallet prompts, and sidesteps MetaMask's spending-cap alert flow.
async function needsApproval(
  owner: Address,
  approve: { to: string; data: string },
  spender: Address,
  chainId: GammaShieldChainId,
): Promise<boolean> {
  let allowanceNeeded: bigint;
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: approve.data as Hex });
    if (
      decoded.functionName !== "approve" ||
      !decoded.args ||
      decoded.args[0].toLowerCase() !== spender.toLowerCase()
    ) {
      throw new Error("Approval does not authorize the intended execution contract.");
    }
    allowanceNeeded = decoded.args[1];
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Approval does not")) throw error;
    return true;
  }

  try {
    const allowance = await readContract(wagmiConfig, {
      address: approve.to as Address,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, spender],
      chainId,
    });
    return allowance < allowanceNeeded;
  } catch {
    return true; // can't verify — approve to be safe
  }
}

/**
 * Simulate the exact user-signed fill after its approval is confirmed. This
 * catches stale/filled orders and insufficient balance without broadcasting a
 * transaction. The wallet remains the RPC authority for the user's account.
 */
async function preflightTx(
  from: Address,
  tx: { to: string; data: string },
  chainId: GammaShieldChainId,
) {
  const client = getPublicClient(wagmiConfig, { chainId });
  if (!client) throw new Error("Base RPC is not configured");
  await client.call({
    account: from,
    to: tx.to as Address,
    data: tx.data as Hex,
    blockTag: "pending",
  });
}

async function rfqApi<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch("/api/rfq", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `rfq ${res.status}`);
  return data as T;
}

/** aBasWETH → WETH etc. — friendlier display, full symbol in the title attr. */
function displayToken(symbol: string) {
  return symbol.replace(/^aBas/, "");
}

function fmtDays(d: number) {
  return d < 1 ? `${Math.round(d * 24)}h` : `${Math.round(d)}d`;
}

function periodLabel(p: TradePeriod) {
  return p === 7 ? "1 Week" : p === 14 ? "2 Weeks" : "4 Weeks";
}

export function TradePanel({ asset, live, hedgeIntent }: { asset: Asset; live: boolean; hedgeIntent: HedgeIntent | null }) {
  const { network } = useExecutionNetwork();
  const { address: walletAddress, connector } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  const initialHedge = hedgeIntent?.asset === asset ? hedgeIntent : null;
  const [side, setSide] = useState<TradeSide>(initialHedge ? "put" : "call");
  const [view, setView] = useState<"single" | "strategy">("single");
  const executionMode = network === "mainnet" ? "mainnet" : "shadow";
  const [amountStr, setAmountStr] = useState(initialHedge?.contracts ?? "1");
  const [period, setPeriod] = useState<TradePeriod>(initialHedge?.period ?? 7);
  const [quote, setQuote] = useState<TradeQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tx, setTx] = useState<TxPhase>({ step: "idle" });
  const [shadowTx, setShadowTx] = useState<ShadowTxPhase>({ step: "idle" });
  const [rfq, setRfq] = useState<RfqPhase>({ step: "idle" });
  const [mountedSec] = useState(() => Math.floor(Date.now() / 1000));
  const [aiRisk, setAiRisk] = useState<AiRiskAssessment | null>(null);
  // Trade signature the current aiRisk was computed for — lets the render
  // detect a config change since the last click and hide the stale read
  // rather than show a read for a trade that's no longer on screen.
  const [aiRiskKey, setAiRiskKey] = useState<string | null>(null);
  const [aiRiskLoading, setAiRiskLoading] = useState(false);
  const [aiRiskError, setAiRiskError] = useState<string | null>(null);
  const seq = useRef(0);
  const aiSeq = useRef(0);
  const rfqAddress = useRef<string | null>(null);

  const amount = Number(amountStr);
  const validAmount = Number.isFinite(amount) && amount > 0;
  const quotePremiumCap = hedgeIntent?.asset === asset && side === "put" ? hedgeIntent.maxPremiumUsd : null;

  // Whichever collateral token this trade would actually pull from: the
  // exact maker's token for a book fill, else the standard RFQ collateral.
  const collateralInfo =
    executionMode === "mainnet"
      ? quote?.source === "book" && quote.txs
        ? {
            address: quote.txs.approve.to,
            decimals: decimalsForTokenSymbol(quote.premiumToken),
            symbol: quote.premiumToken,
          }
        : isOptionsAsset(asset)
          ? {
              address: COLLATERAL_TOKENS[collateralFor(asset, side)].address,
              decimals: COLLATERAL_TOKENS[collateralFor(asset, side)].decimals,
              symbol: collateralFor(asset, side),
            }
          : null
      : null;
  const collateralAddress = collateralInfo?.address;
  const collateralDecimals = collateralInfo?.decimals;
  const executionChainId: GammaShieldChainId = executionMode === "mainnet" ? base.id : baseSepolia.id;
  const { data: tokenBalanceRaw } = useReadErc20BalanceOf({
    address: (collateralAddress ?? zeroAddress) as Address,
    args: [walletAddress ?? zeroAddress],
    chainId: executionChainId,
    query: { enabled: !!walletAddress && !!collateralAddress && collateralDecimals != null },
  });
  const { data: nativeBalance } = useBalance({
    address: walletAddress,
    chainId: executionChainId,
    query: { enabled: !!walletAddress },
  });
  const tokenBalance = tokenBalanceRaw != null && collateralDecimals != null
    ? Number(tokenBalanceRaw) / 10 ** collateralDecimals
    : null;
  const ethBalance = nativeBalance ? Number(nativeBalance.value) / 1e18 : null;

  const ensureChain = async (targetChainId: GammaShieldChainId): Promise<Address> => {
    if (!walletAddress) throw new Error("Connect a wallet from the top bar first.");
    await ensureWalletChain(targetChainId, connector, switchChainAsync);
    return walletAddress;
  };

  const sendTx = async (targetChainId: GammaShieldChainId, tx: { to: string; data: string }): Promise<string> => {
    let hash: Hex;
    try {
      hash = await sendTransactionAsync({
        chainId: targetChainId,
        to: tx.to as Address,
        data: tx.data as Hex,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("An internal error was received") || message.includes("Unexpected error")) {
        throw new Error("Your wallet did not submit the transaction, so no funds moved. Close any other Phantom confirmation, confirm Base Mainnet is selected, then retry once.");
      }
      throw error;
    }

    let receipt;
    try {
      receipt = await waitForTransactionReceipt(wagmiConfig, { chainId: targetChainId, hash });
    } catch {
      throw new Error(`Transaction was submitted but its receipt could not be read. Check BaseScan for ${hash} before retrying.`);
    }
    if (receipt.status !== "success") throw new Error("Transaction reverted on-chain.");
    return hash;
  };

  // Reset stale quote/tx state when the market or direction changes.
  const [prevKey, setPrevKey] = useState(`${asset}:${side}`);
  if (prevKey !== `${asset}:${side}`) {
    setPrevKey(`${asset}:${side}`);
    setQuote(null);
    setTx({ step: "idle" });
  }

  useEffect(() => {
    if (!live) return;
    const id = ++seq.current;
    const fetchQuote = async () => {
      setLoading(true);
      try {
        const contracts = validAmount ? amount : 0;
        const params = new URLSearchParams({ asset, side, contracts: String(contracts), period: String(period) });
        if (quotePremiumCap != null) params.set("maxPremiumUsd", String(quotePremiumCap));
        const res = await fetch(
          `/api/quote?${params}`,
          { cache: "no-store" },
        );
        const data = await res.json();
        if (seq.current !== id) return;
        if (!res.ok) throw new Error(data.error ?? `quote ${res.status}`);
        setQuote(data);
        setQuoteError(null);
      } catch (e) {
        if (seq.current !== id) return;
        setQuote(null);
        setQuoteError(e instanceof Error ? e.message : "quote failed");
      } finally {
        if (seq.current === id) setLoading(false);
      }
    };
    const timer = setTimeout(fetchQuote, QUOTE_DEBOUNCE_MS);
    const refresh = setInterval(fetchQuote, QUOTE_REFRESH_MS);
    return () => {
      clearTimeout(timer);
      clearInterval(refresh);
    };
  }, [asset, side, amount, validAmount, period, live, quotePremiumCap]);

  // AI second opinion on the same fill, via GonkaRouter (lib/aiRisk.ts).
  // Manual only — the user clicks "Get AI read"; nothing here auto-fires on
  // quote refresh or input changes, so GonkaRouter is only ever called when
  // asked. Reuses the impact block /api/quote already computed.
  const fetchAiRisk = async () => {
    const configuredNow = validAmount && !!quote && quote.contracts > 0;
    const inSync = !!quote && quote.requestedPeriod === period;
    const impactNow = configuredNow && inSync ? quote!.impact : null;
    if (!impactNow || !quote) return;
    const key = `${asset}:${side}:${quote.strike}:${quote.expiryTs}:${quote.contracts}`;
    const id = ++aiSeq.current;
    setAiRiskLoading(true);
    setAiRiskError(null);
    try {
      const res = await fetch("/api/risk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          asset,
          side,
          strike: quote.strike,
          expiryTs: quote.expiryTs,
          contracts: quote.contracts,
          spot: quote.spot,
          greeks: quote.greeks,
          scoreBefore: impactNow.scoreBefore,
          scoreAfter: impactNow.scoreAfter,
          netGexBefore: impactNow.netGexBefore,
          netGexAfter: impactNow.netGexAfter,
          regimeBefore: impactNow.regimeBefore,
          regimeAfter: impactNow.regimeAfter,
        }),
      });
      const data = await res.json();
      if (aiSeq.current !== id) return;
      if (!res.ok) throw new Error(data.error ?? `risk ${res.status}`);
      setAiRisk(data);
      setAiRiskKey(key);
    } catch (e) {
      if (aiSeq.current !== id) return;
      setAiRiskError(e instanceof Error ? e.message : "AI risk read failed");
    } finally {
      if (aiSeq.current === id) setAiRiskLoading(false);
    }
  };

  const buy = async () => {
    if (!validAmount) return;
    try {
      setTx({ step: "connecting" });
      const from = await ensureChain(base.id);
      setTx({ step: "preparing" });
      const params = new URLSearchParams({
        asset,
        side,
        contracts: amountStr,
        period: String(period),
        fresh: "1",
      });
      if (quotePremiumCap != null) params.set("maxPremiumUsd", String(quotePremiumCap));
      const res = await fetch(`/api/quote?${params}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `quote ${res.status}`);
      const prepared = data as TradeQuote;
      if (prepared.source !== "book" || !prepared.txs) {
        throw new Error("No fresh listed OptionBook order can fill this trade. Choose an instant-fill tenor or request an RFQ.");
      }
      // A maker may cancel or reprice between the visible quote and this
      // fresh preparation. The user must review any changed maker, option,
      // expiry, collateral, size, or price before an approval/fill can occur.
      if (
        !quote ||
        prepared.asset !== quote.asset ||
        prepared.side !== quote.side ||
        prepared.maker !== quote.maker ||
        prepared.strike !== quote.strike ||
        prepared.expiryTs !== quote.expiryTs ||
        prepared.premiumToken !== quote.premiumToken ||
        prepared.contracts !== quote.contracts ||
        prepared.totalCostToken !== quote.totalCostToken ||
        prepared.txs.approve.to.toLowerCase() !== quote.txs?.approve.to.toLowerCase() ||
        prepared.txs.fill.to.toLowerCase() !== quote.txs?.fill.to.toLowerCase()
      ) {
        setQuote(prepared);
        throw new Error("Live order changed. Review the refreshed quote before continuing.");
      }
      if (await needsApproval(from, prepared.txs.approve, prepared.txs.fill.to as Address, base.id)) {
        setTx({ step: "approving" });
        await sendTx(base.id, prepared.txs.approve);
        setTx({ step: "ready" });
        return;
      }
      setTx({ step: "preflighting" });
      await preflightTx(from, prepared.txs.fill, base.id);
      setTx({ step: "filling" });
      const fillHash = await sendTx(base.id, prepared.txs.fill);
      setTx({ step: "done", hash: fillHash });
      window.dispatchEvent(new Event("thetanuts-position-changed"));
    } catch (e) {
      const message =
        (e as { code?: number })?.code === 4001
          ? "Transaction rejected in wallet."
          : e instanceof Error
            ? e.message
            : "transaction failed";
      setTx({ step: "error", message });
    }
  };

  const buyShadow = async () => {
    if (!validAmount) return;
    try {
      setShadowTx({ step: "connecting" });
      const from = await ensureChain(baseSepolia.id);
      setShadowTx({ step: "preparing" });
      const params = new URLSearchParams({ asset, buyer: from, side, contracts: amountStr, period: String(period) });
      const res = await fetch(`/api/shadow/quote?${params}`, { cache: "no-store" });
      const shadowQuote = await res.json();
      if (!res.ok) throw new Error(shadowQuote.error ?? `shadow quote ${res.status}`);
      const prepared = shadowQuote as ShadowQuote;
      if (await needsApproval(from, prepared.txs.approve, prepared.txs.fill.to as Address, baseSepolia.id)) {
        setShadowTx({ step: "approving" });
        await sendTx(baseSepolia.id, prepared.txs.approve);
        setShadowTx({ step: "ready" });
        return;
      }
      setShadowTx({ step: "filling" });
      const hash = await sendTx(baseSepolia.id, prepared.txs.fill);
      setShadowTx({ step: "done", hash, quote: prepared });
    } catch (e) {
      const message =
        (e as { code?: number })?.code === 4001
          ? "Transaction rejected in wallet."
          : e instanceof Error
            ? e.message
            : "shadow fill failed";
      setShadowTx({ step: "error", message });
    }
  };

  // Custom-expiry path: submit a sealed-bid RFQ, then poll for maker offers.
  const requestRfq = async () => {
    if (!validAmount) return;
    try {
      setRfq({ step: "connecting" });
      const from = await ensureChain(base.id);
      rfqAddress.current = from;
      const prepared = await rfqApi<RfqPrepared>({
        action: "prepare",
        address: from,
        asset,
        side,
        contracts: amount,
        period,
      });
      if (await needsApproval(from, prepared.approve, prepared.tx.to as Address, base.id)) {
        setRfq({ step: "approving" });
        await sendTx(base.id, prepared.approve);
      }
      setRfq({ step: "requesting" });
      await sendTx(base.id, prepared.tx);
      setRfq({ step: "auction", status: null, deadline: prepared.offerDeadlineTs });
    } catch (e) {
      const message =
        (e as { code?: number })?.code === 4001
          ? "Transaction rejected in wallet."
          : e instanceof Error
            ? e.message
            : "RFQ request failed";
      setRfq({ step: "error", message });
    }
  };

  // Poll the auction for decrypted maker offers.
  useEffect(() => {
    if (rfq.step !== "auction" || !rfqAddress.current) return;
    const address = rfqAddress.current;
    let stale = false;
    const poll = async () => {
      try {
        const { rfq: status } = await rfqApi<{ rfq: RfqStatus | null }>({
          action: "status",
          address,
        });
        if (stale || !status) return;
        setRfq((cur) => (cur.step === "auction" ? { ...cur, status } : cur));
      } catch {
        /* transient poll failure — keep trying */
      }
    };
    poll();
    const timer = setInterval(poll, 5_000);
    return () => {
      stale = true;
      clearInterval(timer);
    };
  }, [rfq.step]);

  const acceptOffer = async () => {
    if (rfq.step !== "auction" || !rfq.status?.best || !rfqAddress.current) return;
    const status = rfq.status;
    try {
      setRfq({ step: "accepting", status });
      const from = await ensureChain(base.id);
      const txs = await rfqApi<{ approve: { to: string; data: string }; settle: { to: string; data: string } }>({
        action: "settle",
        address: from,
        id: status.id,
        offeror: status.best!.offeror,
      });
      if (await needsApproval(from, txs.approve, txs.settle.to as Address, base.id)) {
        await sendTx(base.id, txs.approve);
      }
      const hash = await sendTx(base.id, txs.settle);
      let optionAddress: string | null = null;
      try {
        const { rfq: settled } = await rfqApi<{ rfq: RfqStatus | null }>({
          action: "status",
          address: from,
        });
        optionAddress = settled?.optionAddress ?? null;
      } catch {}
      setRfq({ step: "done", hash, optionAddress });
    } catch (e) {
      const message =
        (e as { code?: number })?.code === 4001
          ? "Transaction rejected in wallet."
          : e instanceof Error
            ? e.message
            : "settle failed";
      setRfq({ step: "error", message });
    }
  };

  if (!live) {
    return (
      <section className="card p-5" aria-label="Trade options">
        <h2 className="text-[14px] font-semibold">Trade {asset} options</h2>
        <p className="mt-2 text-[12px] text-muted leading-relaxed">
          {asset} has no live options market on Thetanuts yet — trading unlocks the moment a
          book launches on Base. BTC and ETH are tradable now.
        </p>
      </section>
    );
  }

  const expiries = quote?.expiries ?? [];
  const selectedEntry = expiries.find((e) => e.period === period) ?? null;
  const fillableExpiries = expiries.filter((e) => e.fillable);
  const selFillable = !!selectedEntry?.fillable;
  const nearestFillable = fillableExpiries.reduce<(typeof expiries)[number] | null>(
    (best, e) => (!best || Math.abs(e.period - period) < Math.abs(best.period - period) ? e : best),
    null,
  );
  const quoteInSync = !!quote && quote.requestedPeriod === period;
  const configured = validAmount && !!quote && quote.contracts > 0;
  const impactBasis = configured && quoteInSync ? quote.impactBasis : null;
  const contractRisk = configured && quoteInSync ? quote.risk : null;
  const currentTradeKey = quote ? `${asset}:${side}:${quote.strike}:${quote.expiryTs}:${quote.contracts}` : null;
  const aiRiskCurrent = aiRisk && aiRiskKey === currentTradeKey ? aiRisk : null;
  const busy =
    tx.step === "connecting" ||
    tx.step === "preparing" ||
    tx.step === "approving" ||
    tx.step === "preflighting" ||
    tx.step === "filling";
  const shadowBusy = shadowTx.step === "connecting" || shadowTx.step === "preparing" || shadowTx.step === "approving" || shadowTx.step === "filling";

  // Required collateral for this quote: the exact simulated book-fill amount,
  // or contracts × reservePrice (the RFQ escrow) otherwise — same math
  // as lib/trade.ts / lib/rfq.ts, just in plain floats for a UI-only check.
  const requiredCollateral =
    quote && configured
      ? quote.source === "book"
        ? quote.totalCostToken
        : quote.contracts *
          (side === "put" ? quote.premiumPerContractUsd : quote.premiumPerContractUsd / quote.spot) *
          RESERVE_BUFFER
      : null;
  const insufficientToken =
    !!walletAddress &&
    !!collateralInfo &&
    requiredCollateral != null &&
    tokenBalance != null &&
    tokenBalance < requiredCollateral;
  const insufficientGas = !!walletAddress && ethBalance != null && ethBalance < 0.0003;
  const overHedgeBudget =
    hedgeIntent?.asset === asset &&
    side === "put" &&
    quote?.source === "book" &&
    quote.totalCostUsd > hedgeIntent.maxPremiumUsd;
  const protectedValueAtExpiry = quote && side === "put" ? quote.strike * quote.contracts : null;
  const protectedFloorAfterPremium =
    protectedValueAtExpiry !== null && quote ? protectedValueAtExpiry - quote.totalCostUsd : null;

  return (
    <section className="card p-5 flex flex-col gap-4" aria-label="Trade options">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[14px] font-semibold">Trade {asset} options</h2>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg bg-panel2 p-1 text-[10px] font-semibold"><button onClick={() => setView("single")} aria-pressed={view === "single"} className={`h-6 rounded px-2 ${view === "single" ? "bg-panel text-fg shadow-sm" : "text-muted"}`}>Single</button><button onClick={() => setView("strategy")} aria-pressed={view === "strategy"} className={`h-6 rounded px-2 ${view === "strategy" ? "bg-panel text-fg shadow-sm" : "text-muted"}`}>Strategies</button></div>
          <span className="hidden sm:flex items-center gap-1.5 text-[11px] text-muted"><span className="live-dot inline-block size-1.5 rounded-full bg-calm" />OptionBook (live)</span>
        </div>
      </div>

      {view === "strategy" ? <StrategyBuilder key={asset} asset={asset} /> : <>

      {/* Direction */}
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-panel2 p-1">
        {(["call", "put"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSide(s)}
            aria-pressed={side === s}
            className="h-8 rounded-md text-[13px] font-semibold transition"
            style={
              side === s
                ? {
                    color: "#fff",
                    background: s === "call" ? "var(--calm)" : "var(--crit)",
                  }
                : { color: "var(--muted)" }
            }
          >
            {s === "call" ? "↗ Call" : "↘ Put"}
          </button>
        ))}
      </div>

      {/* Amount */}
      <div>
        <div className="flex items-center justify-between text-[11px] text-muted mb-1">
          <span>Amount</span>
          {quote?.maxContracts != null && (
            <button
              className="text-blue hover:underline"
              onClick={() => setAmountStr(fmtContracts(quote.maxContracts!))}
            >
              Max {fmtContracts(quote.maxContracts)}
            </button>
          )}
        </div>
        <div className="flex items-center rounded-lg border border-edge bg-panel px-3 h-10">
          <input
            value={amountStr}
            onChange={(e) => setAmountStr(e.target.value)}
            inputMode="decimal"
            aria-label="Number of contracts"
            className="w-full bg-transparent text-[14px] num outline-none"
          />
          <span className="text-[12px] text-faint whitespace-nowrap">
            {side === "call" ? "calls" : "puts"} · 1 {asset} each
          </span>
        </div>
      </div>

      {/* Duration — the SDK's own tenor grid: weekly / bi-weekly / 4-week */}
      <div>
        <div className="flex items-center justify-between text-[11px] text-muted mb-1.5">
          <span>Period</span>
          <span>
            Expires{" "}
            <span className="text-fg">
              {quoteInSync && quote
                ? fmtExpiryDate(quote.expiryTs)
                : selectedEntry
                  ? fmtExpiryDate(selectedEntry.ts)
                  : fmtExpiryDate(mountedSec + period * 86400)}
            </span>
          </span>
        </div>
        <div className="grid grid-cols-3 gap-1 rounded-lg bg-panel2 p-1">
          {TRADE_PERIODS.map((p) => {
            const entry = expiries.find((e) => e.period === p);
            return (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                aria-pressed={period === p}
                className={`h-11 rounded-md text-[12px] font-semibold transition flex flex-col items-center justify-center gap-0.5 ${
                  period === p ? "bg-panel text-fg shadow-sm" : "text-muted hover:text-fg"
                }`}
              >
                <span>{periodLabel(p)}</span>
                {entry && (
                  <span className="text-[10px] font-normal text-faint flex items-center gap-1">
                    {entry.fillable && (
                      <span className="size-1 rounded-full bg-calm inline-block" />
                    )}
                    {fmtDays(entry.days)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Quote */}
      {quoteError ? (
        <p className="text-[12px] text-crit">{quoteError}</p>
      ) : quote ? (
        <div
          className={`rounded-md bg-panel2 p-3 flex flex-col gap-1.5 text-[12px] transition-opacity ${
            quoteInSync ? "" : "opacity-50"
          }`}
        >
          <div className="eyebrow flex items-center justify-between text-[10px]">
            {quote.source === "book" ? (
              <span className="text-calm">● Instant fill — OptionBook</span>
            ) : (
              <span className="text-faint" title="No listed maker at this expiry — price is the market-maker ask; filling it requires an RFQ auction.">
                ◦ MM quote (estimate) — RFQ expiry
              </span>
            )}
          </div>
          <Row label={quotePremiumCap != null && side === "put" ? "Strike (selected within cap)" : "Strike (nearest ATM)"} value={fmtStrike(quote.strike)} />
          <Row
            label="Premium / contract"
            value={
              <span title={`paid in ${quote.premiumToken}`}>
                {fmtUsd(quote.premiumPerContractUsd, false)}
                <span className="text-faint">
                  {" "}
                  · {quote.premiumPerContractToken.toPrecision(3)} {displayToken(quote.premiumToken)}
                </span>
              </span>
            }
          />
          <Row
            label={side === "call" ? "Break-even (above)" : "Break-even (below)"}
            value={fmtStrike(quote.breakEven)}
          />
          <Row label="Implied vol" value={fmtIv(quote.iv)} />
          <div className="border-t border-edge/60 my-1" />
          <Row
            label="Total cost"
            value={
              <span className="font-semibold text-fg">
                {configured ? fmtUsd(quote.totalCostUsd, false, 2) : "—"}
              </span>
            }
          />
        </div>
      ) : (
        <p className="text-[12px] text-faint">{loading ? "Quoting the live book…" : ""}</p>
      )}

      {hedgeIntent?.asset === asset && side === "put" && (
        <div
          className="note text-[12px] leading-relaxed"
          style={{ borderLeftColor: "var(--blue)", background: "color-mix(in srgb, var(--blue) 6%, transparent)" }}
        >
          <p className="eyebrow text-[10px] font-semibold text-blue">Protective-put plan</p>
          <p className="mt-1 text-muted">
            Protecting {fmtContracts(amount)} {asset} through {quote ? fmtExpiryDate(quote.expiryTs) : periodLabel(period)}. Your premium cap is {fmtUsd(hedgeIntent.maxPremiumUsd, false, 2)}.
          </p>
          {quote && protectedFloorAfterPremium !== null && (
            <p className="mt-1 text-fg">
              If you hold that amount to expiry and it settles below {fmtStrike(quote.strike)}, the holding plus cash payout is about {fmtUsd(protectedFloorAfterPremium, false, 2)} before network fees.
            </p>
          )}
          {overHedgeBudget && (
            <p className="mt-1 text-crit">
              This live listed put costs {fmtUsd(quote.totalCostUsd, false, 2)}, above your cap. Reduce protected exposure or choose another expiry.
            </p>
          )}
        </div>
      )}

      {/* Per-contract risk for the option itself — a separate question from
          the book-level amplification impact below, which is about what this
          fill does to everyone else. */}
      {contractRisk && <ContractRiskPanel risk={contractRisk} />}

      {/* Market impact — the spot flow this fill forces dealers to trade, and
          the size at which that would start to register (lib/marketImpact.ts).
          Replaces the old score-before/after card. The AI second opinion
          (GonkaRouter, manual — see fetchAiRisk) rides below a divider inside
          the same card, so it still reads as "one risk readout, with an
          optional AI annotation" rather than two competing scores. */}
      {impactBasis && quote && (
        <MarketImpactPanel basis={impactBasis} defaultContracts={quote.contracts} asset={asset}>
          <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-muted">
              AI second opinion <span className="text-faint">(GonkaRouter)</span>
            </span>
            {aiRiskCurrent && (
              <span className="num font-semibold" style={{ color: riskColor(aiRiskCurrent.score) }}>
                {aiRiskCurrent.score}
              </span>
            )}
          </div>
          {aiRiskCurrent ? (
            <>
              <p className="text-faint leading-relaxed">{aiRiskCurrent.rationale}</p>
              <p className="text-faint text-[11px]">
                {aiRiskCurrent.label} · {Math.round(aiRiskCurrent.confidence * 100)}% confidence · read at{" "}
                {new Date(aiRiskCurrent.generatedAt).toLocaleTimeString([], { hour12: false })}
              </p>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={fetchAiRisk}
                disabled={aiRiskLoading}
                className="self-start rounded-md border border-edge px-2.5 py-1 text-[12px] font-medium text-fg hover:bg-panel2 disabled:opacity-60"
              >
                {aiRiskLoading ? "Asking the model…" : "Get AI read"}
              </button>
              {aiRiskError && !aiRiskLoading && (
                <p className="text-crit text-[11px]">Unavailable — {aiRiskError}</p>
              )}
            </>
          )}
          </div>
        </MarketImpactPanel>
      )}

      {/* Insufficient-balance warning — checked against whichever wallet is
          already connected, before the user hits an on-chain revert. */}
      {(insufficientToken || insufficientGas) && (
        <p className="text-[12px] text-crit leading-relaxed">
          {insufficientToken &&
            `Insufficient ${collateralInfo ? displayToken(collateralInfo.symbol) : "token"} balance — need ~${requiredCollateral?.toPrecision(3)}, have ${tokenBalance?.toPrecision(3)}.`}
          {insufficientToken && insufficientGas && " "}
          {insufficientGas && "Insufficient ETH for gas."}
        </p>
      )}

      {/* Action */}
      {executionMode === "shadow" ? (
        <button
          onClick={buyShadow}
          disabled={!configured || !quoteInSync || shadowBusy}
          className="h-10 rounded-lg bg-blue text-white text-[13px] font-semibold hover:brightness-110 transition disabled:opacity-50"
        >
          {shadowBusy
            ? shadowTx.step === "connecting"
              ? "Connecting wallet…"
              : shadowTx.step === "preparing"
                ? "Signing fresh shadow quote…"
                : shadowTx.step === "approving"
                  ? "Approving Circle test USDC…"
                  : "Filling on Base Sepolia…"
            : !validAmount
              ? "Enter an amount to trade"
              : shadowTx.step === "ready"
                ? "Review and submit shadow fill"
                : !quoteInSync || !quote
                ? "Quoting…"
              : `Mirror ${fmtContracts(quote.contracts)} ${asset} ${side} on Sepolia`}
        </button>
      ) : rfq.step === "connecting" ||
      rfq.step === "approving" ||
      rfq.step === "requesting" ||
      rfq.step === "auction" ||
      rfq.step === "accepting" ? (
        <div className="rounded-md border border-blue/40 bg-bluesoft/40 p-3 flex flex-col gap-2 text-[12px]">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-fg">
              {rfq.step === "connecting"
                ? "Connecting wallet…"
                : rfq.step === "approving"
                  ? `Approving ${side === "put" ? "USDC" : asset === "ETH" ? "WETH" : "cbBTC"}…`
                  : rfq.step === "requesting"
                    ? "Submitting RFQ…"
                    : rfq.step === "accepting"
                      ? "Accepting best offer…"
                      : "RFQ auction live"}
            </span>
            {rfq.step === "auction" && (
              <button className="text-faint hover:text-fg" onClick={() => setRfq({ step: "idle" })}>
                dismiss
              </button>
            )}
          </div>
          {rfq.step === "auction" && (
            <>
              <p className="text-muted leading-relaxed">
                {rfq.status
                  ? `${rfq.status.offersCount} maker offer${rfq.status.offersCount === 1 ? "" : "s"} so far`
                  : "Broadcast to market makers"}{" "}
                — sealed bids, only you can see prices. Offers usually arrive within a couple of
                minutes.
              </p>
              {rfq.status?.best ? (
                <button
                  onClick={acceptOffer}
                  className="h-9 rounded-lg bg-blue text-white text-[13px] font-semibold hover:brightness-110 transition"
                >
                  Accept best offer · {fmtUsd(rfq.status.best.totalPremiumUsd, false)} total
                </button>
              ) : (
                <div className="h-9 rounded-md border border-edge text-muted flex items-center justify-center">
                  Waiting for maker offers…
                </div>
              )}
            </>
          )}
        </div>
      ) : rfq.step === "done" ? (
        <p className="text-[12px] text-calm">
          Option created via RFQ auction.{" "}
          <ExplorerLink network="mainnet" resource="tx" value={rfq.hash} className="underline">View transaction</ExplorerLink>{" "}
          <button className="text-faint underline" onClick={() => setRfq({ step: "idle" })}>
            trade again
          </button>
        </p>
      ) : quote && !selFillable && rfqExecutionEnabled ? (
        <div className="flex flex-col gap-1.5">
          <button
            onClick={requestRfq}
            disabled={!validAmount || insufficientToken || insufficientGas}
            className="h-10 rounded-lg bg-blue text-white text-[13px] font-semibold hover:brightness-110 transition disabled:opacity-50"
          >
            {insufficientToken || insufficientGas
              ? "Insufficient balance"
              : validAmount
                ? `Request quotes · ${periodLabel(period)} via RFQ auction`
                : "Enter an amount to trade"}
          </button>
          {nearestFillable && (
            <button
              onClick={() => setPeriod(nearestFillable.period)}
              className="text-[11px] text-muted hover:text-fg transition self-center"
            >
              or jump to instant fill · {periodLabel(nearestFillable.period)}
            </button>
          )}
        </div>
      ) : quote && !selFillable ? (
        <div
          className="note text-[12px] leading-relaxed text-muted"
          style={{ borderLeftColor: "var(--warn)", background: "color-mix(in srgb, var(--warn) 8%, transparent)" }}
        >
          No listed order for this expiry, and RFQ execution is paused. Choose an instant-fill tenor instead.
          {nearestFillable && (
            <button
              onClick={() => setPeriod(nearestFillable.period)}
              className="mt-2 block text-blue hover:underline"
            >
              Choose instant fill · {periodLabel(nearestFillable.period)}
            </button>
          )}
        </div>
      ) : (
        <button
          onClick={buy}
          disabled={!configured || !quoteInSync || !quote?.txs || busy || insufficientToken || insufficientGas || overHedgeBudget}
          className="h-10 rounded-lg bg-blue text-white text-[13px] font-semibold hover:brightness-110 transition disabled:opacity-50"
        >
          {busy
            ? tx.step === "connecting"
              ? "Connecting wallet…"
              : tx.step === "preparing"
                ? "Refreshing listed order…"
              : tx.step === "approving"
                ? `Approving ${displayToken(quote?.premiumToken ?? "")}…`
                : tx.step === "preflighting"
                  ? "Preflighting fill…"
                : "Filling order…"
            : insufficientToken || insufficientGas
              ? "Insufficient balance"
              : overHedgeBudget
                ? "Live put exceeds premium cap"
                : !validAmount
                  ? "Enter an amount to trade"
                  : tx.step === "ready"
                    ? "Review and submit fill"
                    : !quoteInSync || !quote
                  ? "Quoting…"
                  : configured && quote.txs
                    ? `Buy ${fmtContracts(quote.contracts)} ${asset} ${side}${quote.contracts === 1 ? "" : "s"}`
                    : "No listed makers right now"}
        </button>
      )}

      {tx.step === "done" && (
        <p className="text-[12px] text-calm">
          Filled on Base.{" "}
          <ExplorerLink network="mainnet" resource="tx" value={tx.hash} className="underline">View transaction</ExplorerLink>
        </p>
      )}
      {tx.step === "ready" && (
        <p className="text-[12px] text-calm">
          Approval confirmed for this order&apos;s exact simulated collateral. Review the refreshed quote, then submit the fill separately.
        </p>
      )}
      {tx.step === "error" && <p className="text-[12px] text-crit">{tx.message}</p>}
      {shadowTx.step === "done" && (
        <p className="text-[12px] text-calm">
          Shadow fill confirmed on Base Sepolia. <ExplorerLink network="sepolia" resource="tx" value={shadowTx.hash} className="underline">View transaction</ExplorerLink>
        </p>
      )}
      {shadowTx.step === "ready" && (
        <p className="text-[12px] text-calm">
          Test-USDC approval confirmed. Review the next signed shadow quote, then submit the test fill separately.
        </p>
      )}
      {shadowTx.step === "error" && <p className="text-[12px] text-crit">{shadowTx.message}</p>}
      {rfq.step === "error" && (
        <p className="text-[12px] text-crit">
          {rfq.message}{" "}
          <button className="underline" onClick={() => setRfq({ step: "idle" })}>
            retry
          </button>
        </p>
      )}

      </>}
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className="num text-fg text-right">{value}</span>
    </div>
  );
}
