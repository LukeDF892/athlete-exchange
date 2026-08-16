/**
 * MLB provider, backed by the same ESPN site API the NBA uses.
 *
 * Baseball needs its own module rather than another EspnProvider instance,
 * because an athlete's stats arrive under a different category depending on
 * what they do: batters get "career-batting", pitchers get "pitching". Which
 * block comes back is how we learn the role — the roster endpoint's position
 * string is unreliable for two-way and utility players.
 */
import type { Sport, StatLine } from "@/lib/pricing/engine";
import { getJson } from "./http";
import { fetchRecentForm } from "./gamelog";
import {
  ageFromBirthDate,
  type GameLogEntry,
  type RawPlayer,
  type SeasonLine,
  type SportsProvider,
  type StatTable,
} from "./types";

const CORE = "https://sports.core.api.espn.com/v2/sports/baseball/leagues/mlb";
const SITE = "https://site.web.api.espn.com/apis/common/v3/sports/baseball/mlb";
/** Active major-league rosters, as opposed to the whole farm system. */
const SITE_ROSTER = "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb";

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
}

interface SiteStats {
  categories?: Array<{
    name?: string;
    names?: string[];
    statistics?: Array<{
      season?: { year?: number };
      teamSlug?: string;
      stats?: string[];
    }>;
  }>;
}

/** 2026 -> "2026". Baseball seasons sit inside one calendar year. */
function seasonLabel(year: number): string {
  return String(year);
}

function slugToLabel(slug: string | undefined): string | null {
  if (!slug) return null;
  const last = slug.split("-").pop() ?? "";
  return last.slice(0, 3).toUpperCase() || null;
}

/**
 * Parse one season block into a StatLine.
 *
 * Baseball rate stats arrive as strings like ".302" and "3.41", and several are
 * *inverted* in meaning — a lower ERA is better — so they are carried through
 * as-is and the pricing engine handles the direction. Nothing is multiplied out
 * to totals the way basketball averages are, because the counting stats here
 * (home runs, RBIs, innings) are already season totals.
 */
function parseSeasons(doc: SiteStats | null | undefined): {
  seasons: SeasonLine[];
  isPitcher: boolean;
} {
  const cats = doc?.categories ?? [];
  const pitching = cats.find((c) => c.name === "pitching" || c.name === "career-pitching");
  const batting = cats.find((c) => c.name === "career-batting" || c.name === "batting");
  const cat = pitching ?? batting;
  const isPitcher = Boolean(pitching);

  if (!cat?.names || !cat.statistics) return { seasons: [], isPitcher };

  const idx = new Map(cat.names.map((n, i) => [n, i]));
  const num = (row: string[], key: string): number | undefined => {
    const i = idx.get(key);
    if (i == null) return undefined;
    const v = Number.parseFloat(row[i] ?? "");
    return Number.isFinite(v) ? v : undefined;
  };

  const byYear = new Map<number, SeasonLine>();
  for (const s of cat.statistics) {
    const year = s.season?.year;
    const row = s.stats;
    if (!year || !row) continue;

    const gp = num(row, "gamesPlayed");
    if (!gp || gp <= 0) continue;

    const stats: StatLine = isPitcher
      ? {
          gamesPlayed: gp,
          isPitcher: true,
          earnedRunAverage: num(row, "ERA"),
          whip: num(row, "WHIP"),
          inningsPitched: num(row, "innings"),
          pitcherStrikeouts: num(row, "strikeouts"),
          saves: num(row, "saves"),
          wins: num(row, "wins"),
        }
      : {
          gamesPlayed: gp,
          onBasePlusSlugging: num(row, "OPS"),
          homeRuns: num(row, "homeRuns"),
          runsBattedIn: num(row, "RBIs"),
          stolenBases: num(row, "stolenBases"),
          plateAppearances: num(row, "atBats"),
        };

    const line: SeasonLine = {
      year,
      label: seasonLabel(year),
      teamAbbrev: slugToLabel(s.teamSlug),
      stats,
    };
    const prev = byYear.get(year);
    if (!prev || gp > prev.stats.gamesPlayed) byYear.set(year, line);
  }

  return {
    seasons: [...byYear.values()].sort((a, b) => a.year - b.year),
    isPitcher,
  };
}

/** Trailing career line. Rate stats are averaged by games, totals summed. */
function sumSeasons(seasons: SeasonLine[], isPitcher: boolean): StatLine | null {
  if (seasons.length === 0) return null;
  const acc: StatLine = { gamesPlayed: 0, isPitcher };
  let weighted = 0;

  for (const s of seasons) {
    const t = s.stats;
    acc.gamesPlayed += t.gamesPlayed;
    if (isPitcher) {
      acc.inningsPitched = (acc.inningsPitched ?? 0) + (t.inningsPitched ?? 0);
      acc.pitcherStrikeouts = (acc.pitcherStrikeouts ?? 0) + (t.pitcherStrikeouts ?? 0);
      acc.saves = (acc.saves ?? 0) + (t.saves ?? 0);
      acc.wins = (acc.wins ?? 0) + (t.wins ?? 0);
      // ERA and WHIP are rates: weight by innings, which is what they are per.
      if (t.earnedRunAverage != null && t.inningsPitched) {
        acc.earnedRunAverage = (acc.earnedRunAverage ?? 0) + t.earnedRunAverage * t.inningsPitched;
        acc.whip = (acc.whip ?? 0) + (t.whip ?? 0) * t.inningsPitched;
        weighted += t.inningsPitched;
      }
    } else {
      acc.homeRuns = (acc.homeRuns ?? 0) + (t.homeRuns ?? 0);
      acc.runsBattedIn = (acc.runsBattedIn ?? 0) + (t.runsBattedIn ?? 0);
      acc.stolenBases = (acc.stolenBases ?? 0) + (t.stolenBases ?? 0);
      if (t.onBasePlusSlugging != null) {
        acc.onBasePlusSlugging = (acc.onBasePlusSlugging ?? 0) + t.onBasePlusSlugging * t.gamesPlayed;
        weighted += t.gamesPlayed;
      }
    }
  }

  if (acc.gamesPlayed <= 0) return null;
  if (weighted > 0) {
    if (isPitcher) {
      acc.earnedRunAverage = (acc.earnedRunAverage ?? 0) / weighted;
      acc.whip = (acc.whip ?? 0) / weighted;
    } else {
      acc.onBasePlusSlugging = (acc.onBasePlusSlugging ?? 0) / weighted;
    }
  }
  return acc;
}

function fmt(n: number | undefined, digits = 0): string {
  return n == null || !Number.isFinite(n) ? "—" : n.toFixed(digits);
}

function rowsFor(line: StatLine | null, isPitcher: boolean): Array<{ label: string; value: string }> {
  if (!line) return [];
  if (isPitcher) {
    const ip = line.inningsPitched ?? 0;
    return [
      { label: "G", value: fmt(line.gamesPlayed) },
      { label: "IP", value: fmt(ip, 1) },
      { label: "ERA", value: fmt(line.earnedRunAverage, 2) },
      { label: "WHIP", value: fmt(line.whip, 2) },
      { label: "SO", value: fmt(line.pitcherStrikeouts) },
      { label: "K/9", value: ip > 0 ? (((line.pitcherStrikeouts ?? 0) / ip) * 9).toFixed(1) : "—" },
      { label: "SV", value: fmt(line.saves) },
      { label: "W", value: fmt(line.wins) },
    ];
  }
  return [
    { label: "G", value: fmt(line.gamesPlayed) },
    { label: "OPS", value: line.onBasePlusSlugging?.toFixed(3).replace(/^0/, "") ?? "—" },
    { label: "HR", value: fmt(line.homeRuns) },
    { label: "RBI", value: fmt(line.runsBattedIn) },
    { label: "SB", value: fmt(line.stolenBases) },
    { label: "AB", value: fmt(line.plateAppearances) },
  ];
}

export class MlbProvider implements SportsProvider {
  readonly id = "espn-mlb";
  readonly sport: Sport = "mlb";
  private seasonCache: number | null = null;
  private readonly careerSeasons: number;

  constructor(opts: { careerSeasons?: number } = {}) {
    this.careerSeasons = opts.careerSeasons ?? 3;
  }

  /** Newest season that has actually been played, same guard as the NBA. */
  private async currentSeason(): Promise<number> {
    if (this.seasonCache != null) return this.seasonCache;
    const list = await getJson<EspnRefList>(`${CORE}/seasons?limit=6`);
    const years = (list.items ?? [])
      .map((i) => Number(i.$ref?.match(/seasons\/(\d{4})/)?.[1]))
      .filter((y) => Number.isFinite(y))
      .sort((a, b) => b - a);

    for (const y of years) {
      try {
        await getJson(`${CORE}/seasons/${y}/types/2/leaders`, { retries: 0 });
        this.seasonCache = y;
        return y;
      } catch {
        // Season exists on the calendar but no games played yet.
      }
    }
    const fallback = years[0] ?? new Date().getFullYear();
    this.seasonCache = fallback;
    return fallback;
  }

  /**
   * The 30 active major-league rosters.
   *
   * Baseball needs a different source from the other leagues. The core API's
   * team "athletes" collection is the entire *organisation* — around 250 people
   * per club, almost all of them in the minors — so 30 clubs come to roughly
   * 7,500 ids. Fetching the first slice of that dropped Ohtani, Judge and Soto
   * from the board entirely: they were simply outside the window, and nothing
   * failed loudly enough to notice.
   *
   * The site API's roster endpoint returns the ~28 players actually on the
   * major-league roster, grouped by position. That is both the correct
   * population and two orders of magnitude cheaper to fetch.
   */
  async listPlayerIds(limit: number): Promise<string[]> {
    const season = await this.currentSeason();
    const teams = await getJson<EspnRefList>(`${CORE}/seasons/${season}/teams?limit=40`);
    const teamIds = (teams.items ?? [])
      .map((t) => t.$ref?.match(/teams\/(\d+)/)?.[1])
      .filter((v): v is string => Boolean(v));

    const ids: string[] = [];
    for (const teamId of teamIds) {
      try {
        const roster = await getJson<{
          athletes?: Array<{ items?: Array<{ id?: string }> }>;
        }>(`${SITE_ROSTER}/teams/${teamId}/roster`, { retries: 1 });

        for (const group of roster.athletes ?? []) {
          for (const a of group.items ?? []) {
            if (a.id) ids.push(String(a.id));
          }
        }
      } catch {
        // One unreachable club should not take the league down.
      }
    }

    // An active roster excludes anyone on the injured list — clubs literally
    // take them off it — so Aaron Judge (60-day IL) and Juan Soto (10-day IL)
    // were absent from every roster despite being two of the sport's biggest
    // names. Delisting an injured star is the wrong answer for a market: you
    // should be able to buy the dip, and the injury pricing already discounts
    // them correctly. It just never got the chance.
    //
    // Nothing cheaper works. The injury feed names them but carries no athlete
    // ids, so it cannot be joined. The league-wide `active=true` list excludes
    // them by definition — ESPN marks an injured player inactive. Only the full
    // organisation roster has everyone, and Judge sits on its second page,
    // which is exactly what reading the first 60 entries missed.
    ids.push(...(await this.organisationAthleteIds(season, teamIds)));

    return Array.from(new Set(ids)).slice(0, limit);
  }

  /**
   * Every athlete in every organisation, injured list included.
   *
   * Roughly 250 per club, so ~7,500 league-wide. Most are minor-leaguers that
   * fetchPlayer discards for having no major-league season, which makes this
   * wasteful but correct — and correctness matters more here, because the
   * players it recovers are precisely the famous injured ones.
   */
  private async organisationAthleteIds(season: number, teamIds: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const teamId of teamIds) {
      for (let page = 1; page <= 4; page++) {
        try {
          const doc = await getJson<EspnRefList & { pageCount?: number }>(
            `${CORE}/seasons/${season}/teams/${teamId}/athletes?limit=100&page=${page}`,
            { retries: 1 }
          );
          const items = doc.items ?? [];
          for (const a of items) {
            const id = a.$ref?.match(/athletes\/(\d+)/)?.[1];
            if (id) out.push(id);
          }
          if (items.length < 100 || page >= (doc.pageCount ?? 1)) break;
        } catch {
          break;
        }
      }
    }
    return out;
  }

  async fetchPlayer(externalId: string): Promise<RawPlayer | null> {
    const athleteId = externalId.replace(/^espn-mlb:/, "");
    const season = await this.currentSeason();

    const athlete = await getJson<EspnAthlete>(
      `${CORE}/seasons/${season}/athletes/${athleteId}`
    ).catch(() => null);
    if (!athlete?.id) return null;
    const fullName = athlete.fullName ?? athlete.displayName ?? "";
    if (!fullName) return null;

    const doc = await getJson<SiteStats>(`${SITE}/athletes/${athleteId}/stats`, {
      retries: 1,
    }).catch(() => null);
    const { seasons, isPitcher } = parseSeasons(doc);
    if (seasons.length === 0) return null;

    const latest = seasons[seasons.length - 1];
    const careerLine = sumSeasons(seasons.slice(-(this.careerSeasons + 1)), isPitcher);

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
        // Cosmetic only.
      }
    }

    // One request buys both the short-term window the price blend wants and
    // the per-game log the player page shows.
    const form = await fetchRecentForm("mlb", String(athlete.id), { isPitcher });

    const statTables: StatTable[] = [
      ...(form.recent
        ? [
            {
              window: "recent" as const,
              label: `Last ${form.recent.gamesPlayed}`,
              rows: rowsFor(form.recent, isPitcher),
            },
          ]
        : []),
      { window: "season", label: latest.label, rows: rowsFor(latest.stats, isPitcher) },
      { window: "career", label: "Recent career", rows: rowsFor(careerLine, isPitcher) },
    ];

    return {
      externalId: `espn-mlb:${athlete.id}`,
      sport: "mlb",
      firstName: athlete.firstName ?? fullName.split(" ")[0] ?? "",
      lastName: athlete.lastName ?? fullName.split(" ").slice(1).join(" "),
      fullName,
      // The stat block is more reliable than the roster position for two-way
      // and utility players, so it wins when the two disagree.
      position: isPitcher ? athlete.position?.abbreviation ?? "P" : athlete.position?.abbreviation ?? null,
      jersey: athlete.jersey ?? null,
      teamAbbrev,
      teamName,
      headshotUrl: athlete.headshot?.href ?? null,
      birthDate: athlete.dateOfBirth ?? null,
      ageYears: ageFromBirthDate(athlete.dateOfBirth),
      // Reusing the goalie flag as "this athlete plays the specialist role in
      // their sport" keeps positionGroup() a single switch across three leagues.
      isGoalie: isPitcher,
      recent: form.recent,
      season: latest.stats,
      career: careerLine,
      careerSeasons: seasons,
      statTables,
      gameLog: form.games,
    };
  }

  async fetchGameLog(externalId: string, limit: number): Promise<GameLogEntry[]> {
    const athleteId = externalId.replace(/^espn-mlb:/, "");
    const { games } = await fetchRecentForm("mlb", athleteId, { logLimit: limit });
    return games;
  }
}

export const mlbProvider = new MlbProvider();
