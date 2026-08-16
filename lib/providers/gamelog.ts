/**
 * Recent form for the leagues ESPN serves a per-game log for.
 *
 * The pricing model always had a `recent` window worth 30% of the blend, but
 * only the NHL ever filled it — NBA and MLB passed `null`, so their prices were
 * a mix of season-to-date and career and nothing else. `fairValue()`
 * renormalises around a missing window, so nothing was *broken*; it just meant
 * two thirds of the board could not respond to a player being hot or cold. A
 * hitter in a month-long slump kept the price his April earned him.
 *
 * ESPN's common-v3 gamelog endpoint fixes that in one request per athlete. It
 * returns a `names` array naming each column and a per-event `stats` array of
 * strings, which is why everything here is keyed by name rather than by index:
 * the column order differs between batters and pitchers, and would silently
 * mis-assign stats if it ever shifted.
 *
 * Events arrive newest-first, so the recent window is the head of the list.
 */
import type { StatLine } from "@/lib/pricing/engine";
import { getJson } from "./http";
import type { GameLogEntry } from "./types";

const SITE_ROOT = "https://site.web.api.espn.com/apis/common/v3/sports";

/** How many games count as "recent". */
export const RECENT_GAMES = { nba: 10, mlb: 15 } as const;

export interface GamelogDoc {
  names?: string[];
  labels?: string[];
  seasonTypes?: Array<{
    displayName?: string;
    categories?: Array<{
      events?: Array<{ eventId?: string; stats?: string[] }>;
    }>;
  }>;
  events?: Record<
    string,
    {
      gameDate?: string;
      /** Present on some leagues as "home"/"away". */
      homeAway?: string;
      /** Present on others as "vs" (home) or "@" (away). Both are read. */
      atVs?: string;
      opponent?: { abbreviation?: string; displayName?: string };
    }
  >;
}

interface Game {
  eventId: string;
  /** Column name → numeric value, with unparseable cells dropped. */
  stats: Map<string, number>;
  /** The raw cells too: some columns ("8-18", "2-1-0") are not single numbers. */
  raw: Map<string, string>;
  date: string | null;
  opponent: string | null;
  homeAway: "home" | "away" | null;
}

function num(v: string | undefined): number | null {
  if (v == null) return null;
  const t = v.trim();
  // ESPN writes an absent stat as "-", and a leading-dot average as ".290".
  if (t === "" || t === "-" || t === "--") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** "8-18" → [8, 18]. Used for made-attempted pairs. */
function pair(v: string | undefined): [number, number] | null {
  if (!v) return null;
  const parts = v.split("-").map((p) => Number(p.trim()));
  if (parts.length < 2 || parts.some((p) => !Number.isFinite(p))) return null;
  return [parts[0], parts[1]];
}

/**
 * Flatten the log to a newest-first list of games.
 *
 * Regular season and postseason arrive as separate `seasonTypes`, and both
 * count as recent form — a player in the playoffs has not stopped playing.
 */
function parseGames(doc: GamelogDoc): Game[] {
  const names = doc.names ?? [];
  if (names.length === 0) return [];

  const out: Game[] = [];
  for (const st of doc.seasonTypes ?? []) {
    for (const cat of st.categories ?? []) {
      for (const ev of cat.events ?? []) {
        const cells = ev.stats ?? [];
        if (!ev.eventId || cells.length === 0) continue;

        const stats = new Map<string, number>();
        const raw = new Map<string, string>();
        names.forEach((name, i) => {
          const cell = cells[i];
          if (cell == null) return;
          raw.set(name, cell);
          const n = num(cell);
          if (n != null) stats.set(name, n);
        });

        const meta = doc.events?.[ev.eventId];
        // Two spellings across leagues, and neither is guaranteed — an unknown
        // value stays null rather than defaulting to "home" and asserting
        // something false about where the game was played.
        const atVs = meta?.atVs?.trim().toLowerCase();
        const ha =
          meta?.homeAway ?? (atVs === "vs" ? "home" : atVs === "@" ? "away" : undefined);
        out.push({
          eventId: ev.eventId,
          stats,
          raw,
          date: meta?.gameDate ?? null,
          opponent: meta?.opponent?.abbreviation ?? meta?.opponent?.displayName ?? null,
          homeAway: ha === "home" || ha === "away" ? ha : null,
        });
      }
    }
  }

  // Two season types are each newest-first but not merged in order, so sort.
  out.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  return out;
}

function sum(games: Game[], name: string): number {
  return games.reduce((a, g) => a + (g.stats.get(name) ?? 0), 0);
}

/** NBA: counting stats sum, shooting percentage is recomputed from makes. */
function nbaLine(games: Game[]): StatLine {
  let made = 0;
  let attempted = 0;
  for (const g of games) {
    const fg = pair(g.raw.get("fieldGoalsMade-fieldGoalsAttempted"));
    if (fg) {
      made += fg[0];
      attempted += fg[1];
    }
  }

  return {
    gamesPlayed: games.length,
    points: sum(games, "points"),
    rebounds: sum(games, "totalRebounds"),
    assists: sum(games, "assists"),
    steals: sum(games, "steals"),
    blocks: sum(games, "blocks"),
    turnovers: sum(games, "turnovers"),
    minutes: sum(games, "minutes"),
    // Recomputed rather than averaged: a 1-for-1 night and a 8-for-20 night do
    // not average to the shooting that actually happened.
    fieldGoalPct: attempted > 0 ? (made / attempted) * 100 : undefined,
  };
}

/**
 * MLB batters.
 *
 * OPS is recomputed from the counting stats rather than read off the feed: the
 * feed's avg/OBP/SLG/OPS columns are season-to-date running totals, so taking
 * the latest one would report season form under the name "recent" — exactly the
 * number this window exists to avoid.
 */
function mlbBatterLine(games: Game[]): StatLine {
  const atBats = sum(games, "atBats");
  const hits = sum(games, "hits");
  const doubles = sum(games, "doubles");
  const triples = sum(games, "triples");
  const homeRuns = sum(games, "homeRuns");
  const walks = sum(games, "walks");
  const hbp = sum(games, "hitByPitch");

  const singles = Math.max(0, hits - doubles - triples - homeRuns);
  const totalBases = singles + doubles * 2 + triples * 3 + homeRuns * 4;
  // Sacrifice flies are not in this feed, so plate appearances are approximated.
  // The omission is small and applies equally to everyone.
  const plateAppearances = atBats + walks + hbp;

  const obp = plateAppearances > 0 ? (hits + walks + hbp) / plateAppearances : 0;
  const slg = atBats > 0 ? totalBases / atBats : 0;

  return {
    gamesPlayed: games.length,
    onBasePlusSlugging: obp + slg,
    homeRuns,
    runsBattedIn: sum(games, "RBIs"),
    stolenBases: sum(games, "stolenBases"),
    plateAppearances,
  };
}

/** MLB pitchers. ERA and WHIP are rate stats, so both are rebuilt over the window. */
function mlbPitcherLine(games: Game[]): StatLine {
  // "6.2" innings means six and two thirds, not six point two.
  let outs = 0;
  for (const g of games) {
    const raw = g.raw.get("innings");
    const n = num(raw);
    if (n == null) continue;
    const whole = Math.floor(n);
    const thirds = Math.round((n - whole) * 10);
    outs += whole * 3 + Math.min(thirds, 2);
  }
  const innings = outs / 3;

  const earnedRuns = sum(games, "earnedRuns");
  const hits = sum(games, "hits");
  const walks = sum(games, "walks");

  let saves = 0;
  for (const g of games) {
    const parts = (g.raw.get("saves-blownSaves-holds") ?? "").split("-");
    const s = Number(parts[0]);
    if (Number.isFinite(s)) saves += s;
  }

  return {
    gamesPlayed: games.length,
    isPitcher: true,
    inningsPitched: innings,
    earnedRunAverage: innings > 0 ? (earnedRuns * 9) / innings : undefined,
    whip: innings > 0 ? (walks + hits) / innings : undefined,
    pitcherStrikeouts: sum(games, "strikeouts"),
    saves,
  };
}

function summarize(sport: "nba" | "mlb", g: Game, isPitcher: boolean): string {
  if (sport === "nba") {
    const parts = [
      `${g.stats.get("points") ?? 0} pts`,
      `${g.stats.get("totalRebounds") ?? 0} reb`,
      `${g.stats.get("assists") ?? 0} ast`,
    ];
    return parts.join(" · ");
  }
  if (isPitcher) {
    return `${g.raw.get("innings") ?? "0"} IP · ${g.stats.get("earnedRuns") ?? 0} ER · ${
      g.stats.get("strikeouts") ?? 0
    } K`;
  }
  return `${g.stats.get("hits") ?? 0}-for-${g.stats.get("atBats") ?? 0} · ${
    g.stats.get("homeRuns") ?? 0
  } HR · ${g.stats.get("RBIs") ?? 0} RBI`;
}

export interface RecentForm {
  recent: StatLine | null;
  games: GameLogEntry[];
}

const EMPTY: RecentForm = { recent: null, games: [] };

/**
 * Recent form and a displayable game log, in one request.
 *
 * Returns empty rather than throwing on any failure. A missing recent window
 * costs a little price responsiveness for that athlete; an exception here would
 * cost the whole ingest, and this is the request most likely to fail because it
 * is the one made most often.
 */
export async function fetchRecentForm(
  sport: "nba" | "mlb",
  athleteId: string,
  opts: { isPitcher?: boolean; logLimit?: number } = {}
): Promise<RecentForm> {
  const path = sport === "nba" ? "basketball/nba" : "baseball/mlb";
  try {
    const doc = await getJson<GamelogDoc>(
      `${SITE_ROOT}/${path}/athletes/${athleteId}/gamelog`,
      { retries: 0 }
    );
    return recentFormFromDoc(sport, doc, opts);
  } catch {
    return EMPTY;
  }
}

/**
 * The pure half, split out so the parsing can be tested without a live feed.
 *
 * Worth isolating: everything that can go quietly wrong here — a column read by
 * the wrong name, a rate stat averaged instead of recomputed — produces a
 * plausible-looking number rather than an error.
 */
export function recentFormFromDoc(
  sport: "nba" | "mlb",
  doc: GamelogDoc,
  opts: { isPitcher?: boolean; logLimit?: number } = {}
): RecentForm {
  const games = parseGames(doc);
  if (games.length === 0) return EMPTY;

  const window = games.slice(0, RECENT_GAMES[sport]);
  const isPitcher = opts.isPitcher ?? false;
  const recent =
    sport === "nba" ? nbaLine(window) : isPitcher ? mlbPitcherLine(window) : mlbBatterLine(window);

  return {
    recent: recent.gamesPlayed > 0 ? recent : null,
    games: games.slice(0, opts.logLimit ?? 10).map((g) => ({
      date: g.date ?? "",
      opponent: g.opponent,
      homeAway: g.homeAway,
      summary: summarize(sport, g, isPitcher),
      headline:
        sport === "nba"
          ? (g.stats.get("points") ?? null)
          : isPitcher
            ? (g.stats.get("strikeouts") ?? null)
            : (g.stats.get("hits") ?? null),
    })),
  };
}
