import { timingSafeEqual } from "node:crypto";
import { getThetanutsUserOperationReceipt, runThetanutsAgents } from "@/lib/thetanutsAgent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const secret = process.env.BASE_AGENT_CRON_SECRET;
  if (!secret || !authorized(request.headers.get("authorization"), secret)) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    return Response.json(await runThetanutsAgents(await agentOptionsFrom(request)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Thetanuts agent failed" }, { status: 502 });
  }
}

export async function GET(request: Request) {
  const secret = process.env.BASE_AGENT_CRON_SECRET;
  if (!secret || !authorized(request.headers.get("authorization"), secret)) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const userOpHash = new URL(request.url).searchParams.get("userOpHash") ?? "";
    return Response.json({ receipt: await getThetanutsUserOperationReceipt(userOpHash) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Thetanuts UserOperation status failed" }, { status: 502 });
  }
}

async function agentOptionsFrom(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return {};
  const body: unknown = await request.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid agent request body");
  const { pendingAccounts, knownAccounts, discoveryFromBlock } = body as { pendingAccounts?: unknown; knownAccounts?: unknown; discoveryFromBlock?: unknown };
  for (const accounts of [pendingAccounts, knownAccounts]) {
    if (accounts !== undefined && (!Array.isArray(accounts) || accounts.length > 1_000 || accounts.some((account) => typeof account !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(account)))) throw new Error("invalid agent account list");
  }
  if (discoveryFromBlock !== undefined && (typeof discoveryFromBlock !== "number" || !Number.isSafeInteger(discoveryFromBlock) || discoveryFromBlock < 0)) throw new Error("invalid discovery block");
  return { pendingAccounts: pendingAccounts as string[] | undefined, knownAccounts: knownAccounts as string[] | undefined, discoveryFromBlock: discoveryFromBlock as number | undefined };
}

function authorized(header: string | null, secret: string) {
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(header ?? "");
  return expected.length === received.length && timingSafeEqual(expected, received);
}
