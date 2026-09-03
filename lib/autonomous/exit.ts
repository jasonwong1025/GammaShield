// Building the two signed structs a shadow exit needs.
//
// A close touches two contracts, so it carries two signatures from the same
// Base Sepolia agent key:
//
//   ShadowClose        signed over the shadow book's domain — the book's own
//                      attestation that this exit mark is real.
//   ShadowCloseAttest  signed over the policy account's domain and bound to the
//                      mandate hash, so a close signed for one policy cannot be
//                      replayed against another.
//
// The mark comes from lib/shadow.ts, which prices an open receipt off the live
// Thetanuts book. When it cannot be priced the exit is skipped rather than
// closed at an invented number.

import "server-only";

import { ethers } from "ethers";
import type { ShadowPosition } from "../shadow";

const CLOSE_LIFETIME_SECONDS = 120;

const BOOK_CLOSE_TYPES = {
  ShadowClose: [
    { name: "closeId", type: "bytes32" },
    { name: "positionId", type: "uint256" },
    { name: "seller", type: "address" },
    { name: "validUntil", type: "uint64" },
    { name: "contractsE6", type: "uint128" },
    { name: "proceedsUsdc", type: "uint128" },
  ],
};

const ACCOUNT_CLOSE_TYPES = {
  ShadowClose: [
    { name: "mandateHash", type: "bytes32" },
    { name: "closeId", type: "bytes32" },
    { name: "positionId", type: "uint256" },
    { name: "contractsE6", type: "uint128" },
    { name: "proceedsUsdc", type: "uint128" },
    { name: "observedAt", type: "uint64" },
    { name: "validUntil", type: "uint64" },
  ],
};

export type SignedShadowClose = {
  close: { closeId: string; positionId: bigint; seller: string; validUntil: bigint; contractsE6: bigint; proceedsUsdc: bigint };
  closeSignature: string;
  attestation: { mandateHash: string; closeId: string; positionId: bigint; contractsE6: bigint; proceedsUsdc: bigint; observedAt: bigint; validUntil: bigint };
  attestationSignature: string;
};

export type ExitRefusal = { reason: string };

/**
 * Sign an exit for one open receipt at its current mark.
 *
 * Refuses rather than guessing when the position cannot be priced, and when the
 * book cannot cover the payout — the shadow book only holds the premiums it has
 * collected, so an exit worth more than its balance would revert on-chain.
 */
export async function signShadowClose({
  position,
  mandateHash,
  account,
  chainId,
  optionBook,
  bookBalanceUsdc,
  agent,
}: {
  position: ShadowPosition;
  mandateHash: string;
  account: string;
  chainId: number;
  optionBook: string;
  bookBalanceUsdc: bigint;
  agent: ethers.Wallet;
}): Promise<SignedShadowClose | ExitRefusal> {
  if (position.closedAt) return { reason: "That receipt is already closed." };
  if (!position.mark) return { reason: "The open receipt cannot be priced right now, so it is not being closed at a guess." };

  const proceedsUsdc = BigInt(Math.max(0, Math.floor(position.mark.valueUsd * 1e6)));
  if (proceedsUsdc > bookBalanceUsdc) {
    return { reason: "The shadow book holds less test USDC than this exit is worth; it would revert." };
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  const validUntil = now + BigInt(CLOSE_LIFETIME_SECONDS);
  const contractsE6 = BigInt(Math.round(position.contracts * 1e6));
  const closeId = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256", "uint64"], [mandateHash, position.id, now]),
  );

  const close = { closeId, positionId: BigInt(position.id), seller: account, validUntil, contractsE6, proceedsUsdc };
  const closeSignature = await agent.signTypedData(
    { name: "GammaShield Shadow OptionBook", version: "1", chainId, verifyingContract: optionBook },
    BOOK_CLOSE_TYPES,
    close,
  );

  const attestation = { mandateHash, closeId, positionId: BigInt(position.id), contractsE6, proceedsUsdc, observedAt: now, validUntil };
  const attestationSignature = await agent.signTypedData(
    { name: "GammaShield Shadow Close", version: "1", chainId, verifyingContract: account },
    ACCOUNT_CLOSE_TYPES,
    attestation,
  );

  return { close, closeSignature, attestation, attestationSignature };
}

export const isRefusal = (value: SignedShadowClose | ExitRefusal): value is ExitRefusal => "reason" in value;
