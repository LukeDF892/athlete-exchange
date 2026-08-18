/**
 * Which teams are playing right now, or have just finished.
 *
 * The daily ingest reprices the whole board once per league, in the small hours
 * — so a player could have the game of their career at 8pm and their
 * performance value would not move until the following morning. This is the
 * other half of that: a cheap way to ask "who is worth re-reading right now",
 * so a live refresh can touch forty players instead of five and a half
 * thousand.
 *
 * One request per league, because ESPN's scoreboard returns a whole day at
 * once — the same reason /games reads it rather than the per-team schedule.
 * Yesterday is read as well, since a game that starts at 22:00 Eastern is
 * filed under a date that has already rolled over in UTC.
 */
import type { Sport } from "@/lib/pricing/engine";
import { getJson } from "./http";

const PATHS: Record<Sport, string> = {
  nba: "basketball/nba",
  nhl: "hockey/nhl",
  mlb: "baseball/mlb",
  nfl: "football/nfl",
};

interface ScoreboardDoc {
  events?: Array<{
    id?: string;
    date?: string;
    competitions?: Array<{
      status?: { type?: { state?: string; completed?: boolean } };
      competitors?: Array<{ team?: { abbreviation?: string } }>;
    }>;
  }>;
}

export interface ActiveGames {
  /** Team abbreviations with a game in progress. */
  live: Set<string>;
  /** Team abbreviations whose game finished inside the lookback window. */
  recent: Set<string>;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

async function scanDay(sport: Sport, day: Date, since: number, out: ActiveGames): Promise<void> {
  const doc = await getJson<ScoreboardDoc>(
    `https://site.api.espn.com/apis/site/v2/sports/${PATHS[sport]}/scoreboard?dates=${ymd(day)}`,
    { retries: 0 }
  );

  for (const ev of doc.events ?? []) {
    const comp = ev.competitions?.[0];
    const state = comp?.status?.type?.state;
    const abbrevs = (comp?.competitors ?? [])
      .map((c) => c.team?.abbreviation)
      .filter((a): a is string => Boolean(a));
    if (abbrevs.length === 0) continue;

    if (state === "in") {
      for (const a of abbrevs) out.live.add(a);
      continue;
    }
    // A finished game is only interesting while its stats are still news. The
    // event date is kick-off, so this is generous by roughly a game length,
    // which is the safe direction: re-reading a player costs one request,
    // missing them costs a stale price until tomorrow.
    if (state === "post" && ev.date && new Date(ev.date).getTime() >= since) {
      for (const a of abbrevs) out.recent.add(a);
    }
  }
}

/**
 * Teams worth re-reading, per league.
 *
 * Never throws: a scoreboard that will not load means no live refresh this
 * slot, which is a missed ten minutes, not an outage. The daily ingest is still
 * the backstop for every league.
 */
export async function fetchActiveTeams(lookbackHours = 6): Promise<Map<Sport, ActiveGames>> {
  const since = Date.now() - lookbackHours * 3600 * 1000;
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
  const sports: Sport[] = ["nba", "nhl", "mlb", "nfl"];

  const entries = await Promise.all(
    sports.map(async (sport) => {
      const found: ActiveGames = { live: new Set(), recent: new Set() };
      for (const day of [now, yesterday]) {
        try {
          await scanDay(sport, day, since, found);
        } catch {
          // One league's scoreboard being unavailable must not cost the others.
        }
      }
      return [sport, found] as const;
    })
  );

  return new Map(entries);
}
