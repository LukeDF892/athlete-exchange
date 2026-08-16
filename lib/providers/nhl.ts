/**
 * NHL provider, backed by the league's own public API (api-web.nhle.com).
 *
 * This is the good case: no key, no quota, and one endpoint per player returns
 * season totals, career totals, and the last five games together.
 */
import type { Sport, StatLine } from "@/lib/pricing/engine";
import { getJson, mapPool } from "./http";
import {
  ageFromBirthDate,
  parseTimeOnIce,
  type GameLogEntry,
  type RawPlayer,
  type SeasonLine,
  type SportsProvider,
  type StatTable,
} from "./types";

const BASE = "https://api-web.nhle.com/v1";

interface NhlRosterPlayer {
  id: number;
  firstName?: { default?: string };
  lastName?: { default?: string };
  positionCode?: string;
  sweaterNumber?: number;
  headshot?: string;
  birthDate?: string;
}

interface NhlRoster {
  forwards?: NhlRosterPlayer[];
  defensemen?: NhlRosterPlayer[];
  goalies?: NhlRosterPlayer[];
}

interface NhlSkaterTotals {
  gamesPlayed?: number;
  goals?: number;
  assists?: number;
  points?: number;
  plusMinus?: number;
  shots?: number;
  pim?: number;
  avgToi?: string;
  powerPlayGoals?: number;
  shootingPctg?: number;
  // Goalie fields
  savePctg?: number;
  goalsAgainstAvg?: number;
  wins?: number;
  losses?: number;
  shutouts?: number;
}

interface NhlGame {
  gameDate?: string;
  opponentAbbrev?: string;
  homeRoadFlag?: string;
  goals?: number;
  assists?: number;
  points?: number;
  plusMinus?: number;
  shots?: number;
  toi?: string;
  // Goalie
  savePctg?: number;
  shotsAgainst?: number;
  goalsAgainst?: number;
  decision?: string;
}

interface NhlLanding {
  playerId: number;
  isActive?: boolean;
  firstName?: { default?: string };
  lastName?: { default?: string };
  position?: string;
  sweaterNumber?: number;
  headshot?: string;
  birthDate?: string;
  currentTeamAbbrev?: string;
  fullTeamName?: { default?: string };
  featuredStats?: {
    regularSeason?: { subSeason?: NhlSkaterTotals; career?: NhlSkaterTotals };
  };
  careerTotals?: { regularSeason?: NhlSkaterTotals };
  last5Games?: NhlGame[];
  /** Every season the player has appeared in, across all leagues they played. */
  seasonTotals?: NhlSeasonTotal[];
}

interface NhlSeasonTotal {
  /** 20252026 for the 2025-26 season. */
  season?: number;
  /** 2 = regular season, 3 = playoffs. */
  gameTypeId?: number;
  leagueAbbrev?: string;
  teamName?: { default?: string };
  gamesPlayed?: number;
  goals?: number;
  assists?: number;
  points?: number;
  plusMinus?: number;
  shots?: number;
  avgToi?: string;
  savePctg?: number;
  wins?: number;
  goalsAgainstAvg?: number;
}

/** 20252026 -> "2025-26". */
function nhlSeasonLabel(season: number): string {
  const start = Math.floor(season / 10000);
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/**
 * Career history from the landing payload — no extra request needed.
 *
 * Filtered to NHL regular seasons: seasonTotals also carries junior, college
 * and international play, which would otherwise put a 60-point WHL season on
 * the same chart as NHL production.
 */
function parseNhlCareerSeasons(landing: NhlLanding, isGoalie: boolean): SeasonLine[] {
  const rows = (landing.seasonTotals ?? []).filter(
    (s) => s.leagueAbbrev === "NHL" && s.gameTypeId === 2 && (s.gamesPlayed ?? 0) > 0
  );

  const byYear = new Map<number, SeasonLine>();
  for (const s of rows) {
    if (!s.season) continue;
    const year = Math.floor(s.season / 10000) + 1;
    const gp = s.gamesPlayed ?? 0;
    const toi = parseTimeOnIce(s.avgToi);

    const line: SeasonLine = {
      year,
      label: nhlSeasonLabel(s.season),
      teamAbbrev: s.teamName?.default ?? null,
      stats: {
        gamesPlayed: gp,
        isGoalie,
        goals: s.goals,
        hockeyAssists: s.assists,
        plusMinus: s.plusMinus,
        shots: s.shots,
        // StatLine holds totals; time on ice is reported as a per-game average.
        timeOnIcePerGame: toi == null ? undefined : toi * gp,
        savePct: s.savePctg,
        wins: s.wins,
        goalsAgainstAverage: s.goalsAgainstAvg,
      },
    };

    // Traded mid-season produces one row per team; keep the fuller one.
    const prev = byYear.get(year);
    if (!prev || gp > prev.stats.gamesPlayed) byYear.set(year, line);
  }
  return [...byYear.values()].sort((a, b) => a.year - b.year);
}

/** Teams change (relocation, expansion), so read the live standings rather
 *  than hardcoding a list that silently goes stale. */
async function fetchTeamAbbrevs(): Promise<string[]> {
  const data = await getJson<{ standings?: Array<{ teamAbbrev?: { default?: string } }> }>(
    `${BASE}/standings/now`
  );
  const abbrevs = (data.standings ?? [])
    .map((row) => row.teamAbbrev?.default)
    .filter((a): a is string => Boolean(a));
  return Array.from(new Set(abbrevs));
}

async function fetchCurrentSeasonId(): Promise<string> {
  try {
    const seasons = await getJson<number[]>(`${BASE}/season`);
    if (Array.isArray(seasons) && seasons.length > 0) {
      return String(seasons[seasons.length - 1]);
    }
  } catch {
    // fall through to a computed guess
  }
  // NHL seasons start in October: before October we are still in last year's season.
  const now = new Date();
  const startYear = now.getMonth() >= 9 ? now.getFullYear() : now.getFullYear() - 1;
  return `${startYear}${startYear + 1}`;
}

function skaterLine(t: NhlSkaterTotals | undefined, isGoalie: boolean): StatLine | null {
  if (!t || !t.gamesPlayed) return null;
  if (isGoalie) {
    return {
      gamesPlayed: t.gamesPlayed,
      savePct: t.savePctg,
      goalsAgainstAverage: t.goalsAgainstAvg,
      wins: t.wins,
      isGoalie: true,
    };
  }
  const toiPerGame = parseTimeOnIce(t.avgToi);
  return {
    gamesPlayed: t.gamesPlayed,
    goals: t.goals,
    hockeyAssists: t.assists,
    plusMinus: t.plusMinus,
    shots: t.shots,
    // StatLine treats totals as season-wide, so scale the per-game average back up.
    timeOnIcePerGame: toiPerGame != null ? toiPerGame * t.gamesPlayed : undefined,
  };
}

function aggregateRecent(games: NhlGame[] | undefined, isGoalie: boolean): StatLine | null {
  if (!games || games.length === 0) return null;
  if (isGoalie) {
    const withSaves = games.filter((g) => typeof g.savePctg === "number");
    if (withSaves.length === 0) return null;
    const avg = withSaves.reduce((a, g) => a + (g.savePctg ?? 0), 0) / withSaves.length;
    return { gamesPlayed: withSaves.length, savePct: avg, isGoalie: true };
  }
  const sum = (pick: (g: NhlGame) => number | undefined) =>
    games.reduce((a, g) => a + (pick(g) ?? 0), 0);
  const toiTotal = games.reduce((a, g) => a + (parseTimeOnIce(g.toi) ?? 0), 0);
  return {
    gamesPlayed: games.length,
    goals: sum((g) => g.goals),
    hockeyAssists: sum((g) => g.assists),
    plusMinus: sum((g) => g.plusMinus),
    shots: sum((g) => g.shots),
    timeOnIcePerGame: toiTotal,
  };
}

function fmt(n: number | undefined | null, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

function buildStatTables(landing: NhlLanding, isGoalie: boolean): StatTable[] {
  const season = landing.featuredStats?.regularSeason?.subSeason;
  const career = landing.careerTotals?.regularSeason;
  const tables: StatTable[] = [];

  const rowsFor = (t: NhlSkaterTotals | undefined) => {
    if (!t) return [];
    if (isGoalie) {
      return [
        { label: "GP", value: fmt(t.gamesPlayed) },
        { label: "W", value: fmt(t.wins) },
        { label: "SV%", value: t.savePctg != null ? t.savePctg.toFixed(3) : "—" },
        { label: "GAA", value: fmt(t.goalsAgainstAvg, 2) },
        { label: "SO", value: fmt(t.shutouts) },
      ];
    }
    const gp = t.gamesPlayed ?? 0;
    return [
      { label: "GP", value: fmt(t.gamesPlayed) },
      { label: "G", value: fmt(t.goals) },
      { label: "A", value: fmt(t.assists) },
      { label: "PTS", value: fmt(t.points) },
      { label: "P/GP", value: gp > 0 ? ((t.points ?? 0) / gp).toFixed(2) : "—" },
      { label: "+/-", value: fmt(t.plusMinus) },
      { label: "SOG", value: fmt(t.shots) },
      { label: "TOI", value: t.avgToi ?? "—" },
    ];
  };

  if (season) tables.push({ window: "season", label: "Season", rows: rowsFor(season) });
  if (career) tables.push({ window: "career", label: "Career", rows: rowsFor(career) });

  const games = landing.last5Games ?? [];
  if (games.length > 0) {
    const recentAgg = aggregateRecent(games, isGoalie);
    if (recentAgg) {
      tables.push({
        window: "recent",
        label: `Last ${games.length}`,
        rows: isGoalie
          ? [
              { label: "GP", value: fmt(recentAgg.gamesPlayed) },
              {
                label: "SV%",
                value: recentAgg.savePct != null ? recentAgg.savePct.toFixed(3) : "—",
              },
            ]
          : [
              { label: "GP", value: fmt(recentAgg.gamesPlayed) },
              { label: "G", value: fmt(recentAgg.goals) },
              { label: "A", value: fmt(recentAgg.hockeyAssists) },
              {
                label: "PTS",
                value: fmt((recentAgg.goals ?? 0) + (recentAgg.hockeyAssists ?? 0)),
              },
              { label: "+/-", value: fmt(recentAgg.plusMinus) },
            ],
      });
    }
  }
  return tables;
}

export class NhlProvider implements SportsProvider {
  readonly id = "nhl-official";
  readonly sport: Sport = "nhl";

  /**
   * League leaders, used to order the roster by notability.
   *
   * Without this the roster is ordered by team standings position, so a capped
   * ingest silently cut Connor McDavid — the best player in the league — while
   * listing fourth-liners from whichever teams happened to sort first.
   */
  private async leaderIds(): Promise<string[]> {
    const categories: Array<[string, string]> = [
      ["skater-stats-leaders", "points"],
      ["skater-stats-leaders", "goals"],
      ["skater-stats-leaders", "assists"],
      ["goalie-stats-leaders", "wins"],
      ["goalie-stats-leaders", "savePctg"],
    ];

    const ranked: string[] = [];
    const results = await mapPool(categories, 3, async ([path, category]) => {
      const doc = await getJson<Record<string, Array<{ id?: number }>>>(
        `${BASE}/${path}/current?categories=${category}&limit=100`,
        { retries: 1 }
      );
      return (doc[category] ?? []).map((p) => p.id).filter((id): id is number => id != null);
    });

    for (const r of results) {
      if (r.ok) ranked.push(...r.value.map(String));
    }
    return ranked;
  }

  async listPlayerIds(limit: number): Promise<string[]> {
    const [abbrevs, season] = await Promise.all([fetchTeamAbbrevs(), fetchCurrentSeasonId()]);

    // Pull rosters team by team. A small pool keeps us well under any rate
    // limiting; there are only ~32 teams.
    const results = await mapPool(abbrevs, 6, async (abbrev) => {
      const roster = await getJson<NhlRoster>(`${BASE}/roster/${abbrev}/${season}`);
      return [...(roster.forwards ?? []), ...(roster.defensemen ?? []), ...(roster.goalies ?? [])];
    });

    const rosterIds: string[] = [];
    for (const r of results) {
      if (!r.ok) continue;
      for (const p of r.value) if (p.id) rosterIds.push(String(p.id));
    }

    const leaders = await this.leaderIds();
    const rosterSet = new Set(rosterIds);
    const ordered = [...leaders.filter((id) => rosterSet.has(id)), ...rosterIds];
    return Array.from(new Set(ordered)).slice(0, limit);
  }

  async fetchPlayer(externalId: string): Promise<RawPlayer | null> {
    const id = externalId.replace(/^nhl:/, "");
    const landing = await getJson<NhlLanding>(`${BASE}/player/${id}/landing`);
    if (!landing?.playerId) return null;

    const isGoalie = landing.position === "G";
    const first = landing.firstName?.default ?? "";
    const last = landing.lastName?.default ?? "";
    if (!first && !last) return null;

    const season = skaterLine(landing.featuredStats?.regularSeason?.subSeason, isGoalie);
    const career = skaterLine(landing.careerTotals?.regularSeason, isGoalie);
    const recent = aggregateRecent(landing.last5Games, isGoalie);
    const careerSeasons = parseNhlCareerSeasons(landing, isGoalie);

    return {
      externalId: `nhl:${landing.playerId}`,
      sport: "nhl",
      firstName: first,
      lastName: last,
      fullName: `${first} ${last}`.trim(),
      position: landing.position ?? null,
      jersey: landing.sweaterNumber != null ? String(landing.sweaterNumber) : null,
      teamAbbrev: landing.currentTeamAbbrev ?? null,
      teamName: landing.fullTeamName?.default ?? null,
      headshotUrl: landing.headshot ?? null,
      birthDate: landing.birthDate ?? null,
      ageYears: ageFromBirthDate(landing.birthDate),
      isGoalie,
      recent,
      season,
      career,
      careerSeasons,
      statTables: buildStatTables(landing, isGoalie),
    };
  }

  async fetchGameLog(externalId: string, limit: number): Promise<GameLogEntry[]> {
    const id = externalId.replace(/^nhl:/, "");
    const landing = await getJson<NhlLanding>(`${BASE}/player/${id}/landing`);
    const isGoalie = landing.position === "G";
    return (landing.last5Games ?? []).slice(0, limit).map((g) => ({
      date: g.gameDate ?? "",
      opponent: g.opponentAbbrev ?? null,
      homeAway: g.homeRoadFlag === "H" ? "home" : g.homeRoadFlag === "R" ? "away" : null,
      summary: isGoalie
        ? `${g.decision ?? "—"} · ${g.savePctg != null ? g.savePctg.toFixed(3) : "—"} SV%`
        : `${g.goals ?? 0}G ${g.assists ?? 0}A · ${g.shots ?? 0} SOG · ${g.toi ?? "—"} TOI`,
      headline: isGoalie ? (g.savePctg ?? null) : (g.points ?? null),
    }));
  }
}
