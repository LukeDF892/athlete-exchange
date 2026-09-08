/**
 * Reprice the players who are actually on the ice, court or field right now.
 *
 * The daily ingest is the only thing that has ever moved performance value, and
 * it runs once per league in the small hours. So an athlete could have the game
 * of their career at 8pm and the number underneath their price would not budge
 * until the next morning — while the page told them, in as many words, that
 * "performance value updates after each one".
 *
 * This closes that gap without repeating the ingest. The scoreboard says which
 * teams are playing (one request per league); only those teams' players are
 * re-read; and the yardstick comes from `market_meta` rather than being
 * re-measured, because measuring it means fetching everybody, which is the
 * thing being avoided.
 *
 * ## What it deliberately does not touch
 *
 * `shares_outstanding`, `liquidity_depth` and `opening_fair_value` belong to
 * the market, not to the feed. An earlier bug in the ingest push reset exactly
 * those three for four fifths of the board and marked 137 real positions at a
 * price nobody had traded at. This job writes fair value, the price implied by
 * it, and the display stats — nothing else, ever.
 *
 * ## Weighting
 *
 * A game in progress counts as an ordinary recent game, which is the honest
 * choice and a modest one: one goal inside a five-game window, regressed by
 * sample size and weighted at 30% of the blend, moves a price by cents. The
 * visible move usually arrives when the game goes final and the full line lands
 * in the window. Weighting a live game up would make the feature feel livelier
 * and would be a deliberate distortion; it is not done here.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  dampenFairValue,
  fairValue,
  marketPrice,
  type Calibration,
  type Sport,
} from "@/lib/pricing/engine";
import { loadCalibration, loadCalibratedSports } from "@/lib/market/calibration";
import { fetchActiveTeams } from "@/lib/providers/active";
import { mapPool } from "@/lib/providers/http";
import { NhlProvider } from "@/lib/providers/nhl";
import { nbaProvider } from "@/lib/providers/espn";
import { mlbProvider } from "@/lib/providers/mlb";
import { nflProvider } from "@/lib/providers/nfl";
import type { RawPlayer, SportsProvider } from "@/lib/providers/types";
import { buildCareerValue } from "@/lib/market/career";

const CONCURRENCY = 6;
/** Beyond this many players in one slot, the feeds are the risk, not the clock. */
const MAX_PLAYERS = 220;

export interface LiveRefreshResult {
  /** Leagues with a game in progress or recently finished. */
  activeSports: Sport[];
  candidates: number;
  fetched: number;
  repriced: number;
  /** Largest single move, for the log — a run that moves nothing says so. */
  biggestMove: string | null;
  skipped?: string;
  seconds: number;
}

interface PlayerRow {
  id: string;
  external_id: string;
  sport: Sport;
  full_name: string;
  team_abbrev: string | null;
  position: string | null;
  age_years: number | null;
  fair_value: number;
  healthy_fair_value: number | null;
  shares_outstanding: number;
  liquidity_depth: number;
  market_price: number;
  injury: { multiplier?: number } | null;
}

function providerFor(sport: Sport): SportsProvider {
  switch (sport) {
    case "nhl":
      return new NhlProvider();
    case "nba":
      return nbaProvider;
    case "mlb":
      return mlbProvider;
    default:
      return nflProvider;
  }
}

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

/**
 * One pass over whoever is playing.
 *
 * Bounded by `budgetMs` because it shares a 300-second function with the bot
 * run: prices being slightly stale is recoverable, a slot that never trades is
 * a visibly dead market.
 */
export async function refreshLiveGames(
  db: SupabaseClient,
  { budgetMs = 60_000, lookbackHours = 6 }: { budgetMs?: number; lookbackHours?: number } = {}
): Promise<LiveRefreshResult> {
  const started = Date.now();
  const done = (extra: Partial<LiveRefreshResult>): LiveRefreshResult => ({
    activeSports: [],
    candidates: 0,
    fetched: 0,
    repriced: 0,
    biggestMove: null,
    seconds: Math.round((Date.now() - started) / 1000),
    ...extra,
  });

  // Without a stored yardstick every price would be measured against the
  // built-in fallbacks — which would move the whole board for a reason that has
  // nothing to do with any game. Better to do nothing until an ingest has run.
  const calibration: Calibration | null = await loadCalibration(db);
  if (!calibration) return done({ skipped: "no calibration stored yet" });

  // Only leagues an ingest has actually measured. A league sitting at the
  // built-in fallback marks looks identical to a measured one in the stored
  // calibration, and pricing against marks nobody took would move every listing
  // in that league for a reason unrelated to any game — the exact failure mode
  // that the per-sport merge exists to prevent, one level up.
  const measured = await loadCalibratedSports(db);
  if (measured.length === 0) return done({ skipped: "no league measured yet" });

  const active = await fetchActiveTeams(lookbackHours);
  const activeSports = [...active.entries()]
    .filter(([, g]) => g.live.size > 0 || g.recent.size > 0)
    .map(([s]) => s)
    .filter((s) => measured.includes(s));
  if (activeSports.length === 0) return done({ skipped: "nothing in play in a measured league" });

  /**
   * Listings a human holds or is watching, so they are refreshed first.
   *
   * Only ~230 of 5,476 listings have a position on them. When a busy night puts
   * more players in the active set than one slot can re-read, the rotation
   * decides who waits — and it should not be deciding at random between an
   * athlete somebody owns and the twelfth arm in a bullpen nobody has heard of.
   */
  const owned = new Set<string>();
  for (const table of ["holdings", "watchlist"] as const) {
    const { data } = await db.from(table).select("player_id").limit(2000);
    for (const r of data ?? []) owned.add(String((r as { player_id: string }).player_id));
  }

  // Live games first: those are the ones somebody is watching right now.
  const rows: PlayerRow[] = [];
  for (const pass of ["live", "recent"] as const) {
    for (const sport of activeSports) {
      const teams = [...(active.get(sport)?.[pass] ?? [])];
      if (teams.length === 0 || rows.length >= MAX_PLAYERS) continue;
      const { data } = await db
        .from("players")
        .select(
          "id, external_id, sport, full_name, team_abbrev, position, age_years, fair_value, " +
            "healthy_fair_value, shares_outstanding, liquidity_depth, market_price, injury"
        )
        .eq("sport", sport)
        .eq("kind", "athlete")
        .in("team_abbrev", teams)
        // Least recently touched first. A busy MLB night puts far more players
        // on the board than one slot can re-read, and without an ordering the
        // same first 220 were refreshed every ten minutes while the rest were
        // never reached at all. Staleness order makes the cap a rotation
        // instead of a cut.
        .order("updated_at", { ascending: true })
        .limit(MAX_PLAYERS);
      // Held and watched listings jump the queue within each pass.
      const batch = (data ?? []) as unknown as PlayerRow[];
      batch.sort((a, b) => Number(owned.has(b.id)) - Number(owned.has(a.id)));
      for (const r of batch) {
        if (rows.length >= MAX_PLAYERS) break;
        if (!rows.some((x) => x.id === r.id)) rows.push(r);
      }
    }
  }
  if (rows.length === 0) return done({ activeSports, skipped: "no listed players on those teams" });

  // Re-read each one from its own provider. This is the same call the ingest
  // makes, so a player fetched here is priced from exactly the same inputs.
  const byId = new Map(rows.map((r) => [r.external_id, r]));
  const providers = new Map<Sport, SportsProvider>();
  for (const s of activeSports) providers.set(s, providerFor(s));

  const results = await mapPool(rows, CONCURRENCY, async (row) => {
    if (Date.now() - started > budgetMs) return null;
    return providers.get(row.sport)!.fetchPlayer(row.external_id);
  });

  let fetched = 0;
  let repriced = 0;
  let biggest: { name: string; from: number; to: number; pct: number } | null = null;

  for (const r of results) {
    if (!r.ok || !r.value) continue;
    const raw: RawPlayer = r.value;
    const row = byId.get(raw.externalId);
    if (!row) continue;
    fetched++;

    const healthy = fairValue({
      sport: raw.sport,
      recent: raw.recent,
      season: raw.season,
      career: raw.career,
      ageYears: raw.ageYears,
      position: raw.position,
      calibration,
    });
    // The injury discount is the ingest's, carried forward: this job reads no
    // injury feed, and dropping the multiplier would silently un-discount every
    // hurt player the moment their team next played.
    const multiplier = row.injury?.multiplier ?? 1;
    // Same rate limit the daily push applies. A live refresh runs every ten
    // minutes, so without it a single hot game could walk a cheap listing up
    // several hundred percent inside an evening.
    const fv = dampenFairValue(Number(row.fair_value), round2(healthy * multiplier));

    // Nothing moved — and a write here is not free: every UPDATE wakes every
    // open page over the websocket and adds a tick to every chart.
    if (Math.abs(fv - Number(row.fair_value)) < 0.01) continue;

    const depth = Number(row.liquidity_depth);
    const shares = Number(row.shares_outstanding);
    const price = marketPrice(fv, shares, depth);

    const { error } = await db
      .from("players")
      .update({
        fair_value: fv,
        healthy_fair_value: healthy,
        market_price: price,
        stat_tables: raw.statTables,
        game_log: raw.gameLog ?? [],
        career_value: buildCareerValue(raw, calibration),
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (error) continue;

    await db.from("price_ticks").insert({
      player_id: row.id,
      market_price: price,
      fair_value: fv,
      shares_outstanding: shares,
    });

    repriced++;
    const pct = ((price - Number(row.market_price)) / Number(row.market_price)) * 100;
    if (!biggest || Math.abs(pct) > Math.abs(biggest.pct)) {
      biggest = { name: row.full_name, from: Number(row.market_price), to: price, pct };
    }
  }

  // Written so `runAudit` can tell a quiet night from a saturated one without
  // guessing: a cap that binds every night is the signal that this design has
  // outgrown per-player fetches and needs box scores instead.
  try {
    await db.from("market_meta").upsert({
      key: "live_refresh_last",
      value: {
        ranAt: new Date().toISOString(),
        activeSports,
        candidates: rows.length,
        fetched,
        repriced,
        cappedAt: MAX_PLAYERS,
      },
      updated_at: new Date().toISOString(),
    });
  } catch {
    // Bookkeeping must never fail the refresh.
  }

  return done({
    activeSports,
    candidates: rows.length,
    fetched,
    repriced,
    biggestMove: biggest
      ? `${biggest.name} $${biggest.from.toFixed(2)} -> $${biggest.to.toFixed(2)} (${
          biggest.pct >= 0 ? "+" : ""
        }${biggest.pct.toFixed(2)}%)`
      : null,
  });
}
