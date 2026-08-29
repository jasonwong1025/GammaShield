// 30-second GonkaRouter Smoke Test
// Run: node scripts/smoke-test.mjs

import fs from "fs";
import path from "path";

// Load environment variables from .env if present
try {
  const envPath = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf-8");
    envContent.split("\n").forEach((line) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
        const [k, ...v] = trimmed.split("=");
        process.env[k.trim()] = v.join("=").trim();
      }
    });
  }
} catch {
  // Ignore env read failure
}

const key = process.env.GONKA_API_KEY;
const baseUrl = (process.env.GONKA_BASE_URL || "https://api.gonkarouter.io/v1").replace(/\/$/, "");

console.log("==================================================");
console.log("🛡️  GammaShield: GonkaRouter 30-Second Smoke Test");
console.log("==================================================");
console.log(`Endpoint: ${baseUrl}/chat/completions`);
console.log(`Model:    MiniMaxAI/MiniMax-M2.7`);
console.log(`API Key:  ${key ? (key.startsWith("sk-") ? key.slice(0, 7) + "..." : "Configured") : "MISSING"}`);
console.log("--------------------------------------------------");

if (!key || key === "sk-your-gonkarouter-api-key-here") {
  console.error("❌ Error: GONKA_API_KEY is not set in .env. Please set your GonkaRouter key first.");
  process.exit(1);
}

async function runTest() {
  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: "MiniMaxAI/MiniMax-M2.7",
        max_tokens: 256,
        messages: [{ role: "user", content: "Reply with just: pong" }],
      }),
    });

    const elapsed = Date.now() - start;
    if (!res.ok) {
      const errText = await res.text();
      console.error(`❌ Request Failed with HTTP ${res.status} (${elapsed}ms):`);
      console.error(errText);
      process.exit(1);
    }

    const data = await res.json();
    console.log(`✅ Success! (HTTP 200 in ${elapsed}ms)`);
    console.log(`Gonka Request ID: ${data.id}`);
    console.log(`Model Response:   ${data.choices?.[0]?.message?.content?.trim()}`);
    console.log("--------------------------------------------------");
    console.log("🎉 GonkaRouter integration is fully operational!");
  } catch (err) {
    console.error("❌ Connection failed:", err.message);
    process.exit(1);
  }
}

runTest();
