/**
 * Every scheduled game across the leagues, for the next few days.
 *
 * The per-team schedule already existed, but answering "what is on tonight"
 * from it would mean a request per team per league — a hundred and thirty
 * calls to build one page. ESPN's scoreboard endpoint returns a whole league's
 * fixtures for a given day in one request, so this is four calls per day shown.
 *
 * Fetched at render with an hour of caching rather than stored at ingest, for
 * the same reason the player-page schedule is: fixtures move on their own
 * timetable, and there is nothing to gain from a copy that can go stale.
 */
import type { Sport } from "@/lib/pricing/engine";

const PATHS: Record<Sport, string> = {
  nba: "basketball/nba",
  nhl: "hockey/nhl",
  mlb: "baseball/mlb",
  nfl: "football/nfl",
};

export interface ScheduledGame {
  id: string;
  sport: Sport;
  date: string;
  /** "8:35 PM EDT" or similar, straight from the feed. */
  detail: string | null;
  home: { abbrev: string; name: string } | null;
  away: { abbrev: string; name: string } | null;
}

interface ScoreboardDoc {
  events?: Array<{
    id?: string;
    date?: string;
    competitions?: Array<{
      status?: { type?: { shortDetail?: string; completed?: boolean } };
      competitors?: Array<{
        homeAway?: string;
        team?: { abbreviation?: string; displayName?: string };
      }>;
    }>;
  }>;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

async function fetchDay(sport: Sport, day: Date): Promise<ScheduledGame[]> {
  try {
    const res = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/${PATHS[sport]}/scoreboard?dates=${ymd(day)}`,
      { next: { revalidate: 3600 } }
    );
    if (!res.ok) return [];
    const doc = (await res.json()) as ScoreboardDoc;

    const out: ScheduledGame[] = [];
    for (const ev of doc.events ?? []) {
      if (!ev.id || !ev.date) continue;
      const comp = ev.competitions?.[0];
      // A finished game is not upcoming, whatever day it is filed under.
      if (comp?.status?.type?.completed) continue;

      const side = (which: "home" | "away") => {
        const c = comp?.competitors?.find((x) => x.homeAway === which);
        return c?.team?.abbreviation
          ? { abbrev: c.team.abbreviation, name: c.team.displayName ?? c.team.abbreviation }
          : null;
      };

      out.push({
        id: ev.id,
        sport,
        date: ev.date,
        detail: comp?.status?.type?.shortDetail ?? null,
        home: side("home"),
        away: side("away"),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Upcoming fixtures across every league, soonest first.
 *
 * `days` is small on purpose: four leagues times seven days is twenty-eight
 * requests, and nobody plans a trade three weeks out.
 */
export async function fetchSchedule(days = 4): Promise<ScheduledGame[]> {
  const sports: Sport[] = ["nfl", "nba", "nhl", "mlb"];
  const dates = Array.from({ length: days }, (_, i) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + i);
    return d;
  });

  const batches = await Promise.all(
    sports.flatMap((s) => dates.map((d) => fetchDay(s, d)))
  );

  const now = Date.now();
  return batches
    .flat()
    .filter((g) => new Date(g.date).getTime() >= now - 3 * 3600_000)
    .sort((a, b) => a.date.localeCompare(b.date));
}
