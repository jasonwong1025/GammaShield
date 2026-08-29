// GammaShield deliberately has no server-side signer. AI may recommend a
// hedge, but the connected user wallet signs the reviewed transaction.

export type HedgeRequest = {
  asset: string;
  targetStrike?: number;
  amountUsdc?: number;
};

export async function getWalletStatus() {
  return { configured: false, mode: "user-signed" as const };
}

export async function executeLiveHedge(_params: HedgeRequest): Promise<never> {
  void _params;
  throw new Error("Server-side hedge execution is disabled. Use the user-signed trade panel.");
}
