// URL & Tweet Claim Extractor for Gonka Verification Track.
// Extracts clean headlines, tweet content, and article summaries from pasted links.

export type ExtractedClaim = {
  isUrl: boolean;
  originalUrl?: string;
  domain?: string;
  headline: string;
  fetchStatus?: "VERIFIED_PAGE" | "HTTP_404" | "HTTP_ERROR" | "TIMEOUT_OR_BLOCKED" | "NO_URL";
  warning?: string;
};

/**
 * Extracts claim text from raw user input (plain text or URL).
 */
export async function extractClaimFromInput(input: string): Promise<ExtractedClaim> {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/https?:\/\/[^\s]+/i);

  if (!urlMatch) {
    return {
      isUrl: false,
      headline: trimmed,
      fetchStatus: "NO_URL",
    };
  }

  const rawUrl = urlMatch[0];
  let domain = "";
  try {
    const parsedUrl = new URL(rawUrl);
    domain = parsedUrl.hostname.replace(/^www\./, "");
  } catch {
    return {
      isUrl: false,
      headline: trimmed,
      fetchStatus: "NO_URL",
    };
  }

  // 1. Twitter / X Link Extraction via oEmbed
  if (domain.includes("twitter.com") || domain.includes("x.com")) {
    try {
      const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(rawUrl)}&omit_script=true`;
      const res = await fetch(oembedUrl, { signal: AbortSignal.timeout(3500) });
      if (res.ok) {
        const data = await res.json();
        if (typeof data.html === "string") {
          // Strip HTML tags to get pure tweet text
          const tweetText = data.html
            .replace(/<blockquote[\s\S]*?>/i, "")
            .replace(/<\/blockquote>/i, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          if (tweetText.length > 10) {
            return {
              isUrl: true,
              originalUrl: rawUrl,
              domain,
              headline: data.author_name ? `@${data.author_name}: "${tweetText}"` : tweetText,
              fetchStatus: "VERIFIED_PAGE",
            };
          }
        }
      }
    } catch {
      // Fall through to fallback slug parsing
    }
  }

  let fetchStatus: ExtractedClaim["fetchStatus"] = undefined;
  let warning: string | undefined = undefined;

  // 2. General News / Web Article Extraction (CoinDesk, Bloomberg, etc.)
  try {
    const res = await fetch(rawUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(3500),
    });

    if (res.status === 404) {
      fetchStatus = "HTTP_404";
      warning = formatHttpWarning(404, domain);
    } else if (!res.ok) {
      fetchStatus = "HTTP_ERROR";
      warning = formatHttpWarning(res.status, domain);
    } else {
      const html = await res.text();

      // Extract OpenGraph title or HTML title
      const ogTitleMatch =
        html.match(/<meta\s+property=["']og:title["']\s+content=["'](.*?)["']/i) ||
        html.match(/<meta\s+name=["']twitter:title["']\s+content=["'](.*?)["']/i) ||
        html.match(/<title\b[^>]*>(.*?)<\/title>/i);

      // Extract description
      const ogDescMatch =
        html.match(/<meta\s+property=["']og:description["']\s+content=["'](.*?)["']/i) ||
        html.match(/<meta\s+name=["']description["']\s+content=["'](.*?)["']/i);

      const title = ogTitleMatch?.[1]?.trim() || "";
      const desc = ogDescMatch?.[1]?.trim() || "";

      if (title) {
        const decodedTitle = decodeHtmlEntities(title);
        const decodedDesc = desc ? decodeHtmlEntities(desc) : "";
        const combined = decodedDesc && !decodedTitle.includes(decodedDesc.slice(0, 30))
          ? `${decodedTitle} — ${decodedDesc}`
          : decodedTitle;

        return {
          isUrl: true,
          originalUrl: rawUrl,
          domain,
          headline: combined.slice(0, 400),
          fetchStatus: "VERIFIED_PAGE",
        };
      }
    }
  } catch {
    fetchStatus = "TIMEOUT_OR_BLOCKED";
    warning = `Could not connect to ${domain} (connection timed out). Reconstructed headline from link.`;
  }

  // 3. Fallback: Extract claim from URL path slug
  try {
    const parsed = new URL(rawUrl);
    const slug = parsed.pathname
      .split("/")
      .filter(Boolean)
      .pop() || "";
    const cleanSlug = slug
      .replace(/[-_]/g, " ")
      .replace(/\.(html?|php)$/i, "")
      .trim();

    if (cleanSlug.length > 5) {
      const formattedTitle = cleanSlug.charAt(0).toUpperCase() + cleanSlug.slice(1);
      const headline = fetchStatus === "HTTP_404"
        ? `[Dead Link on ${domain}] ${formattedTitle}`
        : `Report from ${domain}: ${formattedTitle}`;
      return {
        isUrl: true,
        originalUrl: rawUrl,
        domain,
        headline,
        fetchStatus: fetchStatus || "TIMEOUT_OR_BLOCKED",
        warning,
      };
    }
  } catch {}

  return {
    isUrl: true,
    originalUrl: rawUrl,
    domain,
    headline: fetchStatus === "HTTP_404" ? `[Dead Link on ${domain}] ${rawUrl}` : `Link from ${domain}: ${rawUrl}`,
    fetchStatus: fetchStatus || "TIMEOUT_OR_BLOCKED",
    warning,
  };
}

/**
 * Translates technical HTTP status codes to user-friendly plain English.
 */
function formatHttpWarning(status: number, domain: string): string {
  switch (status) {
    case 404:
      return `Article not found on ${domain} (page does not exist or was removed).`;
    case 429:
      return `Rate limited by ${domain} (too many automated requests; anti-bot active). Reconstructed headline from link.`;
    case 403:
      return `Access blocked by ${domain} (anti-scraping protection active). Reconstructed headline from link.`;
    case 401:
      return `${domain} requires a login or paid subscription. Reconstructed headline from link.`;
    case 500:
    case 502:
    case 503:
    case 504:
      return `${domain} servers are temporarily unavailable. Reconstructed headline from link.`;
    default:
      return `Could not load page directly from ${domain} (server responded with code ${status}). Reconstructed headline from link.`;
  }
}

/**
 * Basic HTML entity decoder
 */
function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–");
}
