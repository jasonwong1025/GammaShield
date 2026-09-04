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
npm run check:impact   # market impact model self-check (pure math, no network)
npm run check:agent    # autonomous engine self-check: action model, decision engine, trend, thesis (pure)
npm run check:sizes    # EIP-170 contract size guard — MUST pass before any deploy
npm run deploy:sepolia:shadow # redeploy the Base Sepolia shadow book + policy factory
cd contracts && forge test # ShadowOptionBook + MandateAccount tests
```

Verification = `npm run lint`, `npm run build`, `npm run check:risk` when you touch the risk model, `npm run check:impact` when you touch the impact model, `npm run check:agent` when you touch anything under `lib/autonomous/`, `cd contracts && forge test` **and `npm run check:sizes`** when contracts change, and eyeballing the dashboard against live data.

## Architecture — read this before editing

Data flows in one direction: **exchange/chain → server (lib/ + app/api/) → client components**. Client components never call exchanges or the Thetanuts SDK. The sole exception is wallet-scoped wagmi/viem reads and user-signed transactions; no server key can trade for a user.

### Server side (`lib/` + `app/api/`)

- `lib/assets.ts` — **single source of truth for supported assets** (BTC, ETH — both `options: true` with a live Thetanuts book). Adding an asset starts here.
- `lib/engine.ts` — the **book-level** risk engine. Pure, deliberately simple math over normalized order rows: per-strike GEX, gamma flip, expiry buckets, risk score. No I/O in this file — keep it pure and inspectable.
- `lib/contractRisk.ts` — the **per-contract** risk model: one option or one multi-leg structure scored as `Premium 20% + IV 15% + TimeDecay 10% + Liquidity 20% + Market 25% + Expiry 10%`. Different question from `engine.ts`, whose score enters here as the Market component and nothing more. Also pure — historical vol and book quotes are passed in. Two invariants: a sub-score whose input this venue does not publish is **dropped** and the surviving weights renormalize (never defaulted to a midpoint), and short exposure inverts only the directional components (premium, vol richness, decay) — exit cost, dealer gamma and expiry proximity hurt both sides, and loss probability is already direction-aware via the signed payoff. Covered by `npm run check:risk`.
- `lib/marketImpact.ts` — the **market impact** model: what a fill makes dealers trade in spot. Two flows, kept separate because they are different obligations — the one-off delta hedge at the fill, and the gamma feedback the position adds to every later 1% move. Sign convention is `engine.ts`'s exactly (taker buys → dealer short gamma → amplifying), and `flipStrikeOf` is imported from there rather than reimplemented. Pure; volume and vol are passed in. Because the whole live book carries only ~$33k of dealer gamma per 1% move against ~$1.6B of daily spot volume, the headline figure is the **threshold** — the size at which a flow would reach 1% of daily volume — and the price-move estimate is floored at 0.01% instead of printing fake precision. Covered by `npm run check:impact`.
- `lib/spotVolume.ts` — measured 24h spot volume, Coinbase **plus** Binance summed (not one falling back to the other: impact scales with 1/sqrt(volume), so which venues are counted changes the answer). Always reports which venues contributed, and is labelled a floor rather than global volume. Null when both fail — the impact estimate then drops rather than using a constant.
- `lib/realizedVol.ts` — trailing 30d realized vol and its 1y distribution, from the same daily candles the price chart uses. This is the reference the IV component ranks against: nothing in this stack persists an implied-vol history, so percentile is measured against **realized** vol and must always be labelled that way, never as an unqualified "IV percentile".
- `lib/snapshot.ts` — fetches the live Thetanuts book via the SDK, normalizes orders, runs the engine, and produces one `MarketSnapshot` for the whole dashboard. Briefly cached to be gentle on the RPC.
- `lib/modelBook.ts` — Black-Scholes pricing/greeks shared by the shadow demo book (`lib/shadow.ts`) and live-book rho (which the Thetanuts pricing API doesn't return).
- `lib/stream.ts` — one upstream Coinbase WebSocket fanned out to browser tabs via SSE (`/api/stream`). Module-level singleton; don't open per-request sockets.
- `lib/format.ts` — shared number/USD/percent formatters. Use these instead of ad-hoc `toFixed`/`toLocaleString`.
- `lib/trade.ts` — live OptionBook quote construction. It uses SDK preview/encoding, rejects unknown collateral/implementations/targets, and returns wallet calldata only for a fresh listed order.
- `lib/positions.ts` — normalizes the Thetanuts indexer’s open positions. Prefer `implementationName` over raw option-type values when identifying call/put products.
- `lib/shadow.ts` — Base Sepolia-only, signed receipt-book demo. It mirrors a mainnet quote but is never a Thetanuts position. Reads `closedAt` per receipt, and `getShadowBookVersion()` reports whether the deployed book can close at all (1 = fill only, 2 = fill and close).

#### `lib/autonomous/` — the position-management engine

Everything the agent decides lives here. The flow is **monitor → trigger → decide → guard → execute**, one module per stage so each can be tested alone. The pure modules run unchanged in the browser, the workers and the self-check.

- `policy.ts` — the **action model** and the only place a user's plain limits become signed terms. Three invariants: availability is separate from permission (an action the deployment cannot execute is reported unavailable **with a reason**, never skipped silently); the toggles may only **narrow** what the signed policy permits; and the notional→contracts conversion always rounds **down**. The AI may only subtract too, with **one bounded exception** — it may initiate a **close**, and only a close, on a stated thesis break: never a hedge or roll, only on an open position with close armed, always full size, always with a reason. `resolveAgentAction` enforces every bound.
- `decision.ts` — the **single decision engine**: evaluates HOLD/HEDGE/CLOSE/ROLL, records why each rejected action lost, and picks by fixed precedence (close > roll > hedge > hold). Two rules are load-bearing: it never closes on a drawdown (drawdown is not an input — a bought option's loss is fixed at entry), and expiry proximity is **necessary but never sufficient** for a roll. `intentOf` bridges it to `policy.ts`.
- `positionRisk.ts` — `contractRisk.ts` applied to a position the user **holds**. Thetanuts publishes greeks and IV on **listed orders only**, so the IV inputs are passed as null and the scorer drops the IV and time-decay components, renormalizing 20/15/10/20/25/10 down to roughly 27/27/33/13 across premium, liquidity, market and expiry. Deriving an IV from the mark was considered and rejected: it would feed a modelled number into a signed on-chain trigger, and a component that appears only when a matching order happens to be listed would jump the score and reset the persistence clock.
- `trend.ts` — risk trend from the samples the account stores. Every window is `number | null`; **null means the history is too short, never that risk is flat**, and the UI must keep that distinction.
- `thesisRules.ts` — pure: what a recorded view means and whether it still holds (a 10% move against it, an elapsed horizon, a reached target). Split from the store so the browser, the server and the self-check share one implementation.
- `thesis.ts` — the **store** for the objective and thesis, owner-signed and replay-guarded. Off-chain on purpose: the mandate is a spending limit, and a target price is a revisable opinion. A standing view covers what the agent opens itself; per-position views override it. **A position with no recorded view has none** — never treat that as a neutral view.
- `triggers.ts` — whether anything moved enough to warrant a fresh assessment. Fails **open**: with nothing to compare against it assesses, because assessment is read-only and skipping one is the worse error. Two of the spec's triggers are listed in `UNSOURCEABLE_TRIGGERS` with reasons.
- `actions.ts` — store for the three action switches, same signature discipline as `thesis.ts`.
- `proposal.ts` — the AI half. Unreachable, slow or malformed all return `null`, which means "no opinion"; the agent is never blocked on the model. There is deliberately **no confidence score**: an LLM's self-report is not calibrated and nothing gates on it.
- `exit.ts` — builds and signs the two structs a shadow exit needs. Refuses to close an unpriceable receipt, or one worth more than the book's balance, rather than inventing a mark.
- `types.ts` — shared shapes, plus `UNSOURCEABLE_REASON_CODES`: every reason code the spec asked for that this venue cannot support, with why. That list is the honesty surface for the decision engine, the way dropped sub-scores are for the risk model.

**Two risk scores, two triggers, and they are not interchangeable.** The **book** score (`engine.ts`) arms a hedge, because opening cover is a bet on the market regime. The **per-contract** score (`positionRisk.ts`) arms a close or a roll, because exiting or replacing is a judgement about one position. The mandate signs `riskThresholdBps` and `positionRiskThresholdBps` separately, and `MandateAccount` gates each action on the right one — a roll is armed by the position's own risk, so a calm book no longer blocks replacing a genuinely risky expiring leg.

**What the Thetanuts SDK cannot do, so the engine does not pretend to.** `BaseOption.close()` is **bilateral** (both sides must agree off-chain), the OptionBook exposes **no maker-order creation** to end users — `fillOrder` and nothing else — and RFQ mints a *new* option rather than buying back one you hold. So there is no unilateral exit on Base mainnet at any price. `mmPricing.getPositionPricing` *will* quote a live bid on a held position, which is why a mainnet exit is surfaced as a **priced recommendation** (`outcome: "recommendation"`) and never as a fill. Autonomous close and roll exist only against GammaShield's own Base Sepolia `ShadowOptionBook`.

#### Contract size is the binding constraint on `MandateAccount`

`MandateAccountFactory` embeds `type(MandateAccount).creationCode` in its own runtime so it can CREATE2 accounts at predictable addresses. That means **every byte added to `MandateAccount` is a byte added to the factory**, and the factory is what hits EIP-170's 24,576-byte runtime limit first.

This is a real trap: `forge build` and `forge test` both pass happily over the limit, and the failure surfaces only as `EVM error: CreateContractSizeLimit` at deploy time. Run **`npm run check:sizes`** — it exits non-zero on a breach — before pushing any contract change.

Two things hold the current margin (~1.1KB on the factory), and neither is optional:

- **`via_ir = true` with `optimizer_runs = 1`** in `contracts/foundry.toml`. Low runs optimizes for size over runtime gas; measured at ~0.7% more gas per op, which is the right trade when size is what blocks deployment. Putting `optimizer_runs` back to 200 costs ~700 bytes and leaves the factory within 400 bytes of the limit.
- **Custom errors, never `require` strings.** A revert string costs roughly 70 bytes against a custom error's ~10, doubled by the factory embedding. `MandateAccount` declares its errors at the top of the contract; extend that list rather than reintroducing a string. Tests assert on `.selector`, not on reason text.

### API routes (`app/api/`)

- `market` — full `MarketSnapshot` (book + risk + feed), `cache-control: no-store`. Feed rows carry an `impactBasis` (per-contract market-impact inputs, minus the strike ladder — that is one array per asset the client already holds). Each single-leg feed row carries a `risk` block from `lib/contractRisk.ts`; multi-leg rows do not, because the pricing API returns one blended premium and greeks block that cannot honestly be split across legs.
- `quote` — quote for standard 7/14/28-day intents resolved to real Thetanuts tenors. A listed maker order returns SDK-generated exact approve/fill calldata; otherwise it is an RFQ-only estimate. The SDK stays read-only server-side; only the user's wallet signs.
- `rfq` — custom-expiry RFQ support. Prepare/settle are disabled unless `ENABLE_RFQ_EXECUTION=true`; RFQs escrow collateral and require a separate review. Status reads remain available.
- `positions` — real Base-mainnet OptionBook positions from the Thetanuts indexer.
- `shadow/quote`, `shadow/positions` — Base Sepolia demonstration positions only; label them as shadow, never live Thetanuts positions.
- `agent-actions` — reads (public) and writes (owner-signed) the AI agent's three action switches for one policy account.
- `agent-thesis` — reads (public) and writes (owner-signed) the objective and trading thesis for one policy account. Owner-gated because a broken thesis can trigger an exit, so anyone able to rewrite it could make someone else's agent sell.
- `whatif` — natural-language spot-order impact. Uses the same measured volume/vol and the same one-round law as `lib/marketImpact.ts`; it must not reintroduce hardcoded market size.
- `stream` — SSE price ticks (init snapshot, then `price` events, 15s heartbeats).
- `klines` — OHLCV proxy: Coinbase first, Binance fallback, staleness guard, aggregates finer candles for non-native intervals.
- `price` — lightweight spot ticker.

Routes return `502` with `{ error }` on upstream failure — keep that shape.

### Client (`components/`)

All chart/dashboard components are `"use client"`. Layout: `Dashboard.tsx` composes `TopBar`, `AssetRail` (asset switcher w/ live prices), `PriceChart` (lightweight-charts, 10 chart types, live tick-built candles), `TradePanel` (user-reviewed live/shadow fills and risk impact), `GexChart` + `Heatmap` (ECharts via the shared `EChart.tsx` wrapper), `BookFeed` (including live and shadow position tabs). The second tab is `AgentView.tsx` (tab key `agent`).

- Live prices come from the `/api/stream` SSE feed (see `LivePrice.tsx`), not polling.
- New ECharts charts go through `EChart.tsx`; don't instantiate echarts directly.
- Per-contract risk renders through `ContractRiskPanel.tsx` (book feed drill-down and `TradePanel`). It must keep showing which sub-scores were dropped and why — that panel is the honesty surface for the model.
- Market impact renders through `MarketImpactPanel.tsx` (same two places), which replaced the older score-before/after "amplification risk impact" card. Its what-if size box re-runs `lib/marketImpact.ts` in the browser — the math is pure and linear in contracts, so no round trip. Keep the volume/vol provenance footer and the negligible floor: a fill on this book genuinely cannot move spot, and the panel must say so rather than print zeros.
- Asset logos live in `public/coins/` as SVGs, keyed by lowercase symbol.
- `MandateSigningPanel.tsx` is the AI agent's form: **seven controls only** — asset, maximum loss, maximum trade size, the three action switches, and the objective plus standing view. Everything else the mandate needs (tenor window, **both** risk triggers, persistence, cooldown, validity) is derived and shown read-only under "What gets signed"; never re-expose the derived terms as inputs. It must keep saying which limit is exact and which is approximate — maximum loss is metered on-chain to the cent, the trade cap is notional converted at a strike ceiling and re-checked exactly before each fill. Per-position view overrides are edited here too, keyed to the **policy account's** open positions: those are the only positions the agent manages, and a view keyed to anything less certain than a real position id could attach to the wrong one and trigger the wrong exit.
- `AgentMonitoringPanel.tsx` renders the assessment behind each cycle — action, urgency, position health, reason codes, and **the three actions that were not taken with the reason for each**. A hold has to read as a judgement, not as inactivity. It must keep flagging an AI-initiated close as such, and must keep explaining that a mainnet exit is a priced recommendation rather than a fill.
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
