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
import type { Asset } from "@/lib/assets";
import type { TradeQuote, TradeSide } from "@/lib/trade";
import { TRADE_PERIODS, type TradePeriod } from "@/lib/tradePeriods";
import type { RfqPrepared, RfqStatus } from "@/lib/rfq";
import { fmtExpiryDate, fmtIv, fmtStrike, fmtUsd, riskColor } from "@/lib/format";
import {
  getActiveProvider,
  switchToBase,
  type Eip1193Provider,
} from "./WalletConnect";

const QUOTE_DEBOUNCE_MS = 250;
const QUOTE_REFRESH_MS = 15_000;

type TxPhase =
  | { step: "idle" }
  | { step: "connecting" | "approving" | "filling" }
  | { step: "done"; hash: string }
  | { step: "error"; message: string };

type RfqPhase =
  | { step: "idle" }
  | { step: "connecting" | "approving" | "requesting" }
  | { step: "auction"; status: RfqStatus | null; deadline: number }
  | { step: "accepting"; status: RfqStatus }
  | { step: "done"; hash: string; optionAddress: string | null }
  | { step: "error"; message: string };

async function connectWallet() {
  const provider = getActiveProvider();
  if (!provider) throw new Error("No wallet detected — install MetaMask or Phantom.");
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  const from = accounts[0];
  if (!from) throw new Error("no account connected");
  await switchToBase(provider);
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
    const needed = BigInt("0x" + approve.data.slice(-64));
    const data =
      "0xdd62ed3e" + // allowance(address,address)
      owner.slice(2).toLowerCase().padStart(64, "0") +
      spender.slice(2).toLowerCase().padStart(64, "0");
    const res = (await provider.request({
      method: "eth_call",
      params: [{ to: approve.to, data }, "latest"],
    })) as string;
    return BigInt(res) < needed;
  } catch {
    return true; // can't verify — approve to be safe
  }
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
  const [amountStr, setAmountStr] = useState("1");
  const [period, setPeriod] = useState<TradePeriod>(7);
  const [quote, setQuote] = useState<TradeQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tx, setTx] = useState<TxPhase>({ step: "idle" });
  const [rfq, setRfq] = useState<RfqPhase>({ step: "idle" });
  const [mountedSec] = useState(() => Math.floor(Date.now() / 1000));
  const seq = useRef(0);
  const rfqAddress = useRef<string | null>(null);

  const amount = Number(amountStr);
  const validAmount = Number.isFinite(amount) && amount > 0;

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

  const buy = async () => {
    if (!quote?.txs) return;
    try {
      setTx({ step: "connecting" });
      const { provider, from } = await connectWallet();
      if (await needsApproval(provider, from, quote.txs.approve, quote.txs.fill.to)) {
        setTx({ step: "approving" });
        await sendTx(provider, from, quote.txs.approve);
      }
      setTx({ step: "filling" });
      const fillHash = await sendTx(provider, from, quote.txs.fill);
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
  const busy = tx.step === "connecting" || tx.step === "approving" || tx.step === "filling";

  return (
    <section className="card p-5 flex flex-col gap-4" aria-label="Trade options">
      <div className="flex items-center justify-between">
        <h2 className="text-[14px] font-semibold">Trade {asset} options</h2>
        <span className="flex items-center gap-1.5 text-[11px] text-muted">
          <span className="live-dot inline-block size-1.5 rounded-full bg-calm" />
          Live book
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
              <span className="text-calm">● Instant fill — live maker order</span>
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

      {/* Amplification impact — only once the trade is fully configured */}
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
        </div>
      )}

      {/* Action */}
      {rfq.step === "connecting" ||
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
            disabled={!validAmount}
            className="h-10 rounded-lg bg-blue text-white text-[13px] font-semibold hover:brightness-110 transition disabled:opacity-50"
          >
            {validAmount
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
          disabled={!configured || !quoteInSync || !quote?.txs || busy}
          className="h-10 rounded-lg bg-blue text-white text-[13px] font-semibold hover:brightness-110 transition disabled:opacity-50"
        >
          {busy
            ? tx.step === "connecting"
              ? "Connecting wallet…"
              : tx.step === "approving"
                ? `Approving ${displayToken(quote?.premiumToken ?? "")}…`
                : "Filling order…"
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
