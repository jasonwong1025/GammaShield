<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# GammaShield

Web3 options risk dashboard built for the Thetanuts MUBA hackathon. It reads the **live Thetanuts options book on Base** (BTC/ETH), computes dealer-gamma / market-structure risk from it, and renders a real-time trading dashboard with live spot prices from Coinbase/Binance.

**Stack:** Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4 · lightweight-charts (price) · ECharts (GEX / heatmap) · ethers 6 + `@thetanuts-finance/thetanuts-client` (server-side book) · wagmi 3 + viem 2 (user wallet).

## Commands

```bash
npm run dev     # dev server on http://localhost:3000
npm run build   # production build — run before pushing if you touched types/routes
npm run lint    # eslint — must pass before committing
npm run wagmi:generate # regenerate typed ABIs after changing generated-contract config
npm run check:risk     # contract risk model self-check (pure math, no network)
cd contracts && forge test # ShadowOptionBook tests
```

Verification = `npm run lint`, `npm run build`, `npm run check:risk` when you touch the risk model, `cd contracts && forge test` when contracts change, and eyeballing the dashboard against live data.

## Architecture — read this before editing

Data flows in one direction: **exchange/chain → server (lib/ + app/api/) → client components**. Client components never call exchanges or the Thetanuts SDK. The sole exception is wallet-scoped wagmi/viem reads and user-signed transactions; no server key can trade for a user.

### Server side (`lib/` + `app/api/`)

- `lib/assets.ts` — **single source of truth for supported assets** (BTC, ETH — both `options: true` with a live Thetanuts book). Adding an asset starts here.
- `lib/engine.ts` — the **book-level** risk engine. Pure, deliberately simple math over normalized order rows: per-strike GEX, gamma flip, expiry buckets, risk score. No I/O in this file — keep it pure and inspectable.
- `lib/contractRisk.ts` — the **per-contract** risk model: one option or one multi-leg structure scored as `Premium 20% + IV 15% + TimeDecay 10% + Liquidity 20% + Market 25% + Expiry 10%`. Different question from `engine.ts`, whose score enters here as the Market component and nothing more. Also pure — historical vol and book quotes are passed in. Two invariants: a sub-score whose input this venue does not publish is **dropped** and the surviving weights renormalize (never defaulted to a midpoint), and short exposure inverts only the directional components (premium, vol richness, decay) — exit cost, dealer gamma and expiry proximity hurt both sides, and loss probability is already direction-aware via the signed payoff. Covered by `npm run check:risk`.
- `lib/realizedVol.ts` — trailing 30d realized vol and its 1y distribution, from the same daily candles the price chart uses. This is the reference the IV component ranks against: nothing in this stack persists an implied-vol history, so percentile is measured against **realized** vol and must always be labelled that way, never as an unqualified "IV percentile".
- `lib/snapshot.ts` — fetches the live Thetanuts book via the SDK, normalizes orders, runs the engine, and produces one `MarketSnapshot` for the whole dashboard. Briefly cached to be gentle on the RPC.
- `lib/modelBook.ts` — Black-Scholes pricing/greeks shared by the shadow demo book (`lib/shadow.ts`) and live-book rho (which the Thetanuts pricing API doesn't return).
- `lib/stream.ts` — one upstream Coinbase WebSocket fanned out to browser tabs via SSE (`/api/stream`). Module-level singleton; don't open per-request sockets.
- `lib/format.ts` — shared number/USD/percent formatters. Use these instead of ad-hoc `toFixed`/`toLocaleString`.
- `lib/trade.ts` — live OptionBook quote construction. It uses SDK preview/encoding, rejects unknown collateral/implementations/targets, and returns wallet calldata only for a fresh listed order.
- `lib/positions.ts` — normalizes the Thetanuts indexer’s open positions. Prefer `implementationName` over raw option-type values when identifying call/put products.
- `lib/shadow.ts` — Base Sepolia-only, signed receipt-book demo. It mirrors a mainnet quote but is never a Thetanuts position.

### API routes (`app/api/`)

- `market` — full `MarketSnapshot` (book + risk + feed), `cache-control: no-store`. Each single-leg feed row carries a `risk` block from `lib/contractRisk.ts`; multi-leg rows do not, because the pricing API returns one blended premium and greeks block that cannot honestly be split across legs.
- `quote` — quote for standard 7/14/28-day intents resolved to real Thetanuts tenors. A listed maker order returns SDK-generated exact approve/fill calldata; otherwise it is an RFQ-only estimate. The SDK stays read-only server-side; only the user's wallet signs.
- `rfq` — custom-expiry RFQ support. Prepare/settle are disabled unless `ENABLE_RFQ_EXECUTION=true`; RFQs escrow collateral and require a separate review. Status reads remain available.
- `positions` — real Base-mainnet OptionBook positions from the Thetanuts indexer.
- `shadow/quote`, `shadow/positions` — Base Sepolia demonstration positions only; label them as shadow, never live Thetanuts positions.
- `stream` — SSE price ticks (init snapshot, then `price` events, 15s heartbeats).
- `klines` — OHLCV proxy: Coinbase first, Binance fallback, staleness guard, aggregates finer candles for non-native intervals.
- `price` — lightweight spot ticker.

Routes return `502` with `{ error }` on upstream failure — keep that shape.

### Client (`components/`)

All chart/dashboard components are `"use client"`. Layout: `Dashboard.tsx` composes `TopBar`, `AssetRail` (asset switcher w/ live prices), `PriceChart` (lightweight-charts, 10 chart types, live tick-built candles), `TradePanel` (user-reviewed live/shadow fills and risk impact), `GexChart` + `Heatmap` (ECharts via the shared `EChart.tsx` wrapper), `BookFeed` (including live and shadow position tabs).

- Live prices come from the `/api/stream` SSE feed (see `LivePrice.tsx`), not polling.
- New ECharts charts go through `EChart.tsx`; don't instantiate echarts directly.
- Per-contract risk renders through `ContractRiskPanel.tsx` (book feed drill-down and `TradePanel`). It must keep showing which sub-scores were dropped and why — that panel is the honesty surface for the model.
- Asset logos live in `public/coins/` as SVGs, keyed by lowercase symbol.
- `TradePanel` must keep approvals and fills as separate user actions. Before a mainnet fill it must refetch the order, require the reviewed maker/option/expiry/collateral/size/cost to match, and preflight the exact calldata.

## Conventions

- **Theme:** light theme, navy accent palette, Inter font. Colors come from CSS variables in `app/globals.css` — don't hardcode hex values in components.
- **TypeScript:** strict; shared shapes (`NormalizedOrder`, `AssetSnapshot`, `MarketSnapshot`, `Asset`) are exported from `lib/` — extend those types rather than redefining shapes locally.
- **Imports:** use the `@/` alias (`@/lib/...`, `@/components/...`).
- **Honesty about data:** the UI must always distinguish live vs. modeled vs. cached data. This is a risk product — never fabricate or silently substitute data.
- **Wallet safety:** approval token and spender must be validated against the SDK’s chain config; approve no more than the exact SDK preview amount. Do not add unlimited approvals, server-side trade keys, or auto-fill after approval.
- **Thetanuts SDK:** before answering SDK questions or changing SDK integration, read [the full SDK LLM context](https://raw.githubusercontent.com/Thetanuts-Finance/thetanuts-sdk/main/llms-full.txt). Use the SDK for OptionBook calldata; do not hand-encode live fills.
- **External calls:** exchange endpoints (Coinbase, Binance incl. the `data-api.binance.vision` mirror) and SDK/RPC market reads are server-side. Wallet-scoped wagmi reads/preflights use the connected user’s Base provider. Add fallbacks + staleness guards for new upstream data calls, matching `klines`.

## Git workflow

- `main` is the integration branch; work on feature branches (`feat/...`) and merge via PR.
- Run `npm run lint` before every commit. Keep the auto-generated `nextjs-agent-rules` block at the top of this file — `next dev` re-adds it if removed.
- `CLAUDE.md` is just `@AGENTS.md` (an import). **Edit AGENTS.md only** — never duplicate content into CLAUDE.md, or the two will drift.
