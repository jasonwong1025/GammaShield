// What to do with a position you already hold: hold it, hedge it, sell it, or
// roll it — decided by the same engine the autonomous agent uses.
//
// There is deliberately no second decision engine here. `lib/autonomous/
// decision.ts` answers this question for the worker every cycle, and this route
// asks it the same way for one position on demand, so the panel and the agent
// can never tell the user different things about the same position.
//
// Two differences from the agent path, both deliberate:
//
//   1. Availability is ADVISORY. The agent gates the engine on what its
//      deployment can execute, which would make a mainnet close unpickable and
//      leave the panel silently unable to ever suggest selling. Here the engine
//      answers on merit and executability is reported separately, per action,
//      priced at the market maker's live bid.
//   2. Nothing is executed and nothing is signed. The response is a reading.
//      The one thing the panel can persist is the user's VIEW, through the
//      owner-signed thesis store — never the verdict, which has to be
//      re-derived from live risk on every cycle.

import { ethers } from "ethers";
import { isAddress } from "viem";
import { mandateAccountAbi } from "@/lib/generated/contracts";
import { getMarketSnapshot } from "@/lib/snapshot";
import { getPositionMark } from "@/lib/positions";
import { getShadowBookVersion, getShadowPositions } from "@/lib/shadow";
import { decide, type ManagedPosition } from "@/lib/autonomous/decision";
import { computePositionRisk, HELD_POSITION_DROPS } from "@/lib/autonomous/positionRisk";
import { riskTrendFrom, describeTrend } from "@/lib/autonomous/trend";
import { evaluateThesis, readThesisRecord, targetReached, thesisFor } from "@/lib/autonomous/thesis";
import { narrateDecision } from "@/lib/autonomous/narrative";
import {
  NO_BUDGET,
  advisoryAvailability,
  agentActionAvailability,
  isActionArmed,
  type AgentAction,
  type AgentLimits,
  type NetworkKind,
} from "@/lib/autonomous/policy";
import { ALL_ASSETS, isOptionsAsset, type Asset, type OptionsAsset } from "@/lib/assets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  network?: unknown;
  positionId?: unknown;
  asset?: unknown;
  isCall?: unknown;
  strike?: unknown;
  expiryTs?: unknown;
  contracts?: unknown;
  custody?: unknown;
  policyAccount?: unknown;
  walletAddress?: unknown;
};

export async function POST(request: Request) {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const network: NetworkKind | null = body.network === "mainnet" || body.network === "sepolia" ? body.network : null;
  const asset =
    ALL_ASSETS.includes(body.asset as Asset) && isOptionsAsset(body.asset as Asset) ? (body.asset as OptionsAsset) : null;
  const strike = num(body.strike);
  const expiryTs = num(body.expiryTs);
  const contracts = num(body.contracts);
  const positionId = typeof body.positionId === "string" || typeof body.positionId === "number" ? String(body.positionId) : null;
  const custody = body.custody === "policy" ? "policy" : "wallet";
  const policyAccount = typeof body.policyAccount === "string" && isAddress(body.policyAccount) ? body.policyAccount : null;
  const walletAddress = typeof body.walletAddress === "string" && isAddress(body.walletAddress) ? body.walletAddress : null;

  if (!network || !asset || !positionId || strike === null || expiryTs === null || contracts === null) {
    return Response.json({ error: "network, asset, positionId, strike, expiryTs and contracts are required" }, { status: 400 });
  }
  if (typeof body.isCall !== "boolean") {
    return Response.json({ error: "isCall is required" }, { status: 400 });
  }

  try {
    const snapshot = await getMarketSnapshot();
    const book = snapshot.assets[asset];
    const spot = snapshot.prices[asset];
    const nowSec = Math.floor(Date.now() / 1000);

    // The exit price. Mainnet quotes any ticker through the market maker;
    // the Sepolia shadow book carries its own modelled mark per receipt.
    // The shadow book indexes receipts by buyer, and a receipt can sit with
    // either the wallet or the policy account, so both are offered.
    const holders: string[] = [policyAccount, walletAddress].filter((value) => value !== null);
    const mark = await markFor(network, holders, { id: positionId, asset, isCall: body.isCall, strike, expiryTs, contracts });

    const position: ManagedPosition = {
      id: positionId,
      asset,
      isCall: body.isCall,
      strike,
      expiryTs,
      contracts,
      entryPremiumUsd: mark.entryPremiumUsd,
      markUsd: mark.bidUsd,
      askUsd: mark.askUsd,
      pnlUsd: mark.pnlUsd,
      // Cover is something the agent bought to offset a risk; anything the
      // user opened themselves is their own directional exposure, and a
      // calmer book is not on its own a reason to abandon it.
      role: custody === "policy" ? "cover" : "directional",
    };

    const risk = computePositionRisk({ position, spot, nowSec, marketScore: book.score, contractDepthUsd: book.depthUsd });

    // The recorded view, and the observation history behind the trend, both
    // live with the policy account. A position held in a plain wallet has
    // neither, and the engine is told so rather than given a neutral default.
    const record = policyAccount ? await readThesisRecord(network, policyAccount).catch(() => null) : null;
    const thesis = record ? thesisFor(record, positionId) : null;
    const samples = policyAccount ? await readRiskHistory(network, policyAccount) : [];
    const trend = riskTrendFrom(samples, "position", nowSec);

    // What the agent could actually execute here, kept apart from what the
    // engine is allowed to consider. See advisoryAvailability's comment.
    const limits: AgentLimits = { asset, maxLossUsd: 0, maxTradeNotionalUsd: 0, actions: { hedge: true, close: true, roll: true } };
    const shadowVersion = network === "sepolia" ? await getShadowBookVersion().catch(() => 1) : null;
    const executable = agentActionAvailability(limits, network, shadowVersion);

    const decision = decide({
      position,
      bookRiskScore: book.score,
      bookThreshold: 75,
      bookPersistenceMet: true,
      positionRiskScore: risk?.score ?? null,
      positionThreshold: 70,
      trend,
      thesis: evaluateThesis(thesis, spot, nowSec),
      objective: thesis?.objective ?? null,
      targetReached: targetReached(thesis, spot),
      availability: advisoryAvailability(),
      // Advisory read: no signed mandate binds a position the user opened, so
      // no size or budget limit is imposed on the reasoning.
      maxContracts: contracts,
      quotedPremiumUsd: mark.askUsd,
      lossBudgetUsd: NO_BUDGET,
      spentPremiumUsd: 0,
      executable: isActionArmed(executable, "close"),
      nowSec,
    });

    const chosen = decision.action.toLowerCase();
    const canExecute = chosen === "hold" ? true : isActionArmed(executable, chosen as AgentAction);
    const blocker = executable.find((entry) => entry.action === chosen && !entry.available)?.reason ?? null;

    const narrative = await narrateDecision({
      asset,
      isCall: body.isCall,
      strike,
      spot,
      contracts,
      daysToExpiry: (expiryTs - nowSec) / 86_400,
      exitValueUsd: mark.bidUsd === null ? null : mark.bidUsd * contracts,
      positionRiskScore: risk?.score ?? null,
      bookRiskScore: book.score,
      thesis,
      decision,
      executable: canExecute,
    }).catch(() => null);

    return Response.json(
      {
        decision,
        narrative,
        canExecute,
        blocker,
        exitValueUsd: mark.bidUsd === null ? null : round2(mark.bidUsd * contracts),
        markPerContractUsd: mark.bidUsd,
        risk: risk && {
          score: risk.score,
          level: risk.level,
          components: risk.components.map((component) => ({
            key: component.key,
            label: component.label,
            score: component.score,
            weight: component.weight,
          })),
          dropped: risk.dropped,
        },
        heldPositionDrops: HELD_POSITION_DROPS,
        trend: { ...trend, described: describeTrend(trend) },
        thesis,
        thesisSource: thesis ? (record?.positions[positionId] ? "position" : "standing") : null,
        spot,
        bookRiskScore: book.score,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "position strategy failed";
    return Response.json({ error: message }, { status: 502 });
  }
}

type Mark = { bidUsd: number | null; askUsd: number | null; entryPremiumUsd: number | null; pnlUsd: number | null };

async function markFor(
  network: NetworkKind,
  holders: string[],
  position: { id: string; asset: OptionsAsset; isCall: boolean; strike: number; expiryTs: number; contracts: number },
): Promise<Mark> {
  if (network === "mainnet") {
    const quote = await getPositionMark({
      id: position.id,
      asset: position.asset,
      isCall: position.isCall,
      strike: position.strike,
      expiryTs: position.expiryTs,
      contracts: position.contracts,
      status: "open",
      entryTxHash: null,
      pnlUsd: null,
    }).catch(() => ({ bidUsd: null, askUsd: null, markUsd: null }));
    return { bidUsd: quote.bidUsd ?? quote.markUsd, askUsd: quote.askUsd, entryPremiumUsd: null, pnlUsd: null };
  }

  // The shadow book prices its own receipts; there is no separate maker quote.
  // It looks receipts up by buyer, so with no holder there is nothing to
  // price — reported as unpriced rather than as worthless.
  if (!holders.length) return { bidUsd: null, askUsd: null, entryPremiumUsd: null, pnlUsd: null };
  const receipts = await getShadowPositions(holders).catch(() => []);
  const receipt = receipts.find((entry) => String(entry.id) === position.id) ?? null;
  const perContract = receipt?.mark && receipt.contracts > 0 ? receipt.mark.valueUsd / receipt.contracts : null;
  return {
    bidUsd: perContract,
    askUsd: null,
    entryPremiumUsd: receipt && receipt.contracts > 0 ? receipt.premiumUsd / receipt.contracts : null,
    pnlUsd: receipt?.mark?.pnlUsd ?? null,
  };
}

/** The account's retained observations, which are the only durable source for
 *  a risk trend. Unreachable or unregistered simply means no trend, which the
 *  engine reports as insufficient history rather than as a flat one. */
async function readRiskHistory(network: NetworkKind, account: string) {
  try {
    const rpcUrl = network === "mainnet" ? process.env.BASE_RPC_URL : process.env.BASE_SEPOLIA_RPC_URL;
    if (!rpcUrl) return [];
    const provider = new ethers.JsonRpcProvider(rpcUrl, network === "mainnet" ? 8453 : 84532, { staticNetwork: true });
    const contract = new ethers.Contract(account, mandateAccountAbi, provider);
    const hash: string = await contract.activeMandateHash();
    if (!hash || hash === ethers.ZeroHash) return [];
    const raw: { observedAt: bigint; bookScoreBps: number; positionScoreBps: number }[] = await contract.getRiskHistory(hash);
    return raw.map((sample) => ({
      observedAt: Number(sample.observedAt),
      bookScoreBps: Number(sample.bookScoreBps),
      positionScoreBps: Number(sample.positionScoreBps),
    }));
  } catch {
    return [];
  }
}

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
const round2 = (value: number) => Math.round(value * 100) / 100;
