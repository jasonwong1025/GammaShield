// Base Sepolia shadow execution. Quotes mirror a live Base-mainnet Thetanuts
// read, but the signed fill is only valid for GammaShield's test contract.

import { ethers } from "ethers";
import { isOptionsAsset, type OptionsAsset } from "@/lib/assets";
import { getTradeQuote, type TradeQuote, type TradeSide } from "@/lib/trade";
import { TRADE_PERIODS, type TradePeriod } from "@/lib/tradePeriods";

const QUOTE_LIFETIME_SECONDS = 60;
const MAX_CONTRACTS = 5;

const BOOK_ABI = [
  "function fillShadow((bytes32 fillId,bytes32 sourceHash,bytes32 asset,address buyer,bool isCall,uint128 strikeE8,uint64 expiry,uint64 validUntil,uint128 contractsE6,uint128 premiumUsdc) quote,bytes signature)",
] as const;
const ERC20_ABI = [
  "function approve(address spender,uint256 amount) returns (bool)",
] as const;

const quoteTypes = {
  ShadowQuote: [
    { name: "fillId", type: "bytes32" },
    { name: "sourceHash", type: "bytes32" },
    { name: "asset", type: "bytes32" },
    { name: "buyer", type: "address" },
    { name: "isCall", type: "bool" },
    { name: "strikeE8", type: "uint128" },
    { name: "expiry", type: "uint64" },
    { name: "validUntil", type: "uint64" },
    { name: "contractsE6", type: "uint128" },
    { name: "premiumUsdc", type: "uint128" },
  ],
};

type ContractConfig = { optionBook: string; usdc: string };

export type ShadowQuote = {
  environment: "base-sepolia-shadow";
  source: {
    network: "Base mainnet";
    capturedAt: number;
    liquidity: TradeQuote["source"];
    asset: OptionsAsset;
    side: TradeSide;
    strike: number;
    expiryTs: number;
    contracts: number;
    premiumUsd: number;
    sourceHash: string;
  };
  validUntil: number;
  txs: {
    approve: { to: string; data: string };
    fill: { to: string; data: string };
  };
};

function contracts(): ContractConfig {
  const optionBook = process.env.SHADOW_OPTION_BOOK_ADDRESS;
  const usdc = process.env.SHADOW_USDC_ADDRESS;
  if (!optionBook || !usdc || !ethers.isAddress(optionBook) || !ethers.isAddress(usdc)) {
    throw new Error("Base Sepolia shadow contracts are not configured");
  }
  return { optionBook: ethers.getAddress(optionBook), usdc: ethers.getAddress(usdc) };
}

function chainId() {
  const value = process.env.SHADOW_CHAIN_ID;
  if (!value || !/^\d+$/.test(value)) throw new Error("SHADOW_CHAIN_ID is not configured");
  return Number(value);
}

function signer() {
  const key = process.env.SHADOW_QUOTE_SIGNER_PRIVATE_KEY;
  if (!key) throw new Error("SHADOW_QUOTE_SIGNER_PRIVATE_KEY is not configured");
  return new ethers.Wallet(key.startsWith("0x") ? key : `0x${key}`);
}

function validContracts(value: number): number {
  if (!Number.isFinite(value) || value < 0.001 || value > MAX_CONTRACTS || Math.round(value * 1e6) !== value * 1e6) {
    throw new Error(`contracts must be from 0.001 to ${MAX_CONTRACTS} with up to 6 decimal places`);
  }
  return value;
}

function validPeriod(value: number): TradePeriod {
  if (!TRADE_PERIODS.includes(value as TradePeriod)) throw new Error("unsupported expiry period");
  return value as TradePeriod;
}

export async function getShadowQuote(
  asset: string,
  buyer: string,
  side: TradeSide,
  count = 1,
  period: number = 7,
): Promise<ShadowQuote> {
  if (!isOptionsAsset(asset as OptionsAsset)) throw new Error("only BTC and ETH have a live Thetanuts book");
  if (!ethers.isAddress(buyer)) throw new Error("invalid buyer address");

  const contractsCount = validContracts(count);
  const option = await getTradeQuote(asset as OptionsAsset, side, contractsCount, validPeriod(period));
  if (option.contracts <= 0 || option.totalCostUsd <= 0) throw new Error("no fillable shadow quote is available");

  const config = contracts();
  const now = Math.floor(Date.now() / 1000);
  const premiumUsdc = ethers.parseUnits(option.totalCostUsd.toFixed(6), 6);
  const approvalUsdc = (premiumUsdc * 101n + 99n) / 100n;
  const sourceHash = ethers.keccak256(
    ethers.toUtf8Bytes([
      "thetanuts-base-mainnet",
      asset,
      side,
      option.source,
      option.strike,
      option.expiryTs,
      option.contracts,
      option.totalCostUsd.toFixed(6),
      now,
    ].join("|")),
  );
  const quote = {
    fillId: ethers.keccak256(ethers.toUtf8Bytes(`${sourceHash}|${buyer.toLowerCase()}|${now}`)),
    sourceHash,
    asset: ethers.encodeBytes32String(asset),
    buyer: ethers.getAddress(buyer),
    isCall: side === "call",
    strikeE8: BigInt(Math.round(option.strike * 1e8)),
    expiry: BigInt(option.expiryTs),
    validUntil: BigInt(now + QUOTE_LIFETIME_SECONDS),
    contractsE6: BigInt(Math.round(option.contracts * 1e6)),
    premiumUsdc,
  };
  const signature = await signer().signTypedData(
    { name: "GammaShield Shadow OptionBook", version: "1", chainId: chainId(), verifyingContract: config.optionBook },
    quoteTypes,
    quote,
  );
  const book = new ethers.Interface(BOOK_ABI);
  const token = new ethers.Interface(ERC20_ABI);

  return {
    environment: "base-sepolia-shadow",
    source: {
      network: "Base mainnet",
      capturedAt: now,
      liquidity: option.source,
      asset: asset as OptionsAsset,
      side,
      strike: option.strike,
      expiryTs: option.expiryTs,
      contracts: option.contracts,
      premiumUsd: option.totalCostUsd,
      sourceHash,
    },
    validUntil: Number(quote.validUntil),
    txs: {
      approve: { to: config.usdc, data: token.encodeFunctionData("approve", [config.optionBook, approvalUsdc]) },
      fill: { to: config.optionBook, data: book.encodeFunctionData("fillShadow", [quote, signature]) },
    },
  };
}
