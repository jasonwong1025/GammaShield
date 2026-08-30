# 🛡️ GammaShield: Complete Development Roadmap & Technical Action Plan

> **Dual-Track Target:**  
> • **Thetanuts Finance Track 02:** AI × Options (Live On-Chain Options Execution on Base Mainnet)  
> • **GonkaRouter Track:** AI for Society (Multi-Model Verification & Truth Scoring)

---

## 📌 High-Level System Overview

GammaShield is a **Real-Time Crypto Options Market Fragility Engine & Autonomous Hedging Agent** that protects retail users and DAOs against cascading dealer-hedging crashes (Gamma Squeezes).

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. Math Engine (TypeScript Backend)                                         │
│ • Pulls OptionBook data from Base via dedicated RPC                         │
│ • Calculates Net GEX, Greeks & Market Amplification Risk Score (0–100%)     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
┌──────────────────────────────────────▼──────────────────────────────────────┐
│ 2. AI Reasoning & Verification Layer (GonkaRouter API)                      │
│ • Base URL: https://api.gonkarouter.io/v1 (OpenAI/Anthropic compatible)     │
│ • Multi-model cross-verification via Kimi-K2.6 / MiniMax-M2.7 / DeepSeek   │
│ • Computes Market Truth Score (0–100%) + Outputs Gonka Request ID           │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ (Trigger: Risk > 75% & High Truth Score)
┌──────────────────────────────────────▼──────────────────────────────────────┐
│ 3. On-Chain Execution Layer (Thetanuts V4 SDK)                              │
│ • Executes real ~1 USDC protective Long Put option on Base Mainnet          │
│ • Outputs verifiable live TxHash on Basescan                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 🛠️ Step-by-Step Implementation Roadmap

### Phase 1: Environment Setup & Smoke Tests (Day 1)

#### 1. API Keys & Network Endpoints
* **GonkaRouter Auth**: Register via Email/Google at [gonkarouter.io](https://gonkarouter.io) to claim initial credits.
  * `Base URL`: `https://api.gonkarouter.io/v1`
  * `Auth Header`: `Authorization: Bearer sk-...` or `x-api-key: sk-...`
* **Base Mainnet RPC**: Set the server-only `BASE_RPC_URL` to a dedicated Base endpoint.
* **User wallet**: Fund the wallet that will review and sign the trade with the selected collateral token plus Base ETH for gas. GammaShield never stores a trading private key.

#### 2. Gonka 30-Second Smoke Test
Verify endpoint connectivity using `DeepSeek-V4-Flash`:
```bash
curl -s https://api.gonkarouter.io/v1/messages \
  -H "x-api-key: $GONKAROUTER_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "deepseek-ai/DeepSeek-V4-Flash-0731",
    "max_tokens": 1024,
    "messages": [{"role":"user","content":"Reply with just: pong"}]
  }'
```
*(Expected response: pong with HTTP 200)*

---

### Phase 2: Core Math Engine & Greeks Calculation (Days 1–2)

Build the deterministic math backend to compute Net Gamma Exposure (GEX) and the Market Amplification Risk Score (0–100%):

* **Option Chain Aggregation**: Fetch live strikes, expiries, and Open Interest ($OI$) from Thetanuts OptionBook contracts.
* **Formula Calculation**:
  $$\text{GEX} = \Gamma \times OI \times \text{Multiplier} \times S^2 \times 0.01$$
  * $\Gamma$ = Option Gamma (rate of change of Delta)
  * $OI$ = Open Interest per strike
  * $S$ = Current Spot Price
* **Risk Score Normalization**:
  * **Net GEX > 0 (Dampener Mode)**: Dealers absorb volatility $\rightarrow$ Risk Score 0–35%
  * **Net GEX ≈ 0 (Gamma Flip Transition)**: Neutral territory $\rightarrow$ Risk Score 36–70%
  * **Net GEX < 0 (Amplifier Mode)**: Forced dealer panic buying/selling $\rightarrow$ Risk Score 71–100%

---

### Phase 3: GonkaRouter Integration & Multi-Model Analysis (Days 2–3)

Implement the AI Verification and Fact-Checking Engine using `openai` or `anthropic` SDK pointed to Gonka Router:

```typescript
import OpenAI from "openai";

const gonka = new OpenAI({
  apiKey: process.env.GONKAROUTER_API_KEY,
  baseURL: "https://api.gonkarouter.io/v1", // Gonka unified endpoint
});

export async function analyzeMarketRumor(headline: string, currentGexScore: number) {
  const prompt = `
    You are a quantitative market risk verifier.
    News/Rumor: "${headline}"
    Current Dealer Gamma Risk Score: ${currentGexScore}/100.
    
    1. Cross-verify the rumor vs math reality.
    2. Provide a Truth Score (0-100%).
    3. Recommend whether hedging via Thetanuts Put options is mandatory.
    Return JSON format: { "truthScore": number, "reasoning": string, "shouldHedge": boolean, "strikeSuggestion": string }
  `;

  const response = await gonka.chat.completions.create({
    model: "MiniMaxAI/MiniMax-M2.7", // Agent-native model on Gonka
    max_tokens: 1024, // Leave headroom for reasoning tokens
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" }
  });

  return {
    data: JSON.parse(response.choices[0].message.content || "{}"),
    gonkaRequestId: response.id // Display this on the frontend for Gonka compliance
  };
}
```

---

### Phase 4: Thetanuts V4 SDK Live On-Chain Hedging (Days 3–4)

AI can recommend a hedge, but the trade panel refreshes the listed order, preflights it, and asks the user wallet to sign. No server-side signer is used.

---

### Phase 5: UI & Pitch Preparation (Days 4–5)

#### 1. Frontend Dashboard Deliverables
* **Market Fragility Gauge**: Circular meter displaying the 0–100% Risk Score (Dampener vs. Amplifier).
* **Gonka AI Fact-Checker Box**: Input box for viral panic headlines/tweets displaying:
  * Calculated Truth Score (0–100%)
  * AI Reasoning Trace
  * Gonka Request ID (Mandatory for Gonka track)
* **Hedge review**: AI recommendation followed by a user-reviewed, user-signed Thetanuts trade with a clickable Basescan TxHash link.

#### 2. Gonka & Thetanuts Best Practices Checklist
* [x] Set `max_tokens >= 1024` for reasoning models.
* [x] Copy exact Model IDs from `/models` (`deepseek-ai/DeepSeek-V4-Flash-0731`, `MiniMaxAI/MiniMax-M2.7`, `moonshotai/Kimi-K2.6`).
* [x] Implement exponential backoff for 429 rate limit responses.
* [x] Ensure on-chain transactions occur on Base Mainnet (Chain ID 8453) with real USDC.

---

### 🏆 Submission & Demo Checklist

| Deliverable | Requirement | Target Sponsor |
| :--- | :--- | :--- |
| **Working Live Demo** | Web Dashboard + Live Terminal | Both |
| **Real Mainnet Tx** | Live Option Trade on Base (`txHash`) | Thetanuts (Track 2) |
| **Gonka Integration** | Requests routed via `gonkarouter.io` + Request IDs shown | GonkaRouter |
| **Demo Video** | 2–3 Minute walkthrough video | Both |
| **Public GitHub Repo** | Documented code, setup steps, clean commit history | Both |

---

## 🔍 Module Implementation & Validation Matrix

*Status validation executed against current repository codebase:*

| Module / Component | Category | Status | Implementation Details / File References |
| :--- | :--- | :---: | :--- |
| **1. GEX & Risk Math Engine** | Phase 2 | **✅ Completed** | Implemented in `lib/engine.ts`. Computes Net GEX, Strike GEX, Gamma Flip Level, 5 Risk Factors (Gamma, Concentration, Expiry, Liquidity, IV), and 0–100 composite risk score. |
| **2. Thetanuts OptionBook Ingestion** | Phase 2 | **✅ Completed** | Implemented in `lib/snapshot.ts`. Fetches live orders and market data from Base Mainnet (Chain ID 8453) using `@thetanuts-finance/thetanuts-client`. |
| **3. Modeled Book & Black-Scholes Greeks** | Phase 2 | **✅ Completed** | Implemented in `lib/modelBook.ts`. Full Black-Scholes pricing and deterministic modeled books for non-native assets (SOL, XRP, BNB, AVAX). |
| **4. Market Fragility Gauge & Factor Breakdown** | Phase 5 | **✅ Completed** | Implemented in `components/ScorePanel.tsx`. Circular SVG meter, 0-100 score, regime verdicts (dampening / amplifying), factor progress bars, net GEX, and flip level. |
| **5. Interactive Whale Scenario Simulator** | Phase 2/5 | **✅ Completed** | Implemented in `lib/engine.ts` (`simulateWhale`) & `components/WhaleSim.tsx`. Square-root market impact model and dealer hedge feedback loop. |
| **6. GEX & Depth Visualizers** | Phase 5 | **✅ Completed** | Implemented in `components/GexChart.tsx`, `components/Heatmap.tsx`, `components/PriceChart.tsx`, `components/BookFeed.tsx`. |
| **7. Environment & Config Setup** | Phase 1 | **✅ Completed** | `.env` and `.env.example` configure GonkaRouter and Base RPC endpoints; trading keys remain in the user wallet. |
| **8. Thetanuts V4 SDK Live On-Chain Hedging** | Phase 4 | **✅ Completed** | The trade panel uses SDK-generated calldata for a fresh, preflighted, user-signed Base-mainnet OptionBook fill. |
| **9. GonkaRouter Multi-Model Verification Layer** | Phase 3 | **✅ Completed** | Implemented in `lib/gonka.ts` & `app/api/factcheck/route.ts` & `app/api/whatif/route.ts`. Native fetch client, `MiniMaxAI/MiniMax-M2.7` primary reasoning model with multi-model fallback, 429 exponential backoff, Truth Score (0–100%) computation, and Gonka Request ID output. |
| **10. Gonka AI Fact-Checker UI Box** | Phase 5 | **✅ Completed** | Implemented in `components/FactChecker.tsx` and integrated into `CopilotView.tsx` / `Dashboard.tsx`. Live rumor verification, Truth Score meter, urgency badge, quantitative reasoning trace, and Gonka Request ID display with one-click copy. |
| **11. Hedge review UI** | Phase 5 | **✅ Completed** | `components/ExecutionTerminal.tsx` and `components/HedgeView.tsx` route AI recommendations to the user-signed trade panel. |
| **12. Gonka Smoke Test Script** | Phase 1 | **✅ Completed** | Implemented in `scripts/smoke-test.mjs`. 30-second automated API connectivity and pong verification against `https://api.gonkarouter.io/v1`. |
| **13. "What-If" Conversational Copilot** | Phase 5 | **✅ Completed** | Implemented in `components/WhatIfChat.tsx`. Natural language trade scenario questioning powered by Gonka + deterministic `simulateWhale` feedback. |
| **14. Tabbed Multi-View UX Navigation** | Phase 5 | **✅ Completed** | Implemented in `components/TopBar.tsx`, `components/Dashboard.tsx`, `components/CopilotView.tsx`, and `components/HedgeView.tsx`. |

---

## 📋 Current Progress & Action Items

- [x] **Compile Technical Roadmap & Architecture Plan** (`ROADMAP.md`)
- [x] **Perform Codebase Audit & Module Validation**
- [x] **Create `.env` & `.env.example`** with GonkaRouter API Key and Base RPC variables
- [x] **Build GonkaRouter API Service** (`lib/gonka.ts` & `/api/factcheck/route.ts`)
- [x] **Build Frontend Gonka Fact-Checker Box Component** (`components/FactChecker.tsx`)
- [x] **Build "What-If" Conversational Scenario Copilot** (`components/WhatIfChat.tsx` & `/api/whatif/route.ts`)
- [x] **Build user-signed live hedge flow** (`components/TradePanel.tsx` & `/api/quote/route.ts`)
- [x] **Build Autonomous Execution Terminal Component** (`components/ExecutionTerminal.tsx`)
- [x] **Build Multi-View Tab Navigation** (`components/TopBar.tsx`, `components/CopilotView.tsx`, `components/HedgeView.tsx`, `components/Dashboard.tsx`)
- [x] **Create Gonka Smoke Test Script** (`scripts/smoke-test.mjs`)
- [x] **Verify End-to-End Type Safety & Live API Routes**
