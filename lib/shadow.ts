// Base Sepolia shadow execution. Quotes mirror a live Base-mainnet Thetanuts
// read, but the signed fill is only valid for GammaShield's test contract.

import { ethers } from "ethers";
import { isOptionsAsset, type OptionsAsset } from "@/lib/assets";
import { getTradeQuote, type TradeQuote, type TradeSide } from "@/lib/trade";
import { TRADE_PERIODS, type TradePeriod } from "@/lib/tradePeriods";
import { bsOptionPrice } from "@/lib/modelBook";
import { getMarketSnapshot, type MarketSnapshot } from "@/lib/snapshot";

const QUOTE_LIFETIME_SECONDS = 60;
const MAX_CONTRACTS = 5;

const BOOK_ABI = [
  "function fillShadow((bytes32 fillId,bytes32 sourceHash,bytes32 asset,address buyer,bool isCall,uint128 strikeE8,uint64 expiry,uint64 validUntil,uint128 contractsE6,uint128 premiumUsdc) quote,bytes signature)",
  "function nextPositionId() view returns (uint256)",
  "function positions(uint256) view returns (bytes32 sourceHash,bytes32 asset,address buyer,bool isCall,uint128 strikeE8,uint64 expiry,uint128 contractsE6,uint128 premiumUsdc)",
  "event ShadowOrderFilled(uint256 indexed positionId,bytes32 indexed fillId,bytes32 indexed sourceHash,address buyer,bytes32 asset,bool isCall,uint128 strikeE8,uint64 expiry,uint128 contractsE6,uint128 premiumUsdc)",
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

export type ShadowPosition = {
  id: number;
  asset: OptionsAsset;
  isCall: boolean;
  strike: number;
  expiryTs: number;
  contracts: number;
  premiumUsd: number;
  txHash: string | null;
  mark: {
    valueUsd: number;
    pnlUsd: number;
    source: "nearest listed IV" | "book-average IV" | "current intrinsic value";
  } | null;
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

function rpcUrl() {
  const value = process.env.BASE_SEPOLIA_RPC_URL;
  if (!value) throw new Error("Base Sepolia RPC is not configured");
  return value;
}

function deploymentBlock() {
  const value = process.env.SHADOW_DEPLOYMENT_BLOCK;
  if (!value || !/^\d+$/.test(value)) throw new Error("SHADOW_DEPLOYMENT_BLOCK is not configured");
  return Number(value);
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
      // The signed quote fixes `premiumUsdc`; approve only that exact amount.
      approve: { to: config.usdc, data: token.encodeFunctionData("approve", [config.optionBook, premiumUsdc]) },
      fill: { to: config.optionBook, data: book.encodeFunctionData("fillShadow", [quote, signature]) },
    },
  };
}

export async function getShadowPositions(buyer: string): Promise<ShadowPosition[]> {
  if (!ethers.isAddress(buyer)) throw new Error("invalid buyer address");
  const config = contracts();
  const provider = new ethers.JsonRpcProvider(rpcUrl());
  const book = new ethers.Contract(config.optionBook, BOOK_ABI, provider);
  const count = Number(await book.nextPositionId());
  // ponytail: scans this small hackathon receipt book; add indexed buyer IDs when it becomes a shared venue.
  const entries = await Promise.all(Array.from({ length: count }, (_, id) => book.positions(id)));
  const event = book.interface.getEvent("ShadowOrderFilled");
  if (!event) throw new Error("Shadow fill event is unavailable");
  const latest = await provider.getBlockNumber();
  const txHashes = new Map<number, string>();
  for (let fromBlock = deploymentBlock(); fromBlock <= latest; fromBlock += 10_000) {
    const logs = await provider.getLogs({
      address: config.optionBook,
      topics: [event.topicHash],
      fromBlock,
      toBlock: Math.min(fromBlock + 9_999, latest),
    });
    for (const log of logs) txHashes.set(Number(BigInt(log.topics[1])), log.transactionHash);
  }
  const positions = entries.flatMap((entry, id) => {
    if (entry.buyer.toLowerCase() !== buyer.toLowerCase()) return [];
    const asset = ethers.decodeBytes32String(entry.asset) as OptionsAsset;
    return [{
      id,
      asset,
      isCall: entry.isCall,
      strike: Number(entry.strikeE8) / 1e8,
      expiryTs: Number(entry.expiry),
      contracts: Number(entry.contractsE6) / 1e6,
      premiumUsd: Number(entry.premiumUsdc) / 1e6,
      txHash: txHashes.get(id) ?? null,
      mark: null,
    }];
  });
  if (!positions.length) return positions;

  const snapshot = await getMarketSnapshot().catch(() => null);
  return snapshot ? positions.map((position) => ({ ...position, mark: markPosition(position, snapshot) })) : positions;
}

function markPosition(position: ShadowPosition, snapshot: MarketSnapshot): ShadowPosition["mark"] {
  const spot = snapshot.prices[position.asset];
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(spot) || spot <= 0) return null;
  if (position.expiryTs <= now) {
    const valueUsd = Math.max(position.isCall ? spot - position.strike : position.strike - spot, 0) * position.contracts;
    return { valueUsd, pnlUsd: valueUsd - position.premiumUsd, source: "current intrinsic value" };
  }

  const candidates = snapshot.feed.filter((row) => row.asset === position.asset && row.isCall === position.isCall && row.iv != null);
  const nearest = candidates.reduce<typeof candidates[number] | null>(
    (best, row) => !best || Math.abs(row.expiryTs - position.expiryTs) + Math.abs(row.strike - position.strike) < Math.abs(best.expiryTs - position.expiryTs) + Math.abs(best.strike - position.strike) ? row : best,
    null,
  );
  const iv = nearest?.iv ?? snapshot.assets[position.asset].avgIv;
  if (iv == null || iv <= 0) return null;
  const valueUsd = bsOptionPrice(spot, position.strike, iv, (position.expiryTs - now) / (365 * 86400), position.isCall) * position.contracts;
  return { valueUsd, pnlUsd: valueUsd - position.premiumUsd, source: nearest ? "nearest listed IV" : "book-average IV" };
}
