export async function GET() {
  return Response.json({ mode: "user-signed", message: "Use the trade panel to review and sign every mainnet fill." });
}

export async function POST() {
  return Response.json(
    { error: "Server-side hedge execution is disabled. GammaShield only submits user-signed fills from the trade panel." },
    { status: 410 },
  );
}
