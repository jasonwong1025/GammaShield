import "server-only";

// Free-tier Base Sepolia RPC endpoints (sepolia.base.org and similar) rate-limit
// eth_getLogs bursts with JSON-RPC code -32016 ("over rate limit"). ethers wraps
// that as an UNKNOWN_ERROR with the raw error on `.info.error`. Retry those with
// backoff instead of surfacing them as an upstream failure.
function isRateLimited(error: unknown): boolean {
  const info = (error as { info?: { error?: { code?: number; message?: string } } })?.info?.error;
  if (info?.code === -32016) return true;
  const message = String((error as { shortMessage?: string; message?: string })?.shortMessage ?? (error as { message?: string })?.message ?? "");
  return /rate limit/i.test(message) || /rate limit/i.test(String(info?.message ?? ""));
}

/** Retries an RPC call with exponential backoff when the endpoint reports a rate limit. */
export async function withRpcRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || !isRateLimited(error)) throw error;
      const delayMs = 250 * 2 ** (attempt - 1) + Math.random() * 100;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
