import assert from "node:assert/strict";
import { hashTypedData, type Address } from "viem";
import {
  MANDATE_EIP712_TYPES,
  canApplyMandateAction,
  mandateDomain,
  mandateMessage,
  mandateStatus,
  type Mandate,
} from "../lib/mandate.ts";

const mandate: Mandate = {
  owner: "0x1111111111111111111111111111111111111111" as Address,
  account: "0x2222222222222222222222222222222222222222" as Address,
  agent: "0x3333333333333333333333333333333333333333" as Address,
  optionBook: "0x4444444444444444444444444444444444444444" as Address,
  collateral: "0x5555555555555555555555555555555555555555" as Address,
  asset: "ETH",
  side: "put",
  maxPremiumPerFill: 2_000_000n,
  maxPremiumTotal: 10_000_000n,
  maxContractsPerFill: 1_000_000n,
  minTenorSeconds: 86_400,
  maxTenorSeconds: 2_419_200,
  riskThresholdBps: 7_500,
  persistenceSeconds: 300,
  minExecutionIntervalSeconds: 3_600,
  validAfter: 1_700_000_000,
  expiresAt: 1_700_604_800,
  nonce: 1n,
};

const control = { paused: false, revoked: false, spentPremium: 0n };
assert.equal(mandateStatus(mandate, control, mandate.validAfter), "active");
assert.equal(mandateStatus(mandate, { ...control, paused: true }, mandate.validAfter), "paused");
assert.equal(mandateStatus(mandate, { ...control, revoked: true }, mandate.validAfter), "revoked");
assert.equal(mandateStatus(mandate, control, mandate.expiresAt), "expired");
assert.equal(canApplyMandateAction("active", "execute"), true);
assert.equal(canApplyMandateAction("paused", "execute"), false);

const message = mandateMessage(mandate);
const sepoliaHash = hashTypedData({
  domain: mandateDomain(84_532, "0x6666666666666666666666666666666666666666"),
  types: MANDATE_EIP712_TYPES,
  primaryType: "Mandate",
  message,
});
const mainnetHash = hashTypedData({
  domain: mandateDomain(8_453, "0x6666666666666666666666666666666666666666"),
  types: MANDATE_EIP712_TYPES,
  primaryType: "Mandate",
  message,
});
assert.notEqual(sepoliaHash, mainnetHash, "mandates must be chain-bound");
const otherAccountHash = hashTypedData({
  domain: mandateDomain(84_532, "0x6666666666666666666666666666666666666666"),
  types: MANDATE_EIP712_TYPES,
  primaryType: "Mandate",
  message: mandateMessage({ ...mandate, account: "0x7777777777777777777777777777777777777777" }),
});
assert.notEqual(sepoliaHash, otherAccountHash, "mandates must be account-bound");
assert.throws(() => mandateMessage({ ...mandate, maxPremiumTotal: 1n }));

console.log("mandate self-check passed");
