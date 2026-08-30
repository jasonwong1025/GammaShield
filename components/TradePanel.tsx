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
import { Interface } from "ethers";
import { isOptionsAsset, type Asset } from "@/lib/assets";
import type { TradeQuote, TradeSide } from "@/lib/trade";
import { TRADE_PERIODS, type TradePeriod } from "@/lib/tradePeriods";
import { COLLATERAL_TOKENS, RESERVE_BUFFER, collateralFor, decimalsForTokenSymbol } from "@/lib/collateral";
import type { RfqPrepared, RfqStatus } from "@/lib/rfq";
import type { AiRiskAssessment } from "@/lib/aiRisk";
import type { ShadowQuote } from "@/lib/shadow";
import { fmtExpiryDate, fmtIv, fmtStrike, fmtUsd, riskColor } from "@/lib/format";
import {
  getActiveProvider,
  BASE_CHAIN,
  BASE_SEPOLIA_CHAIN,
  switchToBase,
  switchToBaseSepolia,
  type Eip1193Provider,
} from "./WalletConnect";

const QUOTE_DEBOUNCE_MS = 250;
const QUOTE_REFRESH_MS = 15_000;
const ERC20_INTERFACE = new Interface([
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
]);

type TxPhase =
  | { step: "idle" }
  | { step: "connecting" | "preparing" | "approving" | "preflighting" | "filling" }
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
  | { step: "connecting" | "preparing" | "approving" | "filling" }
  | { step: "done"; hash: string; quote: ShadowQuote }
  | { step: "error"; message: string };

async function connectWallet() {
  const provider = getActiveProvider();
  if (!provider) throw new Error("No wallet detected — install MetaMask or Phantom.");
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  const from = accounts[0];
  if (!from) throw new Error("no account connected");
  await switchToBase(provider);
  if (await provider.request({ method: "eth_chainId" }) !== BASE_CHAIN.chainId) {
    throw new Error("switch your wallet to Base mainnet to continue");
  }
  return { provider, from };
}

async function connectShadowWallet() {
  const provider = getActiveProvider();
  if (!provider) throw new Error("No wallet detected — install MetaMask or Phantom.");
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  const from = accounts[0];
  if (!from) throw new Error("no account connected");
  await switchToBaseSepolia(provider);
  if (await provider.request({ method: "eth_chainId" }) !== BASE_SEPOLIA_CHAIN.chainId) {
    throw new Error("switch your wallet to Base Sepolia to continue");
  }
  return { provider, from };
}

async function sendTx(
  provider: Eip1193Provider,
  from: string,
  tx: { to: string; data: string },
): Promise<string> {
  const hash = (await provider.request({
    method: "eth_sendTransaction",
    params: [{ from, to: tx.to, data: tx.data }],
  })) as string;
  await waitForReceipt(provider, hash);
  return hash;
}

// Skip the approve popup when the token allowance already covers the pull —
// fewer wallet prompts, and sidesteps MetaMask's spending-cap alert flow.
async function needsApproval(
  provider: Eip1193Provider,
  owner: string,
  approve: { to: string; data: string },
  spender: string,
): Promise<boolean> {
  try {
    const needed = ERC20_INTERFACE.decodeFunctionData("approve", approve.data)[1] as bigint;
    const data = ERC20_INTERFACE.encodeFunctionData("allowance", [owner, spender]);
    const res = (await provider.request({
      method: "eth_call",
      params: [{ to: approve.to, data }, "latest"],
    })) as string;
    return (ERC20_INTERFACE.decodeFunctionResult("allowance", res)[0] as bigint) < needed;
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
  provider: Eip1193Provider,
  from: string,
  tx: { to: string; data: string },
) {
  await provider.request({
    method: "eth_call",
    params: [{ from, to: tx.to, data: tx.data }, "pending"],
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

async function waitForReceipt(provider: Eip1193Provider, hash: string) {
  for (let i = 0; i < 60; i++) {
    const receipt = (await provider.request({
      method: "eth_getTransactionReceipt",
      params: [hash],
    })) as { status?: string } | null;
    if (receipt) {
      if (receipt.status === "0x0") throw new Error("transaction reverted");
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("timed out waiting for confirmation");
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

export function TradePanel({ asset, live }: { asset: Asset; live: boolean }) {
  const [side, setSide] = useState<TradeSide>("call");
  const [executionMode, setExecutionMode] = useState<"mainnet" | "shadow">("mainnet");
  const [amountStr, setAmountStr] = useState("1");
  const [period, setPeriod] = useState<TradePeriod>(7);
  const [quote, setQuote] = useState<TradeQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tx, setTx] = useState<TxPhase>({ step: "idle" });
  const [shadowTx, setShadowTx] = useState<ShadowTxPhase>({ step: "idle" });
  const [rfq, setRfq] = useState<RfqPhase>({ step: "idle" });
  const [mountedSec] = useState(() => Math.floor(Date.now() / 1000));
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [tokenBalance, setTokenBalance] = useState<number | null>(null);
  const [ethBalance, setEthBalance] = useState<number | null>(null);
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

  // Silent lookup of whichever wallet is already connected (no popup) — lets
  // us warn about insufficient balance before the user even clicks buy.
  useEffect(() => {
    const provider = getActiveProvider();
    if (!provider) return;
    let stale = false;
    provider
      .request({ method: "eth_accounts" })
      .then((accounts) => {
        if (!stale) setWalletAddress((accounts as string[])[0] ?? null);
      })
      .catch(() => {});
    const onAccountsChanged = ((accounts: string[]) => {
      setWalletAddress(accounts[0] ?? null);
    }) as never;
    provider.on?.("accountsChanged", onAccountsChanged);
    return () => {
      stale = true;
      provider.removeListener?.("accountsChanged", onAccountsChanged);
    };
  }, []);

  // Whichever collateral token this trade would actually pull from: the
  // exact maker's token for a book fill, else the standard RFQ collateral.
  const collateralInfo =
    quote?.source === "book" && quote.txs
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
        : null;
  const collateralAddress = collateralInfo?.address;
  const collateralDecimals = collateralInfo?.decimals;

  // Balance check — a wallet-side warning, not a substitute for the real
  // approve/fill math, so plain floats are fine here.
  useEffect(() => {
    if (!walletAddress || !collateralAddress || collateralDecimals == null) return;
    const provider = getActiveProvider();
    if (!provider) return;
    let stale = false;
    const balanceOfData = ERC20_INTERFACE.encodeFunctionData("balanceOf", [walletAddress]);
    provider
      .request({ method: "eth_call", params: [{ to: collateralAddress, data: balanceOfData }, "latest"] })
      .then((res) => {
        if (stale) return;
        const balance = ERC20_INTERFACE.decodeFunctionResult("balanceOf", res as string)[0] as bigint;
        setTokenBalance(Number(balance) / 10 ** collateralDecimals);
      })
      .catch(() => {
        if (!stale) setTokenBalance(null);
      });
    provider
      .request({ method: "eth_getBalance", params: [walletAddress, "latest"] })
      .then((res) => {
        if (!stale) setEthBalance(Number(BigInt(res as string)) / 1e18);
      })
      .catch(() => {
        if (!stale) setEthBalance(null);
      });
    return () => {
      stale = true;
    };
  }, [walletAddress, collateralAddress, collateralDecimals]);

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
        const res = await fetch(
          `/api/quote?asset=${asset}&side=${side}&contracts=${contracts}&period=${period}`,
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
  }, [asset, side, amount, validAmount, period, live]);

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
      const { provider, from } = await connectWallet();
      setTx({ step: "preparing" });
      const params = new URLSearchParams({
        asset,
        side,
        contracts: amountStr,
        period: String(period),
        fresh: "1",
      });
      const res = await fetch(`/api/quote?${params}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `quote ${res.status}`);
      const prepared = data as TradeQuote;
      if (prepared.source !== "book" || !prepared.txs) {
        throw new Error("No fresh listed OptionBook order can fill this trade. Choose an instant-fill tenor or request an RFQ.");
      }
      if (await needsApproval(provider, from, prepared.txs.approve, prepared.txs.fill.to)) {
        setTx({ step: "approving" });
        await sendTx(provider, from, prepared.txs.approve);
        if (await needsApproval(provider, from, prepared.txs.approve, prepared.txs.fill.to)) {
          throw new Error("Collateral approval is still insufficient; retry the approval before filling.");
        }
      }
      setTx({ step: "preflighting" });
      await preflightTx(provider, from, prepared.txs.fill);
      setTx({ step: "filling" });
      const fillHash = await sendTx(provider, from, prepared.txs.fill);
      setTx({ step: "done", hash: fillHash });
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
      const { provider, from } = await connectShadowWallet();
      setShadowTx({ step: "preparing" });
      const params = new URLSearchParams({ asset, buyer: from, side, contracts: amountStr, period: String(period) });
      const res = await fetch(`/api/shadow/quote?${params}`, { cache: "no-store" });
      const shadowQuote = await res.json();
      if (!res.ok) throw new Error(shadowQuote.error ?? `shadow quote ${res.status}`);
      const prepared = shadowQuote as ShadowQuote;
      if (await needsApproval(provider, from, prepared.txs.approve, prepared.txs.fill.to)) {
        setShadowTx({ step: "approving" });
        await sendTx(provider, from, prepared.txs.approve);
        if (await needsApproval(provider, from, prepared.txs.approve, prepared.txs.fill.to)) {
          throw new Error("Circle test USDC approval is still insufficient; retry the approval before filling");
        }
      }
      setShadowTx({ step: "filling" });
      const hash = await sendTx(provider, from, prepared.txs.fill);
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
      const { provider, from } = await connectWallet();
      rfqAddress.current = from;
      const prepared = await rfqApi<RfqPrepared>({
        action: "prepare",
        address: from,
        asset,
        side,
        contracts: amount,
        period,
      });
      if (await needsApproval(provider, from, prepared.approve, prepared.tx.to)) {
        setRfq({ step: "approving" });
        await sendTx(provider, from, prepared.approve);
      }
      setRfq({ step: "requesting" });
      await sendTx(provider, from, prepared.tx);
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
      const { provider, from } = await connectWallet();
      const txs = await rfqApi<{ approve: { to: string; data: string }; settle: { to: string; data: string } }>({
        action: "settle",
        address: from,
        id: status.id,
        offeror: status.best!.offeror,
      });
      if (await needsApproval(provider, from, txs.approve, txs.settle.to)) {
        await sendTx(provider, from, txs.approve);
      }
      const hash = await sendTx(provider, from, txs.settle);
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
  const impact = configured && quoteInSync ? quote.impact : null;
  const currentTradeKey = quote ? `${asset}:${side}:${quote.strike}:${quote.expiryTs}:${quote.contracts}` : null;
  const aiRiskCurrent = aiRisk && aiRiskKey === currentTradeKey ? aiRisk : null;
  const busy =
    tx.step === "connecting" ||
    tx.step === "preparing" ||
    tx.step === "approving" ||
    tx.step === "preflighting" ||
    tx.step === "filling";
  const shadowBusy = shadowTx.step === "connecting" || shadowTx.step === "preparing" || shadowTx.step === "approving" || shadowTx.step === "filling";

  // Required collateral for this quote: the padded approve amount for a book
  // fill, or contracts × reservePrice (the RFQ escrow) otherwise — same math
  // as lib/trade.ts / lib/rfq.ts, just in plain floats for a UI-only check.
  const requiredCollateral =
    quote && configured
      ? quote.source === "book"
        ? quote.totalCostToken * 1.01
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

  return (
    <section className="card p-5 flex flex-col gap-4" aria-label="Trade options">
      <div className="flex items-center justify-between">
        <h2 className="text-[14px] font-semibold">Trade {asset} options</h2>
        <span className="flex items-center gap-1.5 text-[11px] text-muted">
          <span className="live-dot inline-block size-1.5 rounded-full bg-calm" />
          OptionBook (live)
        </span>
      </div>

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

      <div>
        <div className="mb-1 text-[11px] text-muted">Execution network</div>
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-panel2 p-1">
          <button type="button" onClick={() => setExecutionMode("mainnet")} aria-pressed={executionMode === "mainnet"} className={`h-8 rounded-md text-[12px] font-semibold ${executionMode === "mainnet" ? "bg-panel text-fg shadow-sm" : "text-muted"}`}>
            Base mainnet
          </button>
          <button type="button" onClick={() => setExecutionMode("shadow")} aria-pressed={executionMode === "shadow"} className={`h-8 rounded-md text-[12px] font-semibold ${executionMode === "shadow" ? "bg-panel text-blue shadow-sm" : "text-muted"}`}>
            Sepolia shadow
          </button>
        </div>
      </div>

      {/* Amount */}
      <div>
        <div className="flex items-center justify-between text-[11px] text-muted mb-1">
          <span>Amount</span>
          {quote?.maxContracts != null && (
            <button
              className="text-blue hover:underline"
              onClick={() => setAmountStr(quote.maxContracts!.toFixed(2))}
            >
              Max {quote.maxContracts.toFixed(2)}
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
          className={`rounded-lg bg-panel2 p-3 flex flex-col gap-1.5 text-[12px] transition-opacity ${
            quoteInSync ? "" : "opacity-50"
          }`}
        >
          <div className="flex items-center justify-between text-[10px] uppercase tracking-wide">
            {quote.source === "book" ? (
              <span className="text-calm">● Instant fill — OptionBook</span>
            ) : (
              <span className="text-faint" title="No listed maker at this expiry — price is the market-maker ask; filling it requires an RFQ auction.">
                ◦ MM quote (estimate) — RFQ expiry
              </span>
            )}
          </div>
          <Row label="Strike (nearest ATM)" value={fmtStrike(quote.strike)} />
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
                {configured ? fmtUsd(quote.totalCostUsd, false) : "—"}
              </span>
            }
          />
        </div>
      ) : (
        <p className="text-[12px] text-faint">{loading ? "Quoting the live book…" : ""}</p>
      )}

      {executionMode === "shadow" ? (
        <p className="rounded-lg border border-blue/25 bg-bluesoft/30 p-2.5 text-[11px] leading-relaxed text-muted">
          Mirrors this live quote on Base Sepolia using Circle test USDC. Try 0.01 contracts for a small test; this is not a Thetanuts position.
        </p>
      ) : (
        <p className="rounded-lg border border-warn/25 bg-panel2 p-2.5 text-[11px] leading-relaxed text-muted">
          Base mainnet uses real funds. Before your wallet can send a fill, GammaShield refetches the listed OptionBook order and simulates the exact transaction against your account.
        </p>
      )}

      {/* Amplification impact — only once the trade is fully configured. One
          card: the always-on heuristic (lib/engine.ts) up top, then an
          optional AI second opinion (GonkaRouter, manual — see fetchAiRisk)
          below a divider. Kept in one card, not two, so it reads as "one
          risk readout, with an optional AI annotation" rather than two
          competing scores. */}
      {impact && (
        <div className="rounded-lg border border-edge p-3 text-[12px] flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-muted">Amplification risk impact</span>
            <span className="num font-semibold">
              <span style={{ color: riskColor(impact.scoreBefore) }}>{impact.scoreBefore}</span>
              <span className="text-faint"> → </span>
              <span style={{ color: riskColor(impact.scoreAfter) }}>{impact.scoreAfter}</span>
            </span>
          </div>
          <p className="text-faint leading-relaxed">
            Buying pushes dealers shorter gamma: net GEX{" "}
            {fmtUsd(impact.netGexBefore)} → {fmtUsd(impact.netGexAfter)} per 1% move
            {impact.regimeAfter !== impact.regimeBefore
              ? ` — regime flips to ${impact.regimeAfter}.`
              : ` (${impact.regimeAfter} regime).`}
          </p>

          <div className="border-t border-edge/60 my-0.5" />

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
              : !quoteInSync || !quote
                ? "Quoting…"
                : `Mirror ${quote.contracts.toFixed(3)} ${asset} ${side} on Sepolia`}
        </button>
      ) : rfq.step === "connecting" ||
      rfq.step === "approving" ||
      rfq.step === "requesting" ||
      rfq.step === "auction" ||
      rfq.step === "accepting" ? (
        <div className="rounded-lg border border-blue/40 bg-bluesoft/40 p-3 flex flex-col gap-2 text-[12px]">
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
                <div className="h-9 rounded-lg border border-edge text-muted flex items-center justify-center">
                  Waiting for maker offers…
                </div>
              )}
            </>
          )}
        </div>
      ) : rfq.step === "done" ? (
        <p className="text-[12px] text-calm">
          Option created via RFQ auction.{" "}
          <a
            href={`${process.env.NEXT_PUBLIC_BASE_EXPLORER_URL ?? "https://basescan.org"}/tx/${rfq.hash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            View transaction
          </a>{" "}
          <button className="text-faint underline" onClick={() => setRfq({ step: "idle" })}>
            trade again
          </button>
        </p>
      ) : quote && !selFillable ? (
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
      ) : (
        <button
          onClick={buy}
          disabled={!configured || !quoteInSync || !quote?.txs || busy || insufficientToken || insufficientGas}
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
              : !validAmount
                ? "Enter an amount to trade"
                : !quoteInSync || !quote
                  ? "Quoting…"
                  : configured && quote.txs
                    ? `Buy ${quote.contracts.toFixed(2)} ${asset} ${side}${quote.contracts === 1 ? "" : "s"}`
                    : "No listed makers right now"}
        </button>
      )}

      {tx.step === "done" && (
        <p className="text-[12px] text-calm">
          Filled on Base.{" "}
          <a
            href={`${process.env.NEXT_PUBLIC_BASE_EXPLORER_URL ?? "https://basescan.org"}/tx/${tx.hash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            View transaction
          </a>
        </p>
      )}
      {tx.step === "error" && <p className="text-[12px] text-crit">{tx.message}</p>}
      {shadowTx.step === "done" && (
        <p className="text-[12px] text-calm">
          Shadow fill confirmed on Base Sepolia. {BASE_SEPOLIA_CHAIN.blockExplorerUrls[0] && <a href={`${BASE_SEPOLIA_CHAIN.blockExplorerUrls[0]}/tx/${shadowTx.hash}`} target="_blank" rel="noopener noreferrer" className="underline">View transaction</a>}
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

      <p className="text-[11px] text-faint leading-relaxed">
        Periods with a listed maker order fill instantly from the Thetanuts book; otherwise the
        period trades through the Thetanuts RFQ auction at the real expiry. Premium is paid in
        the option&apos;s collateral token; everything settles on Base.
      </p>
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
