import { hexToString, isAddress, stringToHex, zeroAddress, type Address, type Hex, type TypedDataDomain } from "viem";
import type { OptionsAsset } from "./assets.ts";
import type { TradeSide } from "./trade.ts";

/** Immutable terms the user signs before an agent may execute a fill. */
export type Mandate = {
  owner: Address;
  account: Address;
  agent: Address;
  optionBook: Address;
  collateral: Address;
  asset: OptionsAsset;
  side: TradeSide;
  maxPremiumPerFill: bigint;
  maxPremiumTotal: bigint;
  maxContractsPerFill: bigint;
  minTenorSeconds: number;
  maxTenorSeconds: number;
  riskThresholdBps: number;
  /** Trigger for the PER-CONTRACT risk of a held position, which arms close
   *  and roll. `riskThresholdBps` above arms a hedge from the book score. */
  positionRiskThresholdBps: number;
  persistenceSeconds: number;
  minExecutionIntervalSeconds: number;
  validAfter: number;
  expiresAt: number;
  nonce: bigint;
};

/** Mutable, on-chain policy state. `spentPremium` is in the mandate collateral's native units. */
export type MandateControl = {
  paused: boolean;
  revoked: boolean;
  spentPremium: bigint;
};

export type MandateStatus = "pending" | "active" | "paused" | "revoked" | "expired" | "exhausted";
export type MandateAction = "execute" | "pause" | "resume" | "revoke";

export const MANDATE_EIP712_TYPES = {
  Mandate: [
    { name: "owner", type: "address" },
    { name: "account", type: "address" },
    { name: "agent", type: "address" },
    { name: "optionBook", type: "address" },
    { name: "collateral", type: "address" },
    { name: "asset", type: "bytes32" },
    { name: "side", type: "uint8" },
    { name: "maxPremiumPerFill", type: "uint256" },
    { name: "maxPremiumTotal", type: "uint256" },
    { name: "maxContractsPerFill", type: "uint256" },
    { name: "minTenorSeconds", type: "uint64" },
    { name: "maxTenorSeconds", type: "uint64" },
    { name: "riskThresholdBps", type: "uint16" },
    { name: "positionRiskThresholdBps", type: "uint16" },
    { name: "persistenceSeconds", type: "uint64" },
    { name: "minExecutionIntervalSeconds", type: "uint64" },
    { name: "validAfter", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export function mandateDomain(chainId: number, policyContract: Address): TypedDataDomain {
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !isContractAddress(policyContract)) {
    throw new Error("invalid mandate domain");
  }
  return { name: "GammaShield Mandate", version: "1", chainId, verifyingContract: policyContract };
}

export function mandateMessage(mandate: Mandate) {
  assertValidMandate(mandate);
  return {
    ...mandate,
    asset: stringToHex(mandate.asset, { size: 32 }),
    side: mandate.side === "call" ? 0 : 1,
    minTenorSeconds: BigInt(mandate.minTenorSeconds),
    maxTenorSeconds: BigInt(mandate.maxTenorSeconds),
    riskThresholdBps: mandate.riskThresholdBps,
    positionRiskThresholdBps: mandate.positionRiskThresholdBps,
    persistenceSeconds: BigInt(mandate.persistenceSeconds),
    minExecutionIntervalSeconds: BigInt(mandate.minExecutionIntervalSeconds),
    validAfter: BigInt(mandate.validAfter),
    expiresAt: BigInt(mandate.expiresAt),
  };
}

export function mandateStatus(mandate: Mandate, control: MandateControl, now: number): MandateStatus {
  assertValidMandate(mandate);
  if (!Number.isSafeInteger(now) || now < 0 || typeof control.spentPremium !== "bigint" || control.spentPremium < 0n) {
    throw new Error("invalid mandate state");
  }
  if (control.revoked) return "revoked";
  if (now >= mandate.expiresAt) return "expired";
  if (now < mandate.validAfter) return "pending";
  if (control.spentPremium >= mandate.maxPremiumTotal) return "exhausted";
  return control.paused ? "paused" : "active";
}

export function canApplyMandateAction(status: MandateStatus, action: MandateAction): boolean {
  if (action === "execute") return status === "active";
  if (action === "pause") return status === "active";
  if (action === "resume") return status === "paused";
  return status === "pending" || status === "active" || status === "paused";
}

export function assertValidMandate(mandate: Mandate): void {
  if (![mandate.owner, mandate.account, mandate.agent, mandate.optionBook, mandate.collateral].every(isContractAddress)) {
    throw new Error("mandate contains an invalid address");
  }
  if (
    mandate.maxPremiumPerFill <= 0n ||
    mandate.maxPremiumTotal < mandate.maxPremiumPerFill ||
    mandate.maxContractsPerFill <= 0n ||
    mandate.nonce < 0n
  ) {
    throw new Error("mandate contains an invalid cap");
  }
  if (
    ![mandate.minTenorSeconds, mandate.maxTenorSeconds, mandate.persistenceSeconds, mandate.minExecutionIntervalSeconds, mandate.validAfter, mandate.expiresAt]
      .every((value) => Number.isSafeInteger(value) && value >= 0) ||
    mandate.minTenorSeconds <= 0 ||
    mandate.maxTenorSeconds < mandate.minTenorSeconds ||
    mandate.expiresAt <= mandate.validAfter ||
    mandate.persistenceSeconds > mandate.expiresAt - mandate.validAfter ||
    mandate.riskThresholdBps < 0 ||
    mandate.riskThresholdBps > 10_000 ||
    !Number.isInteger(mandate.riskThresholdBps) ||
    // Zero would arm close and roll permanently; the account rejects it too.
    mandate.positionRiskThresholdBps <= 0 ||
    mandate.positionRiskThresholdBps > 10_000 ||
    !Number.isInteger(mandate.positionRiskThresholdBps)
  ) {
    throw new Error("mandate contains invalid timing or risk terms");
  }
}

function isContractAddress(value: string): value is Address {
  return isAddress(value) && value.toLowerCase() !== zeroAddress;
}

export type MandateTypedMessage = ReturnType<typeof mandateMessage> & { asset: Hex };

/** The inverse of the `stringToHex` above, for reading a mandate back off the
 *  chain. Returns null rather than a guess when the word does not decode, so a
 *  caller shows nothing instead of showing the wrong asset. */
export function assetFromHex(value: Hex): string | null {
  try {
    return hexToString(value, { size: 32 }).replace(/\0+$/, "") || null;
  } catch {
    return null;
  }
}
