/**
 * Single place that decides where market data comes from.
 *
 * With Supabase configured the app reads live rows from Postgres, so prices
 * reflect real trading and update across devices. Without it, everything falls
 * back to the ingested snapshot so the market is still fully browsable.
 *
 * Every page reads through these functions rather than importing the snapshot
 * directly, so adding the database never means rewriting a page.
 */
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import * as snapshot from "./snapshot";
import type { CareerValuePoint, NewsItem, Player } from "./types";
import type { Sport } from "@/lib/pricing/engine";
import type { StatTable, GameLogEntry } from "@/lib/providers/types";

interface PlayerRow {
  id: string;
  external_id: string;
  sport: Sport;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  position: string | null;
  jersey: string | null;
  team_abbrev: string | null;
  team_name: string | null;
  headshot_url: string | null;
  age_years: number | null;
  is_goalie: boolean;
  fair_value: number;
  opening_fair_value: number;
  liquidity_depth: number;
  shares_outstanding: number;
  market_price: number;
  prev_close: number | null;
  stat_tables: StatTable[] | null;
  game_log: GameLogEntry[] | null;
  career_value: CareerValuePoint[] | null;
  kind: Player["kind"] | null;
  components: Player["components"] | null;
  injury: Player["injury"] | null;
  healthy_fair_value: number | null;
  draft: Player["draft"] | null;
  status: Player["status"] | null;
  settles_at: string | null;
  settlement_price: number | null;
}

function rowToPlayer(r: PlayerRow): Player {
  return {
    id: r.id,
    externalId: r.external_id,
    sport: r.sport,
    fullName: r.full_name,
    firstName: r.first_name ?? "",
    lastName: r.last_name ?? "",
    position: r.position,
    jersey: r.jersey,
    teamAbbrev: r.team_abbrev,
    teamName: r.team_name,
    headshotUrl: r.headshot_url,
    ageYears: r.age_years,
    isGoalie: r.is_goalie,
    fairValue: Number(r.fair_value),
    openingFairValue: Number(r.opening_fair_value),
    liquidityDepth: Number(r.liquidity_depth),
    sharesOutstanding: Number(r.shares_outstanding),
    marketPrice: Number(r.market_price),
    prevClose: r.prev_close == null ? null : Number(r.prev_close),
    statTables: r.stat_tables ?? [],
    gameLog: r.game_log ?? [],
    careerValue: r.career_value ?? [],
    kind: r.kind ?? "athlete",
    components: r.components ?? [],
    injury: r.injury ?? null,
    healthyFairValue:
      r.healthy_fair_value == null ? Number(r.fair_value) : Number(r.healthy_fair_value),
    draft: r.draft ?? undefined,
    status: r.status ?? "active",
    settlesAt: r.settles_at,
    settlementPrice: r.settlement_price == null ? null : Number(r.settlement_price),
  };
}

/**
 * Whether live prices are available at all.
 *
 * This used to also require a signed-in session, because RLS gated `players` to
 * `authenticated`. That produced the worst possible split: two people on the
 * same URL saw different boards, one live from the database and one frozen in
 * `data/snapshot.json` at whenever the last deploy happened. Migration 0013
 * makes market data readable by `anon`, so the only question left is whether a
 * database is configured — and the snapshot goes back to being what it was
 * always meant to be, a fallback for running without one.
 */
async function canReadDatabase(): Promise<boolean> {
  return isSupabaseConfigured();
}

/** PostgREST refuses to return more than this in one request. */
const PAGE = 1000;

/**
 * Every listing, paged.
 *
 * PostgREST caps a response at 1,000 rows and says nothing about it — the query
 * simply returns 1,000 and looks successful. With 1,786 listings that silently
 * truncated the board to the 1,000 most expensive, so every athlete priced
 * under about $25 vanished for signed-in users while signed-out visitors (who
 * read the snapshot) saw the full list. Shohei Ohtani was missing for a
 * different reason, but this is what hid 254 MLB players and made the counter
 * read 1,000.
 */
export async function getPlayers(): Promise<Player[]> {
  if (await canReadDatabase()) {
    const supabase = await createSupabaseServerClient();
    const all: PlayerRow[] = [];

    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("players")
        .select("*")
        .order("market_price", { ascending: false })
        .range(from, from + PAGE - 1);

      if (error) break;
      const rows = (data ?? []) as PlayerRow[];
      all.push(...rows);
      // A short page is the last page.
      if (rows.length < PAGE) break;
      // Guard against a runaway loop if the table grows unexpectedly.
      if (all.length >= 20_000) break;
    }

    if (all.length > 0) return all.map(rowToPlayer);
  }
  return snapshot.getPlayers();
}

export async function getPlayer(id: string): Promise<Player | null> {
  if (await canReadDatabase()) {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.from("players").select("*").eq("id", id).maybeSingle();
    if (!error && data) return rowToPlayer(data as PlayerRow);
  }
  return snapshot.getPlayer(id);
}

export async function getNews(): Promise<NewsItem[]> {
  if (await canReadDatabase()) {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("news")
      .select("id, title, summary, url, source, image_url, published_at, sport, news_players(player_id)")
      .order("published_at", { ascending: false })
      .limit(150);

    if (!error && data) {
      return data.map((n) => ({
        id: String(n.id),
        title: n.title as string,
        summary: (n.summary as string | null) ?? null,
        url: n.url as string,
        source: (n.source as string | null) ?? null,
        imageUrl: (n.image_url as string | null) ?? null,
        publishedAt: n.published_at as string,
        sport: (n.sport as Sport | null) ?? null,
        playerIds: ((n.news_players ?? []) as Array<{ player_id: string }>).map(
          (l) => l.player_id
        ),
      }));
    }
  }
  return snapshot.getNews();
}

export async function getNewsForPlayer(playerId: string): Promise<NewsItem[]> {
  const news = await getNews();
  return news.filter((n) => n.playerIds.includes(playerId));
}

/**
 * Real traded price history only.
 *
 * This used to fall back to a modeled 60-day walk, which drew a confident
 * rising line for an athlete nobody had ever traded — a chart of a market that
 * did not happen. The career value chart now carries a new listing instead,
 * and this returns only ticks that actually occurred, so the price line stays
 * flat until somebody trades and every wiggle on it is real.
 */
export async function getPriceHistory(player: Player) {
  if (await canReadDatabase()) {
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase
      .from("price_ticks")
      .select("ts, market_price, fair_value")
      .eq("player_id", player.id)
      .order("ts", { ascending: true })
      .limit(400);

    if (data && data.length > 0) {
      return data.map((t) => ({
        ts: t.ts as string,
        marketPrice: Number(t.market_price),
        fairValue: Number(t.fair_value),
      }));
    }
  }
  return [];
}
