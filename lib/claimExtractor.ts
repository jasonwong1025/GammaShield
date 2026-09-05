// URL & Tweet Claim Extractor for Gonka Verification Track.
// Extracts clean headlines, tweet content, and article summaries from pasted links.

import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

/**
 * Blocks SSRF: this fetches whatever URL a user pastes into the fact-check
 * box, so a hostname resolving to loopback/private/link-local space (incl.
 * cloud metadata at 169.254.169.254) must never be requested server-side.
 */
async function isPublicHttpUrl(rawUrl: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  const host = parsed.hostname;
  const candidates: string[] = [];
  if (isIP(host)) {
    candidates.push(host);
  } else {
    try {
      const results = await lookup(host, { all: true });
      candidates.push(...results.map((r) => r.address));
    } catch {
      return false;
    }
  }
  if (candidates.length === 0) return false;
  return candidates.every((addr) => isPublicAddress(addr));
}

function isPublicAddress(addr: string): boolean {
  if (isIP(addr) === 4) {
    const parts = addr.split(".").map(Number);
    const [a, b] = parts;
    if (a === 127) return false; // loopback
    if (a === 10) return false; // private
    if (a === 169 && b === 254) return false; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false; // private
    if (a === 192 && b === 168) return false; // private
    if (a === 0) return false; // "this network"
    return true;
  }
  if (isIP(addr) === 6) {
    const lower = addr.toLowerCase();
    if (lower === "::1") return false; // loopback
    if (lower.startsWith("fe80:")) return false; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return false; // unique local
    if (lower.startsWith("::ffff:")) return isPublicAddress(lower.slice(7)); // v4-mapped
    return true;
  }
  return false;
}

export type ExtractedClaim = {
  isUrl: boolean;
  originalUrl?: string;
  domain?: string;
  headline: string;
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
            };
          }
        }
      }
    } catch {
      // Fall through to fallback slug parsing
    }
  }

  // 2. General News / Web Article Extraction (CoinDesk, Bloomberg, etc.)
  try {
    if (!(await isPublicHttpUrl(rawUrl))) throw new Error("Blocked non-public URL");
    const res = await fetch(rawUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "manual", // don't let a redirect hop past the public-address check above
      signal: AbortSignal.timeout(3500),
    });

    if (res.ok) {
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
        };
      }
    }
  } catch {
    // Network or timeout, fall through to slug extractor
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
      return {
        isUrl: true,
        originalUrl: rawUrl,
        domain,
        headline: `Report from ${domain}: ${cleanSlug.charAt(0).toUpperCase() + cleanSlug.slice(1)}`,
      };
    }
  } catch {}

  return {
    isUrl: true,
    originalUrl: rawUrl,
    domain,
    headline: `Link from ${domain}: ${rawUrl}`,
  };
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
