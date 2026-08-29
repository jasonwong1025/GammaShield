// Server-side RFQ (OptionFactory) support — the path that makes the standard
// 7/14/28d periods tradable when no listed maker order exists at that expiry.
// Flow:
//   1. prepareRfq  → approve + calldata for the user's wallet to submit a
//      sealed-bid request-for-quotation at their exact strike/expiry (buy
//      side). Despite the SDK docs saying "collateralAmount = 0 at creation,
//      pulled at settlement," requestForQuotation immediately escrows
//      reservePrice × contracts of the collateral token from the requester
//      (verified against a mainnet fork — it reverts with ERC20 "transfer
//      amount exceeds allowance" without a prior approve). So BUY-side RFQs
//      need the same approve-then-send flow as an OptionBook fill.
//   2. rfqStatus   → poll the requester's latest RFQ; decrypt maker offers
//      with OUR server-held ECDH key (the key only unlocks offer prices, it
//      controls no funds — the wallet remains the requester on-chain).
//   3. prepareSettle → approve + settleQuotationEarly calldata to accept the
//      best offer; premium is pulled from the buyer at settlement.
// Calls use USDC-collateral pricing? No — matching the protocol: vanilla RFQ
// calls are INVERSE_CALL (WETH/cbBTC collateral, premium in the underlying),
// puts are USDC. Reserve price caps what makers may charge.

import { getClient } from "./snapshot";
import { getTradeQuote, type TradePeriod, type TradeSide } from "./trade";
import { isOptionsAsset, type Asset } from "./assets";

const OFFER_DEADLINE_MINUTES = 15;
const RESERVE_BUFFER = 1.15; // cap makers at ~15% over the interpolated MM ask

export type RfqPrepared = {
  tx: { chainId: string; to: string; data: string };
  /** Escrows reservePrice × contracts of the collateral token to the OptionFactory — send before `tx`. */
  approve: { to: string; data: string };
  strike: number;
  expiryTs: number;
  contracts: number;
  collateralToken: string;
  /** Interpolated MM estimate, per contract, USD — what the auction should beat. */
  estPremiumUsd: number;
  reservePerContract: number;
  offerDeadlineTs: number;
};

export type RfqOfferView = {
  offeror: string;
  totalPremiumToken: number;
  totalPremiumUsd: number;
  perContractUsd: number;
};

export type RfqStatus = {
  id: string;
  status: string; // active | settled | cancelled
  strike: number;
  expiryTs: number;
  offerEndTs: number;
  contracts: number;
  collateralToken: string;
  offersCount: number;
  best: RfqOfferView | null;
  optionAddress: string | null;
};

function collateralFor(asset: Asset, side: TradeSide): "USDC" | "WETH" | "cbBTC" {
  if (side === "put") return "USDC";
  return asset === "ETH" ? "WETH" : "cbBTC";
}

export async function prepareRfq(
  asset: Asset,
  side: TradeSide,
  contracts: number,
  period: TradePeriod,
  address: string,
): Promise<RfqPrepared> {
  if (!isOptionsAsset(asset)) throw new Error(`${asset} has no live Thetanuts market`);
  if (!(contracts > 0)) throw new Error("contracts must be positive");

  const c = getClient();
  // Reuse the trade quote: ATM strike + MM ask at the real grid tenor for
  // this period — expiryTs here MUST match the quote's, since the reserve
  // price and strike were computed against that exact expiry.
  const quote = await getTradeQuote(asset, side, contracts, period);
  const nowSec = Math.floor(Date.now() / 1000);
  const expiryTs = quote.expiryTs;

  const collateralToken = collateralFor(asset, side);
  // Reserve price is per contract in COLLATERAL token units: USD(C) for puts,
  // the underlying for inverse calls (matching MM ask units).
  const reservePerContract =
    (side === "put" ? quote.premiumPerContractUsd : quote.premiumPerContractUsd / quote.spot) *
    RESERVE_BUFFER;

  const keyPair = await c.rfqKeys.getOrCreateKeyPair();
  const request = c.optionFactory.buildRFQRequest({
    requester: address as `0x${string}`,
    underlying: asset,
    optionType: side === "call" ? "CALL" : "PUT",
    strikes: quote.strike,
    expiry: expiryTs,
    numContracts: contracts,
    isLong: true, // buying
    offerDeadlineMinutes: OFFER_DEADLINE_MINUTES,
    collateralToken,
    reservePrice: reservePerContract,
    requesterPublicKey: keyPair.compressedPublicKey,
  });
  const { to, data } = c.optionFactory.encodeRequestForQuotation(request);

  // Escrowed at request time: reservePrice × contracts, in the collateral
  // token's native decimals. +1% headroom for rounding, matching the
  // OptionBook approve pattern in lib/trade.ts.
  const token = c.chainConfig.tokens[collateralToken];
  const escrowAmount = BigInt(Math.ceil(reservePerContract * contracts * 10 ** token.decimals));
  const approveAmount = (escrowAmount * 101n) / 100n;
  const approve = c.erc20.encodeApprove(token.address, c.optionFactory.contractAddress, approveAmount);

  return {
    tx: { chainId: "0x2105", to, data },
    approve: { to: approve.to, data: approve.data },
    strike: quote.strike,
    expiryTs,
    contracts,
    collateralToken,
    estPremiumUsd: quote.premiumPerContractUsd,
    reservePerContract,
    offerDeadlineTs: nowSec + OFFER_DEADLINE_MINUTES * 60,
  };
}

function tokenMeta(c: ReturnType<typeof getClient>, address: string) {
  return Object.values(c.chainConfig.tokens).find(
    (t) => t.address.toLowerCase() === address.toLowerCase(),
  );
}

async function latestRfqFor(address: string) {
  const c = getClient();
  const rfqs = await c.api.getFactoryRfqs();
  const list = (Array.isArray(rfqs) ? rfqs : []).filter(
    (r) => r.requester?.toLowerCase() === address.toLowerCase(),
  );
  if (!list.length) return null;
  return list.sort((a, b) => Number(b.id) - Number(a.id))[0];
}

export async function rfqStatus(address: string, spotPrices: Record<string, number>): Promise<RfqStatus | null> {
  const c = getClient();
  const latest = await latestRfqFor(address);
  if (!latest) return null;
  // getRfq includes the offers map (list endpoints don't).
  const rfq = await c.api.getRfq(latest.id);

  const token = tokenMeta(c, rfq.collateral);
  const decimals = token?.decimals ?? 6;
  const symbol = token?.symbol ?? "?";
  const tokenUsd = symbol.includes("USD")
    ? 1
    : symbol.includes("ETH")
      ? (spotPrices.ETH ?? 0)
      : symbol.includes("BTC")
        ? (spotPrices.BTC ?? 0)
        : 1;
  const contracts = Number(rfq.numContracts) / 10 ** decimals;

  const offers = Object.values(rfq.offers ?? {});
  let best: RfqOfferView | null = null;
  for (const offer of offers) {
    try {
      const { offerAmount } = await c.rfqKeys.decryptOffer(
        offer.signedOfferForRequester,
        offer.signingKey,
      );
      const totalPremiumToken = Number(offerAmount) / 10 ** decimals;
      const totalPremiumUsd = totalPremiumToken * tokenUsd;
      if (!best || totalPremiumToken < best.totalPremiumToken) {
        best = {
          offeror: offer.offeror,
          totalPremiumToken,
          totalPremiumUsd,
          perContractUsd: contracts > 0 ? totalPremiumUsd / contracts : totalPremiumUsd,
        };
      }
    } catch {
      // Offer encrypted to a different key (e.g. made before our key) — skip.
    }
  }

  return {
    id: rfq.id,
    status: rfq.status,
    strike: Number(rfq.strikes?.[0] ?? 0) / 1e8,
    expiryTs: rfq.expiryTimestamp,
    offerEndTs: rfq.offerEndTimestamp,
    contracts,
    collateralToken: symbol,
    offersCount: offers.length,
    best,
    optionAddress: rfq.optionAddress ?? null,
  };
}

export async function prepareSettle(address: string, quotationId: string, offeror: string) {
  const c = getClient();
  const rfq = await c.api.getRfq(quotationId);
  if (rfq.requester.toLowerCase() !== address.toLowerCase()) {
    throw new Error("only the requester can settle this RFQ");
  }
  const offer = Object.values(rfq.offers ?? {}).find(
    (o) => o.offeror.toLowerCase() === offeror.toLowerCase(),
  );
  if (!offer) throw new Error("offer not found on this RFQ");

  const { offerAmount, nonce } = await c.rfqKeys.decryptOffer(
    offer.signedOfferForRequester,
    offer.signingKey,
  );
  const settle = c.optionFactory.encodeSettleQuotationEarly(
    BigInt(quotationId),
    offerAmount,
    nonce,
    offeror,
  );
  // Premium is pulled from the buyer at settlement — approve with 1% headroom.
  const approveAmount = (offerAmount * 101n) / 100n;
  const approve = c.erc20.encodeApprove(rfq.collateral, settle.to, approveAmount);

  return {
    chainId: "0x2105",
    approve,
    settle,
    totalPremium: offerAmount.toString(),
  };
}
