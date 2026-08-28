"use client";

// Buy a call/put from the live Thetanuts book. Quotes come from /api/quote
// (server-side SDK); the wallet only signs the approve + fill transactions.
// The amplification-impact readout appears once direction, amount, and
// duration are all set — it shows how *this* trade would shift the market.

import { useEffect, useRef, useState } from "react";
import type { Asset } from "@/lib/assets";
import type { TradeQuote, TradeSide } from "@/lib/trade";
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

export function TradePanel({ asset, live }: { asset: Asset; live: boolean }) {
  const [side, setSide] = useState<TradeSide>("call");
  const [amountStr, setAmountStr] = useState("1");
  const [days, setDays] = useState(7);
  const [quote, setQuote] = useState<TradeQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tx, setTx] = useState<TxPhase>({ step: "idle" });
  const [mountedSec] = useState(() => Math.floor(Date.now() / 1000));
  const seq = useRef(0);

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
          `/api/quote?asset=${asset}&side=${side}&contracts=${contracts}&days=${days}`,
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
  }, [asset, side, amount, validAmount, days, live]);

  const buy = async () => {
    if (!quote?.txs) return;
    const provider = getActiveProvider();
    if (!provider) {
      setTx({ step: "error", message: "No wallet detected — install MetaMask or Phantom." });
      return;
    }
    try {
      setTx({ step: "connecting" });
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      const from = accounts[0];
      if (!from) throw new Error("no account connected");
      await switchToBase(provider);

      setTx({ step: "approving" });
      const approveHash = (await provider.request({
        method: "eth_sendTransaction",
        params: [{ from, to: quote.txs.approve.to, data: quote.txs.approve.data }],
      })) as string;
      await waitForReceipt(provider, approveHash);

      setTx({ step: "filling" });
      const fillHash = (await provider.request({
        method: "eth_sendTransaction",
        params: [{ from, to: quote.txs.fill.to, data: quote.txs.fill.data }],
      })) as string;
      await waitForReceipt(provider, fillHash);
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
  // The slider is plain whole days (1–90) and reacts instantly; the quote
  // catches up in the background so dragging never waits on the network.
  const fillableExpiries = expiries.filter((e) => e.fillable);
  const selFillable = fillableExpiries.some((e) => Math.abs(e.days - days) <= 0.55);
  const nearestFillable = fillableExpiries.reduce<(typeof expiries)[number] | null>(
    (best, e) => (!best || Math.abs(e.days - days) < Math.abs(best.days - days) ? e : best),
    null,
  );
  const quoteInSync = !!quote && quote.requestedDays === days;
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

      {/* Duration — any whole day from 1 to 90 */}
      <div>
        <div className="flex items-center justify-between text-[11px] text-muted mb-1.5">
          <span>
            Period: <span className="text-fg font-medium">{days} days</span>
          </span>
          <span>
            Expires{" "}
            <span className="text-fg">
              {quoteInSync && quote
                ? fmtExpiryDate(quote.expiryTs)
                : fmtExpiryDate(mountedSec + days * 86400)}
            </span>
          </span>
        </div>
        <input
          type="range"
          min={1}
          max={90}
          step={1}
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          aria-label="Option duration in days"
          className="trade-range"
        />
        <div className="flex items-center justify-between text-[10px] text-faint mt-1">
          <span>1d</span>
          <span>90d</span>
        </div>
        {fillableExpiries.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap mt-1.5 text-[10px] text-faint">
            <span>Instant fill:</span>
            {fillableExpiries.map((e) => (
              <button
                key={e.ts}
                onClick={() => setDays(Math.round(e.days))}
                className={`px-1.5 py-0.5 rounded-md border transition ${
                  Math.abs(e.days - days) <= 0.55
                    ? "border-blue bg-bluesoft text-fg"
                    : "border-edge text-muted hover:text-fg"
                }`}
              >
                {fmtDays(e.days)}
              </button>
            ))}
          </div>
        )}
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
      {!selFillable && nearestFillable ? (
        <button
          onClick={() => setDays(Math.round(nearestFillable.days))}
          className="h-10 rounded-lg border border-blue text-blue text-[13px] font-semibold hover:bg-bluesoft transition"
        >
          Jump to instant fill · {fmtDays(nearestFillable.days)}
        </button>
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

      <p className="text-[11px] text-faint leading-relaxed">
        Expiries come from live market-maker pricing; ones marked instant-fill have a listed
        maker order on the Thetanuts book. Premium is paid in the maker&apos;s collateral token;
        fills settle on Base.
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
