/**
 * Injury status, and what it does to an athlete's value.
 *
 * Until now fair value only saw injuries through games played, which lags by
 * weeks: a star tearing a knee tonight kept their full price until the missed
 * games slowly accumulated. For a market meant to track player value that is
 * the wrong way round — the news IS the event, and the price should move on it.
 *
 * ESPN's injuries endpoint gives status, body part, and often an expected
 * return date. It does NOT give athlete ids, only display names, so matching is
 * by normalised name. That is less reliable than an id join: a missed match
 * silently means no discount, which is why unmatched injuries are counted and
 * reported at ingest rather than passing quietly.
 */
import type { Sport } from "@/lib/pricing/engine";
import { getJson } from "./http";

export interface InjuryStatus {
  /** "Day-To-Day", "Out", "Injured Reserve"… as the feed words it. */
  status: string;
  /** Body part, e.g. "Foot". */
  type: string | null;
  /** "Fracture", "Sprain"… */
  detail: string | null;
  returnDate: string | null;
  /** Days until expected return, when the feed supplies one. */
  daysOut: number | null;
  /** Multiplier applied to fair value: 1 = unaffected, 0.65 = out long term. */
  multiplier: number;
  /** Short human summary for the player page. */
  summary: string;
}

const ENDPOINTS: Record<Sport, string> = {
  nba: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries",
  nhl: "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries",
  mlb: "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/injuries",
  nfl: "https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries",
};

interface EspnInjuryDoc {
  injuries?: Array<{
    abbreviation?: string;
    displayName?: string;
    injuries?: Array<{
      status?: string;
      athlete?: { displayName?: string };
      details?: {
        type?: string;
        detail?: string;
        returnDate?: string;
      };
    }>;
  }>;
}

/**
 * Strip everything that differs between two spellings of the same person:
 * accents, punctuation, and generational suffixes.
 */
export function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/[^a-z ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A second, looser key: first initial plus surname.
 *
 * Feeds disagree about given names far more than surnames — "Alexander" against
 * "Alex", "Mitch" against "Mitchell", "Cameron" against "Cam". The initial and
 * the surname survive all of those, which recovers matches an exact compare
 * drops. It is deliberately only a *fallback*, and only used when it resolves
 * to exactly one athlete, because it is a genuinely weaker claim of identity.
 */
export function looseNameKey(name: string): string | null {
  const parts = normalizeName(name).split(" ").filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[0][0]}.${parts[parts.length - 1]}`;
}

/**
 * How much an injury should cost.
 *
 * Anchored on time missed rather than the label, because "Out" means something
 * very different in November than in April. Where the feed gives a return date
 * the discount scales with it; where it does not, the status word is the only
 * signal available and the discount stays deliberately mild so a routine
 * day-to-day tag does not crater a price.
 */
function severity(status: string, daysOut: number | null): number {
  const s = status.toLowerCase();

  if (s.includes("day-to-day") || s.includes("questionable") || s.includes("probable")) {
    return 0.97;
  }

  if (daysOut != null) {
    if (daysOut <= 14) return 0.93;
    if (daysOut <= 45) return 0.85;
    if (daysOut <= 120) return 0.75;
    return 0.65;
  }

  if (s.includes("season") || s.includes("injured reserve") || s.includes("ir")) return 0.65;
  if (s.includes("out") || s.includes("doubtful")) return 0.88;
  return 0.95;
}

function daysBetween(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const days = Math.round((t - Date.now()) / 86_400_000);
  // A return date in the past means they are back; treat as healthy.
  return days > 0 ? days : null;
}

interface Entry {
  injury: InjuryStatus;
  teamAbbrev: string | null;
}

/**
 * Injuries for one league, resolvable by name.
 *
 * The naive version of this was a `Map<name, injury>`, and it had a failure
 * mode worse than missing a match: two athletes who normalise to the same
 * string — and every league has some — would collapse into one entry, so a
 * healthy player silently inherited someone else's torn ACL and lost a third of
 * their price. Nothing about that is visible from the outside; the price just
 * looks wrong.
 *
 * So matching is tiered, most-specific first, and every tier refuses to answer
 * when it cannot answer uniquely:
 *
 *   1. team + exact name — the strongest evidence, and enough to separate two
 *      players who genuinely share a name
 *   2. exact name, only if exactly one injured athlete in the league has it
 *   3. first-initial + surname, again only if unique
 *
 * A refusal costs one missing discount. A wrong match costs a wrong price on a
 * player who is fine, so ambiguity always resolves to "no injury".
 */
export class InjuryIndex {
  private byTeamName = new Map<string, Entry>();
  private byName = new Map<string, Entry[]>();
  private byLoose = new Map<string, Entry[]>();

  /** How many injuries this index holds, ambiguous ones included. */
  size = 0;

  add(entry: Entry, name: string) {
    const exact = normalizeName(name);
    if (!exact) return;
    this.size++;

    if (entry.teamAbbrev) {
      this.byTeamName.set(`${entry.teamAbbrev.toLowerCase()}|${exact}`, entry);
    }
    push(this.byName, exact, entry);

    const loose = looseNameKey(name);
    if (loose && loose !== exact) push(this.byLoose, loose, entry);
  }

  lookup(fullName: string, teamAbbrev?: string | null): InjuryStatus | undefined {
    const exact = normalizeName(fullName);
    if (!exact) return undefined;

    if (teamAbbrev) {
      const hit = this.byTeamName.get(`${teamAbbrev.toLowerCase()}|${exact}`);
      if (hit) return hit.injury;
    }

    return only(this.byName.get(exact)) ?? only(this.byLoose.get(looseNameKey(fullName) ?? ""));
  }

  /** Names carrying more than one injured athlete, for the ingest log. */
  ambiguous(): string[] {
    const out: string[] = [];
    for (const [name, entries] of this.byName) if (entries.length > 1) out.push(name);
    return out;
  }
}

function push<T>(map: Map<string, T[]>, key: string, value: T) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** The one entry, or nothing — never a guess between several. */
function only(entries: Entry[] | undefined): InjuryStatus | undefined {
  return entries && entries.length === 1 ? entries[0].injury : undefined;
}

/** Injuries for one league, indexed for name matching. */
export async function fetchInjuries(sport: Sport): Promise<InjuryIndex> {
  const out = new InjuryIndex();
  try {
    const doc = await getJson<EspnInjuryDoc>(ENDPOINTS[sport], { retries: 1 });
    for (const team of doc.injuries ?? []) {
      // The outer level of this feed is the team, which is the only
      // disambiguating fact it offers about who a name refers to.
      const teamAbbrev = team.abbreviation ?? null;
      for (const inj of team.injuries ?? []) {
        const name = inj.athlete?.displayName;
        const status = inj.status;
        if (!name || !status) continue;

        const returnDate = inj.details?.returnDate ?? null;
        const daysOut = daysBetween(returnDate);
        const multiplier = severity(status, daysOut);
        const type = inj.details?.type ?? null;
        const detail = inj.details?.detail ?? null;

        const parts = [status];
        if (type) parts.push(detail ? `${type} (${detail.toLowerCase()})` : type);
        if (daysOut != null) parts.push(`~${daysOut}d out`);

        out.add(
          {
            teamAbbrev,
            injury: {
              status,
              type,
              detail,
              returnDate,
              daysOut,
              multiplier,
              summary: parts.join(" · "),
            },
          },
          name
        );
      }
    }
  } catch {
    // An injury feed outage should never take the ingest down; every athlete
    // simply prices as healthy, which is the pre-existing behaviour.
  }
  return out;
}
