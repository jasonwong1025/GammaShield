<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# GammaShield

Web3 options risk dashboard built for the Thetanuts MUBA hackathon. It reads the **live Thetanuts options book on Base** (BTC/ETH), computes dealer-gamma / market-structure risk from it, and renders a real-time trading dashboard with live spot prices from Coinbase/Binance.

**Stack:** Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4 · lightweight-charts (price) · ECharts (GEX / heatmap) · ethers 6 + `@thetanuts-finance/thetanuts-client` (on-chain book).

## Commands

```bash
npm run dev     # dev server on http://localhost:3000
npm run build   # production build — run before pushing if you touched types/routes
npm run lint    # eslint — must pass before committing
```

No test suite yet. Verification = `npm run lint`, `npm run build`, and eyeballing the dashboard against live data.

## Architecture — read this before editing

Data flows in one direction: **exchange/chain → server (lib/ + app/api/) → client components**. Client components never talk to exchanges or the chain directly; they only hit our own API routes.

### Server side (`lib/` + `app/api/`)

- `lib/assets.ts` — **single source of truth for supported assets** (BTC, ETH, SOL, XRP, BNB, AVAX). BTC/ETH are `options: true` (live Thetanuts book); the rest are spot-only with a *modeled* book. Adding an asset starts here.
- `lib/engine.ts` — the risk engine. Pure, deliberately simple math over normalized order rows: per-strike GEX, gamma flip, expiry buckets, risk score. No I/O in this file — keep it pure and inspectable.
- `lib/snapshot.ts` — fetches the live Thetanuts book via the SDK, normalizes orders, runs the engine, and produces one `MarketSnapshot` for the whole dashboard. Briefly cached to be gentle on the RPC.
- `lib/modelBook.ts` — deterministic Black-Scholes-modeled book for assets without a live Thetanuts market (SOL/XRP/BNB/AVAX), priced against live spot. Anything derived from it must be **labeled as modeled in the UI** — never present modeled data as live.
- `lib/stream.ts` — one upstream Coinbase WebSocket fanned out to browser tabs via SSE (`/api/stream`). Module-level singleton; don't open per-request sockets.
- `lib/format.ts` — shared number/USD/percent formatters. Use these instead of ad-hoc `toFixed`/`toLocaleString`.

### API routes (`app/api/`)

- `market` — full `MarketSnapshot` (book + risk + feed), `cache-control: no-store`.
- `quote` — trade quote for buying a call/put (`lib/trade.ts`): any whole day 1–90. Days with a listed maker order quote that real order (premium + approve/fill calldata = instant fill); other days get an MM-ask estimate interpolated between the surrounding tenors. The SDK stays read-only server-side; only the user's wallet signs.
- `rfq` — custom-expiry execution via the Thetanuts RFQ auction (`lib/rfq.ts`): prepare (encode requestForQuotation for the wallet), status (poll + decrypt sealed maker offers with the server-held ECDH key in `.thetanuts-keys/`, gitignored — it unlocks offer prices only, never funds), settle (approve + settleQuotationEarly calldata).
- `stream` — SSE price ticks (init snapshot, then `price` events, 15s heartbeats).
- `klines` — OHLCV proxy: Coinbase first, Binance fallback, staleness guard, aggregates finer candles for non-native intervals.
- `price` — lightweight spot ticker.

Routes return `502` with `{ error }` on upstream failure — keep that shape.

### Client (`components/`)

All chart/dashboard components are `"use client"`. Layout: `Dashboard.tsx` composes `TopBar`, `AssetRail` (asset switcher w/ live prices), `PriceChart` (lightweight-charts, 10 chart types, live tick-built candles), `TradePanel` (buy calls/puts from the live book; shows the trade's amplification-risk impact), `GexChart` + `Heatmap` (ECharts via the shared `EChart.tsx` wrapper), `BookFeed`.

- Live prices come from the `/api/stream` SSE feed (see `LivePrice.tsx`), not polling.
- New ECharts charts go through `EChart.tsx`; don't instantiate echarts directly.
- Asset logos live in `public/coins/` as SVGs, keyed by lowercase symbol.

## Conventions

- **Theme:** light theme, navy accent palette, Inter font. Colors come from CSS variables in `app/globals.css` — don't hardcode hex values in components.
- **TypeScript:** strict; shared shapes (`NormalizedOrder`, `AssetSnapshot`, `MarketSnapshot`, `Asset`) are exported from `lib/` — extend those types rather than redefining shapes locally.
- **Imports:** use the `@/` alias (`@/lib/...`, `@/components/...`).
- **Honesty about data:** the UI must always distinguish live vs. modeled vs. cached data. This is a risk product — never fabricate or silently substitute data.
- **External calls:** exchange endpoints (Coinbase, Binance incl. the `data-api.binance.vision` mirror) and the Base RPC are only called server-side. Add fallbacks + staleness guards for any new upstream, matching `klines`.

## Git workflow

- `main` is the integration branch; work on feature branches (`feat/...`) and merge via PR.
- Run `npm run lint` before every commit. Keep the auto-generated `nextjs-agent-rules` block at the top of this file — `next dev` re-adds it if removed.
- `CLAUDE.md` is just `@AGENTS.md` (an import). **Edit AGENTS.md only** — never duplicate content into CLAUDE.md, or the two will drift.
