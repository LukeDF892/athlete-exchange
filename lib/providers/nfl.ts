/**
 * NFL provider, on the same ESPN feeds as the NBA and MLB.
 *
 * Two things make football different enough to need its own module.
 *
 * **Position comes from the roster, not the stats.** Baseball could infer a
 * pitcher from the presence of a pitching block, but football's categories lie:
 * a Pro Bowl centre comes back with `passing` first and zeroes inside it, so
 * reading role from the stat block would price the best linemen in the league
 * as quarterbacks who never throw. The team roster endpoint gives a reliable
 * abbreviation, so ids and positions are collected together.
 *
 * **A player's production is spread across several categories.** A running back
 * who catches passes has both `rushing` and `receiving` blocks, and both count.
 * So every category is read and merged per season rather than picking one.
 */
import type { Sport, StatLine } from "@/lib/pricing/engine";
import { isUnpriceablePosition } from "@/lib/pricing/engine";
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

const CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl";
const SITE = "https://site.web.api.espn.com/apis/common/v3/sports/football/nfl";
const SITE_ROSTER = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";

interface EspnAthlete {
  id?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  displayName?: string;
  jersey?: string;
  dateOfBirth?: string;
  headshot?: { href?: string };
  position?: { abbreviation?: string };
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

interface RosterEntry {
  id: string;
  position: string;
  teamAbbrev: string | null;
  teamName: string | null;
}

function slugToLabel(slug: string | undefined): string | null {
  if (!slug) return null;
  const last = slug.split("-").pop() ?? "";
  return last.slice(0, 3).toUpperCase() || null;
}

/**
 * Merge every stat category into one line per season.
 *
 * Values are season totals, so they sum directly. Percentages and averages are
 * the exception and are carried through as-is, weighted later if they need to
 * be — averaging an average across categories would be meaningless anyway,
 * since each belongs to a different act.
 */
function parseSeasons(doc: SiteStats | null | undefined): SeasonLine[] {
  const byYear = new Map<number, StatLine>();
  const teamByYear = new Map<number, string | null>();

  for (const cat of doc?.categories ?? []) {
    const names = cat.names;
    if (!names || !cat.statistics) continue;
    const idx = new Map(names.map((n, i) => [n, i]));
    const num = (row: string[], key: string): number | undefined => {
      const i = idx.get(key);
      if (i == null) return undefined;
      // Two formatting traps in one field. Some cells are "made-attempted"
      // pairs, so only the leading number is wanted — and football is the first
      // sport here with four-digit totals, which ESPN writes with a thousands
      // separator. `parseFloat("3,928")` is 3, which silently turned every
      // quarterback's passing yards into single digits and left them priced on
      // their rushing.
      const raw = (row[i] ?? "").split("-")[0].replace(/,/g, "");
      const v = Number.parseFloat(raw);
      return Number.isFinite(v) ? v : undefined;
    };

    for (const s of cat.statistics) {
      const year = s.season?.year;
      const row = s.stats;
      if (!year || !row) continue;

      const gp = num(row, "gamesPlayed") ?? 0;
      const line = byYear.get(year) ?? { gamesPlayed: 0 };
      // Games played appears in every category for the same season; take the
      // largest rather than summing, or a two-way player logs 34 games.
      line.gamesPlayed = Math.max(line.gamesPlayed, gp);
      if (!teamByYear.has(year)) teamByYear.set(year, slugToLabel(s.teamSlug));

      const add = (field: keyof StatLine, key: string) => {
        const v = num(row, key);
        if (v == null) return;
        const prev = (line[field] as number | undefined) ?? 0;
        Object.assign(line, { [field]: prev + v });
      };
      const set = (field: keyof StatLine, key: string) => {
        const v = num(row, key);
        if (v != null && v > 0) Object.assign(line, { [field]: v });
      };

      switch (cat.name) {
        case "passing":
          add("passingYards", "passingYards");
          add("passingTouchdowns", "passingTouchdowns");
          add("passingInterceptions", "interceptions");
          set("completionPct", "completionPct");
          break;
        case "rushing":
          add("rushingYards", "rushingYards");
          add("rushingTouchdowns", "rushingTouchdowns");
          break;
        case "receiving":
          add("receptions", "receptions");
          add("receivingYards", "receivingYards");
          add("receivingTouchdowns", "receivingTouchdowns");
          break;
        case "defensive":
          add("tackles", "totalTackles");
          add("sacks", "sacks");
          add("defensiveInterceptions", "interceptions");
          add("forcedFumbles", "fumblesForced");
          add("passesDefended", "passesDefended");
          break;
        case "kicking":
          add("fieldGoalsMade", "fieldGoalsMade-fieldGoalAttempts");
          add("kickingPoints", "totalKickingPoints");
          set("fieldGoalPctKicking", "fieldGoalPct");
          break;
        case "punting":
          set("puntAverage", "grossAvgPuntYards");
          add("puntsInside20", "puntsInside20");
          break;
      }
      byYear.set(year, line);
    }
  }

  return [...byYear.entries()]
    .filter(([, line]) => line.gamesPlayed > 0)
    .map(([year, stats]) => ({
      year,
      label: String(year),
      teamAbbrev: teamByYear.get(year) ?? null,
      stats,
    }))
    .sort((a, b) => a.year - b.year);
}

/** Trailing career line: totals sum, rates are weighted by games played. */
function sumSeasons(seasons: SeasonLine[]): StatLine | null {
  if (seasons.length === 0) return null;
  const acc: StatLine = { gamesPlayed: 0 };
  let compWeight = 0;
  let fgWeight = 0;
  let puntWeight = 0;

  const totals = [
    "passingYards",
    "passingTouchdowns",
    "passingInterceptions",
    "rushingYards",
    "rushingTouchdowns",
    "receptions",
    "receivingYards",
    "receivingTouchdowns",
    "tackles",
    "sacks",
    "defensiveInterceptions",
    "forcedFumbles",
    "passesDefended",
    "fieldGoalsMade",
    "kickingPoints",
    "puntsInside20",
  ] as const;

  for (const s of seasons) {
    const t = s.stats;
    acc.gamesPlayed += t.gamesPlayed;
    for (const k of totals) {
      if (t[k] != null) acc[k] = (acc[k] ?? 0) + (t[k] as number);
    }
    if (t.completionPct) {
      acc.completionPct = (acc.completionPct ?? 0) + t.completionPct * t.gamesPlayed;
      compWeight += t.gamesPlayed;
    }
    if (t.fieldGoalPctKicking) {
      acc.fieldGoalPctKicking =
        (acc.fieldGoalPctKicking ?? 0) + t.fieldGoalPctKicking * t.gamesPlayed;
      fgWeight += t.gamesPlayed;
    }
    if (t.puntAverage) {
      acc.puntAverage = (acc.puntAverage ?? 0) + t.puntAverage * t.gamesPlayed;
      puntWeight += t.gamesPlayed;
    }
  }

  if (acc.gamesPlayed <= 0) return null;
  if (compWeight > 0) acc.completionPct = (acc.completionPct ?? 0) / compWeight;
  if (fgWeight > 0) acc.fieldGoalPctKicking = (acc.fieldGoalPctKicking ?? 0) / fgWeight;
  if (puntWeight > 0) acc.puntAverage = (acc.puntAverage ?? 0) / puntWeight;
  return acc;
}

function fmt(n: number | undefined, digits = 0): string {
  return n == null || !Number.isFinite(n) ? "—" : n.toFixed(digits);
}

/** Stat rows shaped to the position, since a kicker and a corner share nothing. */
function rowsFor(line: StatLine | null, position: string): Array<{ label: string; value: string }> {
  if (!line) return [];
  const gp = line.gamesPlayed;
  const pg = (v: number | undefined, digits = 1) =>
    v == null || !gp ? "—" : (v / gp).toFixed(digits);
  const base = { label: "G", value: fmt(gp) };
  const p = position.toUpperCase();

  if (p === "QB") {
    return [
      base,
      { label: "YDS", value: fmt(line.passingYards) },
      { label: "YPG", value: pg(line.passingYards, 0) },
      { label: "TD", value: fmt(line.passingTouchdowns) },
      { label: "INT", value: fmt(line.passingInterceptions) },
      { label: "CMP%", value: fmt(line.completionPct, 1) },
      { label: "RUSH", value: fmt(line.rushingYards) },
    ];
  }
  if (p === "RB" || p === "FB" || p === "HB") {
    return [
      base,
      { label: "RUSH", value: fmt(line.rushingYards) },
      { label: "YPG", value: pg(line.rushingYards, 0) },
      { label: "TD", value: fmt(line.rushingTouchdowns) },
      { label: "REC", value: fmt(line.receptions) },
      { label: "RECYD", value: fmt(line.receivingYards) },
    ];
  }
  if (p === "WR" || p === "TE") {
    return [
      base,
      { label: "REC", value: fmt(line.receptions) },
      { label: "YDS", value: fmt(line.receivingYards) },
      { label: "YPG", value: pg(line.receivingYards, 0) },
      { label: "TD", value: fmt(line.receivingTouchdowns) },
    ];
  }
  if (p === "PK" || p === "K") {
    return [
      base,
      { label: "FGM", value: fmt(line.fieldGoalsMade) },
      { label: "FG%", value: fmt(line.fieldGoalPctKicking, 1) },
      { label: "PTS", value: fmt(line.kickingPoints) },
    ];
  }
  if (p === "P") {
    return [
      base,
      { label: "AVG", value: fmt(line.puntAverage, 1) },
      { label: "IN20", value: fmt(line.puntsInside20) },
    ];
  }
  return [
    base,
    { label: "TKL", value: fmt(line.tackles) },
    { label: "SACK", value: fmt(line.sacks, 1) },
    { label: "INT", value: fmt(line.defensiveInterceptions) },
    { label: "FF", value: fmt(line.forcedFumbles) },
    { label: "PD", value: fmt(line.passesDefended) },
  ];
}

interface TeamRoster {
  athletes?: Array<{
    items?: Array<{ id?: string; position?: { abbreviation?: string } }>;
  }>;
  team?: { abbreviation?: string; displayName?: string };
}

export class NflProvider implements SportsProvider {
  readonly id = "espn-nfl";
  readonly sport: Sport = "nfl";
  private roster = new Map<string, RosterEntry>();

  /**
   * Ids come from team rosters, which is also where position comes from.
   *
   * Linemen and long snappers are dropped here rather than later, so the ~500
   * players this market cannot price never cost a request in the first place.
   */
  async listPlayerIds(limit: number): Promise<string[]> {
    const teams = await getJson<{ sports?: Array<{ leagues?: Array<{ teams?: Array<{ team?: { id?: string } }> }> }> }>(
      `${SITE_ROSTER}/teams`,
      { retries: 1 }
    );
    const teamIds = (teams.sports?.[0]?.leagues?.[0]?.teams ?? [])
      .map((t) => t.team?.id)
      .filter((id): id is string => Boolean(id));

    const results = await mapPool(teamIds, 6, async (teamId) => {
      const doc = await getJson<TeamRoster>(`${SITE_ROSTER}/teams/${teamId}/roster`, {
        retries: 1,
      });
      const abbrev = doc.team?.abbreviation ?? null;
      const name = doc.team?.displayName ?? null;
      const out: RosterEntry[] = [];
      for (const group of doc.athletes ?? []) {
        for (const a of group.items ?? []) {
          const pos = a.position?.abbreviation ?? "";
          if (!a.id || !pos) continue;
          if (isUnpriceablePosition("nfl", pos)) continue;
          out.push({ id: a.id, position: pos, teamAbbrev: abbrev, teamName: name });
        }
      }
      return out;
    });

    for (const r of results) {
      if (!r.ok) continue;
      for (const entry of r.value) this.roster.set(entry.id, entry);
    }
    return [...this.roster.keys()].slice(0, limit);
  }

  async fetchPlayer(externalId: string): Promise<RawPlayer | null> {
    const athleteId = externalId.replace(/^espn-nfl:/, "");
    const entry = this.roster.get(athleteId);

    const [athlete, statsDoc] = await Promise.all([
      getJson<EspnAthlete>(`${CORE}/athletes/${athleteId}`, { retries: 1 }).catch(() => null),
      getJson<SiteStats>(`${SITE}/athletes/${athleteId}/stats`, { retries: 1 }).catch(() => null),
    ]);
    if (!athlete?.id) return null;

    const fullName = athlete.fullName ?? athlete.displayName ?? "";
    if (!fullName) return null;

    const position = entry?.position ?? athlete.position?.abbreviation ?? "";
    // Belt and braces: the roster filter should already have removed these.
    if (isUnpriceablePosition("nfl", position)) return null;

    const seasons = parseSeasons(statsDoc);
    if (seasons.length === 0) return null;

    const latest = seasons[seasons.length - 1];
    const careerLine = sumSeasons(seasons.slice(-4));

    const form = await fetchRecentForm("nfl", athleteId, { position });

    const statTables: StatTable[] = [
      ...(form.recent
        ? [
            {
              window: "recent" as const,
              label: `Last ${form.recent.gamesPlayed}`,
              rows: rowsFor(form.recent, position),
            },
          ]
        : []),
      { window: "season" as const, label: latest.label, rows: rowsFor(latest.stats, position) },
      { window: "career" as const, label: "Recent career", rows: rowsFor(careerLine, position) },
    ];

    return {
      externalId: `espn-nfl:${athlete.id}`,
      sport: "nfl",
      firstName: athlete.firstName ?? fullName.split(" ")[0] ?? "",
      lastName: athlete.lastName ?? fullName.split(" ").slice(1).join(" "),
      fullName,
      position,
      jersey: athlete.jersey ?? null,
      teamAbbrev: entry?.teamAbbrev ?? null,
      teamName: entry?.teamName ?? null,
      headshotUrl: athlete.headshot?.href ?? null,
      birthDate: athlete.dateOfBirth ?? null,
      ageYears: ageFromBirthDate(athlete.dateOfBirth),
      isGoalie: false,
      recent: form.recent,
      season: latest.stats,
      career: careerLine,
      careerSeasons: seasons,
      statTables,
      gameLog: form.games,
    };
  }

  async fetchGameLog(externalId: string, limit: number): Promise<GameLogEntry[]> {
    const athleteId = externalId.replace(/^espn-nfl:/, "");
    const entry = this.roster.get(athleteId);
    const { games } = await fetchRecentForm("nfl", athleteId, {
      position: entry?.position,
      logLimit: limit,
    });
    return games;
  }
}

export const nflProvider = new NflProvider();
