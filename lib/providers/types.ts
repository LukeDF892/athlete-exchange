import type { Sport, StatLine } from "@/lib/pricing/engine";

/** A player as the rest of the app understands them, independent of any feed. */
export interface RawPlayer {
  /** Stable id namespaced by provider, e.g. "nhl:8478402" or "espn-nba:4066261". */
  externalId: string;
  sport: Sport;
  firstName: string;
  lastName: string;
  fullName: string;
  position: string | null;
  jersey: string | null;
  teamAbbrev: string | null;
  teamName: string | null;
  headshotUrl: string | null;
  birthDate: string | null;
  ageYears: number | null;
  isGoalie: boolean;
  recent: StatLine | null;
  season: StatLine | null;
  career: StatLine | null;
  /**
   * One entry per season the athlete has played, oldest first, back to their
   * rookie year. This is what the career value chart is drawn from: a new
   * listing has no trading history, but it always has a career.
   */
  careerSeasons: SeasonLine[];
  /** Human-readable stat rows for the player page, grouped by window. */
  statTables: StatTable[];
  /**
   * Recent games, when the provider already had them in hand.
   *
   * NBA and MLB read a per-game log to build their `recent` window, so the log
   * comes back free with it. Carrying it here avoids the ingest making a second
   * identical request per athlete purely to display what it just fetched.
   */
  gameLog?: GameLogEntry[];
}

/** A single completed season of production. */
export interface SeasonLine {
  /** Ending year of the season — 2026 means the 2025-26 season. */
  year: number;
  /** Label for the axis, e.g. "2025-26". */
  label: string;
  teamAbbrev: string | null;
  stats: StatLine;
}

export interface StatTable {
  window: "recent" | "season" | "career";
  label: string;
  rows: Array<{ label: string; value: string }>;
}

export interface GameLogEntry {
  date: string;
  opponent: string | null;
  homeAway: "home" | "away" | null;
  summary: string;
  /** Sport-specific headline number, e.g. points scored. */
  headline: number | null;
}

/**
 * Implement this to add a league or swap in a paid feed. Nothing above this
 * interface knows which vendor the numbers came from.
 */
export interface SportsProvider {
  readonly id: string;
  readonly sport: Sport;
  /** Ids of every player worth listing, most notable first. */
  listPlayerIds(limit: number): Promise<string[]>;
  /** Full detail for one player. Returns null if the feed has nothing usable. */
  fetchPlayer(externalId: string): Promise<RawPlayer | null>;
  /** Recent games for the player page. */
  fetchGameLog?(externalId: string, limit: number): Promise<GameLogEntry[]>;
}

export function ageFromBirthDate(birthDate: string | null | undefined): number | null {
  if (!birthDate) return null;
  const dob = new Date(birthDate);
  if (Number.isNaN(dob.getTime())) return null;
  const ms = Date.now() - dob.getTime();
  const years = ms / (365.25 * 24 * 60 * 60 * 1000);
  return years > 0 && years < 70 ? Math.round(years * 10) / 10 : null;
}

/** "21:52" -> 21.87 minutes. NHL reports time on ice as mm:ss. */
export function parseTimeOnIce(toi: string | null | undefined): number | null {
  if (!toi || typeof toi !== "string") return null;
  const [m, s] = toi.split(":").map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(m)) return null;
  return m + (Number.isFinite(s) ? s / 60 : 0);
}
