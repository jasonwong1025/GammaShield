import { timingSafeEqual } from "node:crypto";
import { getShadowUserOperationReceipt, runShadowAgents } from "@/lib/shadowAgent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const secret = process.env.SHADOW_AGENT_CRON_SECRET;
  if (!secret || !authorized(request.headers.get("authorization"), secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const pendingAccounts = await pendingAccountsFrom(request);
    return Response.json({ results: await runShadowAgents({ pendingAccounts }) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "shadow agent failed" }, { status: 502 });
  }
}

export async function GET(request: Request) {
  const secret = process.env.SHADOW_AGENT_CRON_SECRET;
  if (!secret || !authorized(request.headers.get("authorization"), secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const userOpHash = new URL(request.url).searchParams.get("userOpHash") ?? "";
    return Response.json({ receipt: await getShadowUserOperationReceipt(userOpHash) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "shadow UserOperation status failed" }, { status: 502 });
  }
}

async function pendingAccountsFrom(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return [];
  const body: unknown = await request.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid shadow-agent request body");
  const pending = (body as { pendingAccounts?: unknown }).pendingAccounts;
  if (pending === undefined) return [];
  if (!Array.isArray(pending) || pending.length > 1_000 || pending.some((account) => typeof account !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(account))) {
    throw new Error("invalid pending account list");
  }
  return pending;
}

function authorized(header: string | null, secret: string) {
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(header ?? "");
  return expected.length === received.length && timingSafeEqual(expected, received);
}
