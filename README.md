# GammaShield

GammaShield is a hackathon prototype for reading the live Thetanuts BTC/ETH OptionBook on Base, estimating dealer-gamma market fragility, and helping a user review a hedge trade. It also includes GonkaRouter-powered AI explanations and a clearly separate Base Sepolia shadow demo.

## What it does

- Reads live Thetanuts OptionBook data for BTC and ETH on Base.
- Calculates a deterministic market-fragility score from dealer gamma, book depth, strike crowding, expiry pressure, and implied volatility.
- Displays live options, modeled non-options markets, charts, and indexed Thetanuts positions.
- Uses GonkaRouter for optional AI risk explanations and market discussion.
- Prepares user-signed, listed OptionBook fills through the official `@thetanuts-finance/thetanuts-client` SDK.

## Execution boundaries

Mainnet execution is user-controlled:

- GammaShield does not store a user trading private key.
- A listed order is refreshed and preflighted before submission.
- Token approvals are capped to the SDK-previewed fill amount.
- Approval and fill are separate wallet actions.
- RFQ execution is disabled by default because it uses an escrow lifecycle.
- Base Sepolia shadow positions are test receipts, not Thetanuts positions.

Options trading has financial risk. This repository is a hackathon project and is not a claim of production readiness or investment advice.

## Stack

Next.js 16, React 19, TypeScript, Tailwind CSS, wagmi/viem, ethers, ECharts, lightweight-charts, the Thetanuts SDK, and GonkaRouter.

## Local setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Set `BASE_RPC_URL` to a Base mainnet RPC endpoint.
`GONKAROUTER_API_KEY` is required only for AI features.
Base Sepolia shadow mode additionally needs its shadow contract and quote-signer environment variables from `.env.example`.

Keep these disabled unless the RFQ flow has been separately reviewed:

```bash
ENABLE_RFQ_EXECUTION=false
NEXT_PUBLIC_ENABLE_RFQ_EXECUTION=false
```

## Checks

```bash
npm run lint
npm run build
cd contracts && forge test
```

## Project structure

- `lib/engine.ts` — deterministic market-fragility calculations.
- `lib/snapshot.ts` and `lib/trade.ts` — server-side Thetanuts SDK reads and listed-order preparation.
- `components/TradePanel.tsx` — wallet-reviewed Base mainnet and Sepolia shadow actions.
- `lib/positions.ts` — indexed Base-mainnet Thetanuts positions.
- `lib/shadow.ts` — Base Sepolia shadow receipts.
- `app/api/` — server API routes for market, quote, positions, AI, and shadow data.
