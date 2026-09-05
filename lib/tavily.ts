// Tavily Real-Time Web Search Client for Rumor Verification & Hackathon RAG.
// Queries Tavily (https://tavily.com) to retrieve real-time news evidence for Gonka models.

export type TavilyEvidence = {
  title: string;
  url: string;
  content: string;
  domain: string;
  score: number;
};

/**
 * Sanitizes raw conversational user text into high-signal search queries.
 * e.g. "i heard my friend said today bitcoin founder had a car crash, the value must be drop a lot"
 *      -> "bitcoin founder car crash"
 */
export function sanitizeSearchQuery(raw: string): string {
  let cleaned = raw.trim();

  // Strip Twitter/X author preamble, e.g. '@Bitcoin News: "' or '@user: '
  cleaned = cleaned.replace(/^@[\w\s.-]+:\s*["']?/i, "").trim();

  // Strip trailing tweet media links, e.g. pic.twitter.com/... or t.co/... and &mdash; attribution
  cleaned = cleaned.replace(/&mdash;[\s\S]*$/i, "").trim();
  cleaned = cleaned.replace(/https?:\/\/(t\.co|pic\.twitter\.com)[^\s]+/gi, "").trim();
  cleaned = cleaned.replace(/pic\.twitter\.com[^\s]+/gi, "").trim();

  // Strip common conversational preambles
  const preambles = [
    /^(i\s+heard\s+(my\s+friend\s+said\s+)?(today\s+)?(that\s+)?)/i,
    /^(my\s+friend\s+(told|said)\s+(to\s+)?me\s+(that\s+)?)/i,
    /^(did\s+you\s+hear\s+(that\s+)?)/i,
    /^(people\s+are\s+saying\s+(that\s+)?)/i,
    /^(is\s+it\s+true\s+(that\s+)?)/i,
    /^(rumor\s+has\s+it\s+(that\s+)?)/i,
    /^(someone\s+claimed\s+(that\s+)?)/i,
    /^(news\s+says\s+(that\s+)?)/i,
    /^(i\s+think\s+(that\s+)?)/i,
    /^(report\s+from\s+[a-z0-9.-]+:\s*)/i,
    /^(\[.*?\]\s*)/i,
  ];

  for (const pattern of preambles) {
    cleaned = cleaned.replace(pattern, "").trim();
  }

  // Strip conversational follow-ups / trading impulses
  cleaned = cleaned.replace(/,\s*(the\s+)?value\s+must\s+be\s+drop.*$/i, "");
  cleaned = cleaned.replace(/,\s*this\s+is\s+the\s+time\s+to\s+sweep.*$/i, "");
  cleaned = cleaned.replace(/,\s*should\s+i\s+(buy|sell|sweep).*$/i, "");
  cleaned = cleaned.replace(/[?!.]+$/, "").trim();

  // Clean leading/trailing quotes
  cleaned = cleaned.replace(/^["']+|["']+$/g, "").trim();

  // If query is short, ensure crypto context is retained
  if (cleaned.length > 0 && !/bitcoin|btc|ethereum|eth|crypto|sec/i.test(cleaned)) {
    cleaned = `${cleaned} crypto`;
  }

  return cleaned.slice(0, 160);
}

/**
 * Executes a real-time web search via Tavily API.
 * Uses native fetch with a 3.5s timeout. Returns empty array on missing key or network failure.
 */
export async function searchTavily(rawQuery: string, maxResults = 3): Promise<TavilyEvidence[]> {
  const apiKey = process.env.TAVILY_API_KEY?.trim();
  if (!apiKey || apiKey === "your_tavily_api_key_here") {
    return [];
  }

  const cleanQuery = sanitizeSearchQuery(rawQuery);
  if (!cleanQuery || cleanQuery.length < 3) {
    return [];
  }

  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query: cleanQuery,
        search_depth: "basic",
        include_answer: false,
        max_results: maxResults,
      }),
      signal: AbortSignal.timeout(3500),
    });

    if (!res.ok) {
      console.warn(`[Tavily Search] Server returned HTTP ${res.status}`);
      return [];
    }

    const data = await res.json();
    if (!Array.isArray(data.results)) {
      return [];
    }

    return data.results.map((r: { title?: string; url?: string; content?: string; score?: number }) => {
      let domain = "";
      try {
        if (r.url) domain = new URL(r.url).hostname.replace(/^www\./, "");
      } catch {}

      return {
        title: r.title?.trim() || "Web News Source",
        url: r.url || "#",
        content: (r.content || "").replace(/\s+/g, " ").trim().slice(0, 220),
        domain,
        score: typeof r.score === "number" ? r.score : 0.8,
      };
    });
  } catch (err) {
    console.warn("[Tavily Search] Search request failed or timed out:", err instanceof Error ? err.message : err);
    return [];
  }
}
