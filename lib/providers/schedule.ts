/**
 * Upcoming fixtures for a team.
 *
 * Fetched when a page renders rather than stored at ingest, for two reasons.
 * A schedule belongs to a *team*, so writing it onto five thousand player rows
 * would duplicate the same thirty games hundreds of times over; and it changes
 * on its own timetable (postponements, flexed kickoffs) rather than on the
 * ingest's. Next's fetch cache holds each team's schedule for an hour, so a
 * busy page costs one request per team per hour, not one per view.
 *
 * This is what makes the market playable rather than a historical exercise:
 * knowing an athlete has four games this week, and who against, is the whole
 * basis for deciding whether to buy them now or wait.
 */
import type { Sport } from "@/lib/pricing/engine";

const PATHS: Record<Sport, string> = {
  nba: "basketball/nba",
  nhl: "hockey/nhl",
  mlb: "baseball/mlb",
  nfl: "football/nfl",
};

export interface Fixture {
  /** ISO kickoff/first-pitch time. */
  date: string;
  opponent: string | null;
  opponentName: string | null;
  homeAway: "home" | "away" | null;
  /** e.g. "8/17 - 8:40 PM EDT", straight from the feed. */
  detail: string | null;
}

interface ScheduleDoc {
  events?: Array<{
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

/**
 * The next few games for a team, soonest first.
 *
 * Returns nothing rather than throwing: a missing schedule should leave the
 * rest of a player page intact, and in the offseason there is legitimately
 * nothing to show.
 */
export async function fetchUpcoming(
  sport: Sport,
  teamAbbrev: string | null | undefined,
  limit = 6
): Promise<Fixture[]> {
  if (!teamAbbrev) return [];
  try {
    const res = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/${PATHS[sport]}/teams/${encodeURIComponent(
        teamAbbrev
      )}/schedule`,
      // An hour is well inside how often a schedule changes, and keeps a busy
      // player page from hammering ESPN once per view.
      { next: { revalidate: 3600 } }
    );
    if (!res.ok) return [];
    const doc = (await res.json()) as ScheduleDoc;

    const now = Date.now();
    const out: Fixture[] = [];

    for (const ev of doc.events ?? []) {
      if (!ev.date) continue;
      const when = new Date(ev.date).getTime();
      if (!Number.isFinite(when) || when < now) continue;

      const comp = ev.competitions?.[0];
      // A completed game with a future date is a data oddity, not a fixture.
      if (comp?.status?.type?.completed) continue;

      const me = comp?.competitors?.find((c) => c.team?.abbreviation === teamAbbrev);
      const them = comp?.competitors?.find((c) => c.team?.abbreviation !== teamAbbrev);
      const ha = me?.homeAway;

      out.push({
        date: ev.date,
        opponent: them?.team?.abbreviation ?? null,
        opponentName: them?.team?.displayName ?? null,
        homeAway: ha === "home" || ha === "away" ? ha : null,
        detail: comp?.status?.type?.shortDetail ?? null,
      });
    }

    out.sort((a, b) => a.date.localeCompare(b.date));
    return out.slice(0, limit);
  } catch {
    return [];
  }
}
