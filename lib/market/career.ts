import { fairValue, type Calibration } from "@/lib/pricing/engine";
import type { RawPlayer, SeasonLine } from "@/lib/providers/types";
import type { CareerValuePoint } from "./types";

/**
 * What each season of a career would have been worth on this exchange.
 *
 * Every season is priced with the same fairValue() the live market uses, but
 * at the age the athlete actually was that year — so a 22-year-old's rookie
 * season carries its growth premium and the same production at 38 does not.
 * The result is a genuine value trajectory: rookie year, rise, peak, decline.
 *
 * Only the season itself is used, with no career window blended in. Each point
 * answers "what was this season worth?", not "what were they worth by then",
 * which is what makes the shape readable as a career arc.
 */
export function buildCareerValue(raw: RawPlayer, calibration?: Calibration): CareerValuePoint[] {
  const seasons = raw.careerSeasons;
  if (seasons.length === 0) return [];

  // Age is known only for today, so walk it backwards from the latest season.
  const latestYear = seasons[seasons.length - 1].year;

  return seasons.map((s) => {
    const ageThen =
      raw.ageYears == null ? null : Math.max(17, raw.ageYears - (latestYear - s.year));

    return {
      year: s.year,
      label: s.label,
      teamAbbrev: s.teamAbbrev,
      value: fairValue({
        sport: raw.sport,
        season: s.stats,
        ageYears: ageThen,
        position: raw.position,
        calibration,
      }),
      gamesPlayed: s.stats.gamesPlayed,
      summary: seasonSummary(raw.sport, s, raw.isGoalie),
    };
  });
}

/** Short headline for a tooltip — the numbers a fan would quote. */
function seasonSummary(sport: string, s: SeasonLine, isGoalie: boolean): string {
  const gp = s.stats.gamesPlayed;
  const pg = (v: number | undefined, digits = 1) =>
    v == null || !gp ? "—" : (v / gp).toFixed(digits);

  if (sport === "nba") {
    return `${pg(s.stats.points)} PPG · ${pg(s.stats.rebounds)} RPG · ${pg(s.stats.assists)} APG`;
  }
  if (isGoalie) {
    const svp = s.stats.savePct;
    const shown = svp == null ? "—" : (svp > 1 ? svp / 100 : svp).toFixed(3).replace(/^0/, "");
    return `${shown} SV% · ${gp} GP`;
  }
  const g = s.stats.goals ?? 0;
  const a = s.stats.hockeyAssists ?? 0;
  return `${g}G ${a}A · ${g + a} PTS`;
}
