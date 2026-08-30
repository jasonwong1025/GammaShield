import { isAddress } from "ethers";
import { getThetanutsPositions } from "@/lib/positions";

export async function GET(request: Request) {
  const address = new URL(request.url).searchParams.get("address");
  if (!address || !isAddress(address)) {
    return Response.json({ error: "valid address is required" }, { status: 400 });
  }

  try {
    const positions = await getThetanutsPositions(address);
    return Response.json({ positions }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "positions failed";
    return Response.json({ error: message }, { status: 502 });
  }
}
