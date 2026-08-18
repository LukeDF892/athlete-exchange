/**
 * Pushes an ingest snapshot into Supabase using the service-role key.
 *
 * Service role bypasses RLS, which is why this only ever runs server-side from
 * a script or cron — never from the browser.
 *
 * Refresh semantics: fair_value and the stat tables are updated on every run,
 * but shares_outstanding, opening_fair_value and liquidity_depth are left alone
 * for players that already exist. Those belong to the market, not the feed;
 * overwriting them would wipe out everyone's positions.
 *
 * That guarantee is only as good as the read that backs it, and for a long time
 * it was not good at all: PostgREST caps a response at 1,000 rows and reports
 * no error, so on a 5,476-row board the read-back covered under a fifth of it.
 * Every listing outside that page looked new, and was upserted with zero shares
 * outstanding and a price reset to fair value — which quietly deleted the
 * market's memory of 135 held positions and marked them at a price nobody had
 * traded at. `getPlayers()` learned this lesson (see lib/market/source.ts); the
 * push had not. Every read here is paged, and the row count is checked against
 * the table before anything is written.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { marketPrice } from "@/lib/pricing/engine";
import type { NewsItem, Player } from "@/lib/market/types";

export interface Snapshot {
  generatedAt: string;
  players: Player[];
  news: NewsItem[];
}

export async function pushSnapshot(snapshot: Snapshot): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      "Cannot push: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local"
    );
  }

  // supabase-js builds a realtime client in its constructor even when we only
  // ever call REST, and that needs a global WebSocket. Node 22+ has one; Node 20
  // needs --experimental-websocket, which the `ingest` npm script passes.
  if (typeof WebSocket === "undefined") {
    throw new Error(
      "No global WebSocket. Run via `npm run ingest -- --push` (which passes " +
        "--experimental-websocket), or upgrade to Node 22+."
    );
  }

  const db = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Existing market state, so a refresh never clobbers live positions.
  const existing = await selectAll<{
    external_id: string;
    shares_outstanding: number;
    opening_fair_value: number;
    liquidity_depth: number;
    market_price: number;
  }>(db, "players", "external_id, shares_outstanding, opening_fair_value, liquidity_depth, market_price");

  // A short read here is indistinguishable from a board full of new listings,
  // and the cost of not noticing is everyone's positions. So it is checked
  // rather than trusted: refusing to write is recoverable, writing zeroes is
  // not.
  const { count, error: countErr } = await db
    .from("players")
    .select("*", { count: "exact", head: true });
  if (countErr) throw countErr;
  if (count != null && existing.length < count) {
    throw new Error(
      `read back only ${existing.length} of ${count} existing listings — refusing to push, ` +
        "because every listing missing from that read would be reset to zero shares outstanding"
    );
  }

  const prior = new Map(
    (existing ?? []).map((row) => [
      row.external_id as string,
      row as {
        shares_outstanding: number;
        opening_fair_value: number;
        liquidity_depth: number;
        market_price: number;
      },
    ])
  );

  // The draft column arrives with migration 0009. Sending it before that runs
  // fails every row with a schema-cache error, so it is omitted rather than
  // holding the whole board hostage to one migration.
  const withDraft = process.env.PROSPECTS_SUPPORTED !== "false";

  const rows = snapshot.players.map((p) => {
    const before = prior.get(p.externalId);
    const shares = before?.shares_outstanding ?? 0;
    const depth = before?.liquidity_depth ?? p.liquidityDepth;
    const openingFv = before?.opening_fair_value ?? p.fairValue;

    return {
      external_id: p.externalId,
      sport: p.sport,
      full_name: p.fullName,
      first_name: p.firstName,
      last_name: p.lastName,
      position: p.position,
      jersey: p.jersey,
      team_abbrev: p.teamAbbrev,
      team_name: p.teamName,
      headshot_url: p.headshotUrl,
      age_years: p.ageYears,
      is_goalie: p.isGoalie,
      fair_value: p.fairValue,
      opening_fair_value: openingFv,
      liquidity_depth: depth,
      shares_outstanding: shares,
      // Recompute against the NEW fair value but the EXISTING share count,
      // so fundamentals move the price and holders keep their premium.
      market_price: marketPrice(p.fairValue, shares, depth),
      prev_close: before?.market_price ?? null,
      stat_tables: p.statTables,
      game_log: p.gameLog,
      career_value: p.careerValue,
      kind: p.kind,
      components: p.components ?? [],
      injury: p.injury,
      healthy_fair_value: p.healthyFairValue,
      ...(withDraft ? { draft: p.draft ?? null } : {}),
      updated_at: new Date().toISOString(),
    };
  });

  for (const chunk of chunks(rows, 100)) {
    const { error } = await db.from("players").upsert(chunk, { onConflict: "external_id" });
    if (error) throw error;
  }
  console.log(`[supabase] upserted ${rows.length} players`);

  // Record a tick per player so the chart has a fresh point for both lines.
  // Paged for the same reason as the read above: capped at 1,000, four fifths
  // of the board silently got no tick, so their charts stopped moving.
  const ids = await selectAll<{ id: string; external_id: string }>(db, "players", "id, external_id");
  const idByExternal = new Map(ids.map((r) => [r.external_id, r.id]));

  const ticks = rows
    .map((r) => {
      const id = idByExternal.get(r.external_id);
      if (!id) return null;
      return {
        player_id: id,
        market_price: r.market_price,
        fair_value: r.fair_value,
        shares_outstanding: r.shares_outstanding,
      };
    })
    .filter((t): t is NonNullable<typeof t> => t != null);

  for (const chunk of chunks(ticks, 200)) {
    const { error } = await db.from("price_ticks").insert(chunk);
    if (error) throw error;
  }
  console.log(`[supabase] inserted ${ticks.length} price ticks`);

  if (snapshot.news.length > 0) {
    const newsRows = snapshot.news.map((n) => ({
      guid: n.url,
      sport: n.sport,
      title: n.title,
      summary: n.summary,
      url: n.url,
      source: n.source,
      image_url: n.imageUrl,
      published_at: n.publishedAt,
    }));
    const { error } = await db.from("news").upsert(newsRows, { onConflict: "guid" });
    if (error) throw error;
    console.log(`[supabase] upserted ${newsRows.length} news items`);

    // Link stories to players.
    const newsIds = await selectAll<{ id: number; url: string }>(db, "news", "id, url");
    const newsIdByUrl = new Map(newsIds.map((r) => [r.url, r.id]));
    const links: Array<{ news_id: number; player_id: string }> = [];
    for (const n of snapshot.news) {
      const newsId = newsIdByUrl.get(n.url);
      if (!newsId) continue;
      for (const slug of n.playerIds) {
        const player = snapshot.players.find((p) => p.id === slug);
        const pid = player ? idByExternal.get(player.externalId) : undefined;
        if (pid) links.push({ news_id: newsId, player_id: pid });
      }
    }
    if (links.length > 0) {
      for (const chunk of chunks(links, 200)) {
        await db.from("news_players").upsert(chunk, { onConflict: "news_id,player_id" });
      }
      console.log(`[supabase] linked ${links.length} story/player pairs`);
    }
  }
}

/** PostgREST refuses to return more than this in one request. */
const PAGE = 1000;

/**
 * Every row of a table, a page at a time.
 *
 * PostgREST truncates at 1,000 rows and returns success, so an unpaged read of
 * a growing table does not fail — it silently starts telling a smaller and
 * smaller fraction of the truth.
 */
async function selectAll<T>(
  db: SupabaseClient,
  table: string,
  columns: string
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from(table).select(columns).range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    all.push(...rows);
    // A short page is the last page.
    if (rows.length < PAGE) return all;
    // Guard against a runaway loop if the table grows unexpectedly.
    if (all.length >= 100_000) return all;
  }
}

function* chunks<T>(arr: T[], size: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}
