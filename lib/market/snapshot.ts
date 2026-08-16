import { readFile } from "node:fs/promises";
import path from "node:path";
import type { NewsItem, Player } from "./types";

export interface Snapshot {
  generatedAt: string;
  players: Player[];
  news: NewsItem[];
}

const EMPTY: Snapshot = { generatedAt: new Date(0).toISOString(), players: [], news: [] };

let cached: Snapshot | null = null;

/**
 * Reads the ingested market snapshot from disk.
 *
 * This is what lets the app run with real NBA and NHL data before any database
 * exists. Once Supabase is configured the same shapes come from Postgres and
 * this becomes the offline/dev fallback.
 */
export async function loadSnapshot(): Promise<Snapshot> {
  if (cached) return cached;
  try {
    const file = path.join(process.cwd(), "data", "snapshot.json");
    const parsed = JSON.parse(await readFile(file, "utf8")) as Snapshot;
    cached = parsed;
    return parsed;
  } catch {
    // No snapshot yet — the UI renders its empty state and tells you to ingest.
    return EMPTY;
  }
}

export async function getPlayers(): Promise<Player[]> {
  return (await loadSnapshot()).players;
}

export async function getPlayer(id: string): Promise<Player | null> {
  const { players } = await loadSnapshot();
  return players.find((p) => p.id === id) ?? null;
}

export async function getNews(): Promise<NewsItem[]> {
  return (await loadSnapshot()).news;
}

export async function getNewsForPlayer(playerId: string): Promise<NewsItem[]> {
  const news = await getNews();
  return news.filter((n) => n.playerIds.includes(playerId));
}
