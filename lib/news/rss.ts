/**
 * News ingestion from public RSS feeds.
 *
 * Deliberately dependency-free: these feeds are small, well-formed RSS 2.0, and
 * pulling an XML parser in for a handful of tags is not worth the install.
 */
import type { Sport } from "@/lib/pricing/engine";
import { getText } from "@/lib/providers/http";

export interface RawNewsItem {
  guid: string;
  title: string;
  summary: string | null;
  url: string;
  source: string;
  imageUrl: string | null;
  publishedAt: string;
  sport: Sport | null;
}

interface FeedSource {
  url: string;
  source: string;
  sport: Sport | null;
}

export const FEEDS: FeedSource[] = [
  { url: "https://www.espn.com/espn/rss/nba/news", source: "ESPN", sport: "nba" },
  { url: "https://www.espn.com/espn/rss/nhl/news", source: "ESPN", sport: "nhl" },
  { url: "https://www.cbssports.com/rss/headlines/nba/", source: "CBS Sports", sport: "nba" },
  { url: "https://www.cbssports.com/rss/headlines/nhl/", source: "CBS Sports", sport: "nhl" },
  { url: "https://sports.yahoo.com/nba/rss.xml", source: "Yahoo Sports", sport: "nba" },
  { url: "https://sports.yahoo.com/nhl/rss.xml", source: "Yahoo Sports", sport: "nhl" },
  { url: "https://www.espn.com/espn/rss/mlb/news", source: "ESPN", sport: "mlb" },
  { url: "https://www.cbssports.com/rss/headlines/mlb/", source: "CBS Sports", sport: "mlb" },
  { url: "https://sports.yahoo.com/mlb/rss.xml", source: "Yahoo Sports", sport: "mlb" },
  { url: "https://www.espn.com/espn/rss/nfl/news", source: "ESPN", sport: "nfl" },
  { url: "https://www.cbssports.com/rss/headlines/nfl/", source: "CBS Sports", sport: "nfl" },
  { url: "https://sports.yahoo.com/nfl/rss.xml", source: "Yahoo Sports", sport: "nfl" },
];

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decodeEntities(m[1]) : null;
}

function attr(block: string, tagName: string, attrName: string): string | null {
  const m = block.match(new RegExp(`<${tagName}[^>]*\\b${attrName}=["']([^"']+)["']`, "i"));
  return m ? decodeEntities(m[1]) : null;
}

function stripHtml(s: string | null): string | null {
  if (!s) return null;
  const text = s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : null;
}

export function parseFeed(xml: string, feed: FeedSource): RawNewsItem[] {
  const items: RawNewsItem[] = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];

  for (const block of blocks) {
    const title = tag(block, "title");
    const link = tag(block, "link");
    if (!title || !link) continue;

    const pub = tag(block, "pubDate");
    const parsedDate = pub ? new Date(pub) : null;

    items.push({
      guid: tag(block, "guid") || link,
      title,
      summary: stripHtml(tag(block, "description")),
      url: link,
      source: feed.source,
      imageUrl:
        attr(block, "media:content", "url") ??
        attr(block, "media:thumbnail", "url") ??
        attr(block, "enclosure", "url"),
      publishedAt:
        parsedDate && !Number.isNaN(parsedDate.getTime())
          ? parsedDate.toISOString()
          : new Date().toISOString(),
      sport: feed.sport,
    });
  }
  return items;
}

export async function fetchAllNews(): Promise<RawNewsItem[]> {
  const results = await Promise.allSettled(
    FEEDS.map(async (feed) => parseFeed(await getText(feed.url), feed))
  );

  const all: RawNewsItem[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") all.push(...r.value);
  }

  // Same story often appears in several feeds; keep one copy of each URL.
  const seen = new Set<string>();
  const deduped = all.filter((item) => {
    const key = item.url.split("?")[0];
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped.sort(
    (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
  );
}

/**
 * Tag stories with the players they mention.
 *
 * Full name only. Matching on last names alone produces a flood of false
 * positives ("Smith", "Johnson", and every hockey Sutter), which would put the
 * wrong headlines on a player's page — worse than showing none.
 */
export function matchPlayers(
  item: RawNewsItem,
  players: Array<{ id: string; fullName: string; sport: Sport }>
): string[] {
  const haystack = `${item.title} ${item.summary ?? ""}`.toLowerCase();
  const matched: string[] = [];

  for (const p of players) {
    if (item.sport && p.sport !== item.sport) continue;
    const name = p.fullName.toLowerCase();
    if (name.length < 6) continue;
    if (haystack.includes(name)) matched.push(p.id);
  }
  return matched;
}
