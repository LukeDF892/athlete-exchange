/**
 * ESPN "core" API provider — currently how we get the NBA.
 *
 * Context for whoever swaps this out later: the NBA has no open official feed.
 * stats.nba.com and cdn.nba.com both refuse datacenter IPs (Akamai 403), and
 * balldontlie now requires a key. ESPN answers cleanly and, via its site API,
 * returns an athlete's entire season-by-season career in one request — which is
 * what makes both the career value chart and a full-league board affordable.
 *
 * It is unofficial and undocumented. Treat every field as optional and expect
 * to move to a paid feed if this app gets real traffic — which is exactly why
 * everything here hides behind SportsProvider.
 */
import type { Sport, StatLine } from "@/lib/pricing/engine";
import { getJson, mapPool } from "./http";
import { fetchRecentForm } from "./gamelog";
import {
  ageFromBirthDate,
  type GameLogEntry,
  type RawPlayer,
  type SeasonLine,
  type SportsProvider,
  type StatTable,
} from "./types";

const ROOT = "https://sports.core.api.espn.com/v2/sports";

/**
 * ESPN's public "site" API. One request here returns every season an athlete
 * has played, which is both how the career value chart gets its data and why
 * listing every rostered player is affordable — it replaces one request per
 * prior season with a single call.
 */
const SITE_ROOT = "https://site.web.api.espn.com/apis/common/v3/sports";

interface EspnSiteStats {
  categories?: Array<{
    name?: string;
    names?: string[];
    statistics?: Array<{
      season?: { year?: number; displayName?: string };
      teamSlug?: string;
      stats?: string[];
    }>;
  }>;
}

/** "cleveland-cavaliers" -> "CLE"-ish label. Cosmetic only. */
function slugToLabel(slug: string | undefined): string | null {
  if (!slug) return null;
  const words = slug.split("-");
  const last = words[words.length - 1] ?? "";
  return last.slice(0, 3).toUpperCase() || null;
}

/** 2026 -> "2025-26", matching how basketball seasons are written. */
function seasonLabel(year: number): string {
  const start = year - 1;
  return `${start}-${String(year % 100).padStart(2, "0")}`;
}

interface EspnRefList {
  count?: number;
  items?: Array<{ $ref?: string }>;
}

interface EspnAthlete {
  id?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  displayName?: string;
  jersey?: string;
  dateOfBirth?: string;
  headshot?: { href?: string };
  position?: { abbreviation?: string; displayName?: string };
  team?: { $ref?: string };
  active?: boolean;
}



/**
 * Parse the site API's per-season averages into season totals.
 *
 * ESPN reports this category as per-game averages, while StatLine everywhere
 * else is season totals, so each rate is multiplied back up by games played.
 * The one-decimal averages cost a little precision, which is immaterial at the
 * scale these feed into a production score.
 */
function parseCareerSeasons(doc: EspnSiteStats | null | undefined): SeasonLine[] {
  const averages = (doc?.categories ?? []).find((c) => c.name === "averages");
  if (!averages?.names || !averages.statistics) return [];

  const idx = new Map(averages.names.map((n, i) => [n, i]));
  const num = (row: string[], key: string): number | undefined => {
    const i = idx.get(key);
    if (i == null) return undefined;
    const v = Number.parseFloat(row[i] ?? "");
    return Number.isFinite(v) ? v : undefined;
  };

  const out: SeasonLine[] = [];
  for (const s of averages.statistics) {
    const year = s.season?.year;
    const row = s.stats;
    if (!year || !row) continue;

    const gp = num(row, "gamesPlayed");
    if (!gp || gp <= 0) continue;

    const total = (key: string) => {
      const avg = num(row, key);
      return avg == null ? undefined : avg * gp;
    };

    out.push({
      year,
      label: seasonLabel(year),
      teamAbbrev: slugToLabel(s.teamSlug),
      stats: {
        gamesPlayed: gp,
        points: total("avgPoints"),
        rebounds: total("avgRebounds"),
        assists: total("avgAssists"),
        steals: total("avgSteals"),
        blocks: total("avgBlocks"),
        turnovers: total("avgTurnovers"),
        minutes: total("avgMinutes"),
        fieldGoalPct: num(row, "fieldGoalPct"),
      },
    });
  }

  // ESPN can emit one row per team in a traded season; keep the fuller one.
  const byYear = new Map<number, SeasonLine>();
  for (const s of out) {
    const prev = byYear.get(s.year);
    if (!prev || s.stats.gamesPlayed > prev.stats.gamesPlayed) byYear.set(s.year, s);
  }
  return [...byYear.values()].sort((a, b) => a.year - b.year);
}

/** Sum season totals into a single trailing-career line. */
function sumSeasons(seasons: SeasonLine[]): StatLine | null {
  if (seasons.length === 0) return null;
  const acc: StatLine = { gamesPlayed: 0 };
  let fgWeighted = 0;
  for (const s of seasons) {
    const t = s.stats;
    acc.gamesPlayed += t.gamesPlayed;
    for (const k of ["points", "rebounds", "assists", "steals", "blocks", "turnovers", "minutes"] as const) {
      if (t[k] != null) acc[k] = (acc[k] ?? 0) + (t[k] as number);
    }
    if (t.fieldGoalPct != null) fgWeighted += t.fieldGoalPct * t.gamesPlayed;
  }
  if (acc.gamesPlayed <= 0) return null;
  acc.fieldGoalPct = fgWeighted > 0 ? fgWeighted / acc.gamesPlayed : undefined;
  return acc;
}

function fmt(n: number | undefined, digits = 0): string {
  return n == null || !Number.isFinite(n) ? "—" : n.toFixed(digits);
}

function basketballRowsFromLine(
  line: StatLine | null
): Array<{ label: string; value: string }> {
  if (!line) return [];
  const gp = line.gamesPlayed;
  const pg = (v: number | undefined, digits = 1) =>
    v == null || !gp ? "—" : (v / gp).toFixed(digits);
  return [
    { label: "GP", value: fmt(gp) },
    { label: "PPG", value: pg(line.points) },
    { label: "RPG", value: pg(line.rebounds) },
    { label: "APG", value: pg(line.assists) },
    { label: "SPG", value: pg(line.steals) },
    { label: "BPG", value: pg(line.blocks) },
    { label: "TOPG", value: pg(line.turnovers) },
    { label: "MPG", value: pg(line.minutes) },
    { label: "FG%", value: fmt(line.fieldGoalPct, 1) },
  ];
}

export interface EspnProviderOptions {
  sport: Sport;
  /** ESPN path segment pair, e.g. ["basketball", "nba"]. */
  path: [string, string];
  /** How many prior seasons to fold into the career line. */
  careerSeasons?: number;
}

export class EspnProvider implements SportsProvider {
  readonly id: string;
  readonly sport: Sport;
  private readonly base: string;
  private readonly careerSeasons: number;
  private seasonCache: number | null = null;

  constructor(private readonly opts: EspnProviderOptions) {
    this.sport = opts.sport;
    this.id = `espn-${opts.path[1]}`;
    this.base = `${ROOT}/${opts.path[0]}/leagues/${opts.path[1]}`;
    this.careerSeasons = opts.careerSeasons ?? 3;
  }

  /**
   * Newest season that has actually been PLAYED.
   *
   * A season row exists on ESPN as soon as it is scheduled, so the newest id is
   * usually a season with a full set of teams and zero statistics — which
   * silently yields an empty exchange. The `leaders` endpoint is the reliable
   * discriminator: it 404s until real games have been played.
   */
  private async currentSeason(): Promise<number> {
    if (this.seasonCache != null) return this.seasonCache;
    const list = await getJson<EspnRefList>(`${this.base}/seasons?limit=6`);
    const years = (list.items ?? [])
      .map((i) => Number(i.$ref?.match(/seasons\/(\d{4})/)?.[1]))
      .filter((y) => Number.isFinite(y))
      .sort((a, b) => b - a);

    for (const year of years) {
      try {
        await getJson(`${this.base}/seasons/${year}/types/2/leaders`, { retries: 0 });
        this.seasonCache = year;
        return year;
      } catch {
        // 404 => not played yet; step back a season
      }
    }
    const fallback = years[0] ?? new Date().getFullYear();
    this.seasonCache = fallback;
    return fallback;
  }

  /**
   * Athlete ids ordered by production, using the season leaderboards. Without
   * this the roster order is arbitrary and a capped ingest would list benchwarmers
   * while missing MVPs.
   */
  private async leaderAthleteIds(season: number): Promise<string[]> {
    try {
      const doc = await getJson<{
        categories?: Array<{ name?: string; leaders?: Array<{ athlete?: { $ref?: string } }> }>;
      }>(`${this.base}/seasons/${season}/types/2/leaders`, { retries: 1 });

      const ranked: string[] = [];
      for (const cat of doc.categories ?? []) {
        for (const leader of cat.leaders ?? []) {
          const id = leader.athlete?.$ref?.match(/athletes\/(\d+)/)?.[1];
          if (id) ranked.push(id);
        }
      }
      return ranked;
    } catch {
      return [];
    }
  }

  async listPlayerIds(limit: number): Promise<string[]> {
    const season = await this.currentSeason();
    const teams = await getJson<EspnRefList>(`${this.base}/seasons/${season}/teams?limit=64`);
    const teamIds = (teams.items ?? [])
      .map((i) => i.$ref?.match(/teams\/(\d+)/)?.[1])
      .filter((v): v is string => Boolean(v));

    const rosters = await mapPool(teamIds, 6, async (teamId) => {
      const list = await getJson<EspnRefList>(
        `${this.base}/seasons/${season}/teams/${teamId}/athletes?limit=40`
      );
      return (list.items ?? [])
        .map((i) => i.$ref?.match(/athletes\/(\d+)/)?.[1])
        .filter((v): v is string => Boolean(v));
    });

    const rosterIds: string[] = [];
    for (const r of rosters) if (r.ok) rosterIds.push(...r.value);

    // Leaders first so a capped ingest lists the players people want to trade,
    // then everyone else on a roster to fill out the board.
    const leaders = await this.leaderAthleteIds(season);
    const rosterSet = new Set(rosterIds);
    const ordered = [...leaders.filter((id) => rosterSet.has(id)), ...rosterIds];
    return Array.from(new Set(ordered)).slice(0, limit);
  }

  async fetchPlayer(externalId: string): Promise<RawPlayer | null> {
    const athleteId = externalId.replace(/^espn-[a-z]+:/, "");
    const season = await this.currentSeason();

    const athlete = await getJson<EspnAthlete>(
      `${this.base}/seasons/${season}/athletes/${athleteId}`
    );
    if (!athlete?.id) return null;
    const fullName = athlete.fullName ?? athlete.displayName ?? "";
    if (!fullName) return null;

    // One request for the athlete's entire career, oldest season first.
    const careerDoc = await getJson<EspnSiteStats>(
      `${SITE_ROOT}/${this.opts.path[0]}/${this.opts.path[1]}/athletes/${athleteId}/stats`,
      { retries: 1 }
    ).catch(() => null);
    const careerSeasons = parseCareerSeasons(careerDoc);

    // A player with no completed season has never appeared — not worth listing.
    if (careerSeasons.length === 0) return null;

    const latest = careerSeasons[careerSeasons.length - 1];
    const seasonLine = latest.stats;
    // Trailing body of work: the most recent few seasons, not lifetime totals.
    const careerLine = sumSeasons(careerSeasons.slice(-(this.careerSeasons + 1)));

    let teamAbbrev: string | null = null;
    let teamName: string | null = null;
    if (athlete.team?.$ref) {
      try {
        const team = await getJson<{ abbreviation?: string; displayName?: string }>(
          athlete.team.$ref.replace(/^http:/, "https:"),
          { retries: 1 }
        );
        teamAbbrev = team.abbreviation ?? null;
        teamName = team.displayName ?? null;
      } catch {
        // team is cosmetic; a miss should not drop the player
      }
    }

    // One extra request buys both the short-term window the price blend wants
    // and the per-game log the player page shows. Only basketball has a parser
    // here; the NHL comes through its own provider with a richer feed.
    const form =
      this.sport === "nba"
        ? await fetchRecentForm("nba", String(athlete.id))
        : { recent: null, games: [] };

    const statTables: StatTable[] = [
      ...(form.recent
        ? [
            {
              window: "recent" as const,
              label: `Last ${form.recent.gamesPlayed}`,
              rows: basketballRowsFromLine(form.recent),
            },
          ]
        : []),
      { window: "season", label: latest.label, rows: basketballRowsFromLine(seasonLine) },
      { window: "career", label: "Recent career", rows: basketballRowsFromLine(careerLine) },
    ];

    return {
      externalId: `${this.id}:${athlete.id}`,
      sport: this.sport,
      firstName: athlete.firstName ?? fullName.split(" ")[0] ?? "",
      lastName: athlete.lastName ?? fullName.split(" ").slice(1).join(" "),
      fullName,
      position: athlete.position?.abbreviation ?? athlete.position?.displayName ?? null,
      jersey: athlete.jersey ?? null,
      teamAbbrev,
      teamName,
      headshotUrl: athlete.headshot?.href ?? null,
      birthDate: athlete.dateOfBirth ?? null,
      ageYears: ageFromBirthDate(athlete.dateOfBirth),
      isGoalie: false,
      // Null when the log is unavailable or the player has not appeared yet.
      // fairValue renormalizes its weights around a missing window, so this
      // degrades cleanly rather than skewing the price.
      recent: form.recent,
      season: seasonLine,
      career: careerLine,
      careerSeasons,
      statTables,
      gameLog: form.games,
    };
  }

  async fetchGameLog(externalId: string, limit: number): Promise<GameLogEntry[]> {
    if (this.sport !== "nba") return [];
    const athleteId = externalId.replace(/^espn-[a-z]+:/, "");
    const { games } = await fetchRecentForm("nba", athleteId, { logLimit: limit });
    return games;
  }
}

export const nbaProvider = new EspnProvider({ sport: "nba", path: ["basketball", "nba"] });
export const nhlEspnProvider = new EspnProvider({ sport: "nhl", path: ["hockey", "nhl"] });
