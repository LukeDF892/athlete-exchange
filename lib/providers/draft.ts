/**
 * Drafted prospects who have not played a professional game.
 *
 * The normal pipeline cannot see these players at all: it starts from a
 * roster, and a prospect is not on one. Yet the moment someone is drafted
 * first overall they are one of the most talked-about names in the sport, and
 * a market that cannot trade them is missing the story.
 *
 * Pricing them is genuinely harder than pricing a veteran, because there is no
 * professional production to measure. What exists instead is **draft
 * position**, which is the single most informative public signal available:
 * it is the pooled judgement of thirty scouting departments who have watched
 * far more junior hockey than any statistic here could capture. Amateur point
 * totals are tempting but treacherous — they are not comparable across the
 * NCAA, the CHL and the SHL, and the draft order already reflects them.
 *
 * So a prospect's opening price is a function of where they went, and the UI
 * says plainly that it is an unproven listing. Once they play a real game the
 * ordinary pipeline picks them up and prices them on production instead.
 */
import type { Sport } from "@/lib/pricing/engine";
import { getJson, mapPool } from "./http";

export interface DraftProspect {
  externalId: string;
  sport: Sport;
  firstName: string;
  lastName: string;
  fullName: string;
  position: string | null;
  teamAbbrev: string | null;
  teamName: string | null;
  draftYear: number;
  overallPick: number;
  round: number;
  amateurClub: string | null;
  amateurLeague: string | null;
  /** Opening fair value implied by where they were drafted. */
  fairValue: number;
}

/**
 * Value by draft slot.
 *
 * Decays exponentially: the gap between first and fifth overall is worth far
 * more than the gap between fiftieth and fifty-fifth, which is how draft pick
 * value actually behaves. PEAK sits deliberately below what an established
 * star commands — a first overall pick is a promising asset, not a proven one,
 * and the board should not price potential above performance.
 */
const PEAK = 150;
const FLOOR = 6;
const DECAY = 32;

/**
 * How fast an undebuted prospect loses value.
 *
 * A draft pick is a claim on a career that has not started. If it still has not
 * started two years later, that claim is worth measurably less — the player is
 * older, other prospects have passed them, and the reason they are not playing
 * is rarely encouraging. Holding the price flat forever would say the opposite:
 * that nothing was learned by the waiting.
 *
 * Gentle, and floored well above zero: plenty of good players take three years
 * to arrive, and a prospect who never debuts is delisted rather than decayed.
 */
const DECAY_PER_YEAR = 0.18;
const DECAY_FLOOR = 0.4;

export function draftPickValue(overallPick: number, yearsSinceDraft = 0): number {
  const n = Math.max(1, overallPick);
  const base = FLOOR + (PEAK - FLOOR) * Math.exp(-(n - 1) / DECAY);
  const staleness = Math.max(
    DECAY_FLOOR,
    1 - Math.max(0, yearsSinceDraft) * DECAY_PER_YEAR
  );
  return Math.round(base * staleness * 100) / 100;
}

interface NhlDraftDoc {
  draftYear?: number;
  picks?: Array<{
    round?: number;
    overallPick?: number;
    teamAbbrev?: string;
    teamName?: { default?: string };
    firstName?: { default?: string };
    lastName?: { default?: string };
    positionCode?: string;
    amateurLeague?: { default?: string } | string;
    amateurClubName?: { default?: string } | string;
  }>;
}

function plain(v: { default?: string } | string | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : v.default ?? null;
}

/** Every pick from an NHL draft year. */
export async function fetchNhlDraft(year: number): Promise<DraftProspect[]> {
  try {
    const doc = await getJson<NhlDraftDoc>(`https://api-web.nhle.com/v1/draft/picks/${year}/all`, {
      retries: 1,
    });

    const out: DraftProspect[] = [];
    for (const p of doc.picks ?? []) {
      const first = p.firstName?.default ?? "";
      const last = p.lastName?.default ?? "";
      const fullName = `${first} ${last}`.trim();
      const overall = p.overallPick;
      if (!fullName || !overall) continue;

      out.push({
        // Namespaced so a prospect can never collide with a rostered athlete.
        externalId: `draft:nhl:${year}:${overall}`,
        sport: "nhl",
        firstName: first,
        lastName: last,
        fullName,
        position: p.positionCode ?? null,
        teamAbbrev: p.teamAbbrev ?? null,
        teamName: p.teamName?.default ?? p.teamAbbrev ?? null,
        draftYear: doc.draftYear ?? year,
        overallPick: overall,
        round: p.round ?? 1,
        amateurClub: plain(p.amateurClubName),
        amateurLeague: plain(p.amateurLeague),
        fairValue: draftPickValue(overall, Math.max(0, new Date().getFullYear() - (doc.draftYear ?? year))),
      });
    }
    return out;
  } catch {
    // A draft feed outage should never take the ingest down.
    return [];
  }
}

interface EspnDraftRounds {
  items?: Array<{
    number?: number;
    picks?: Array<{
      overall?: number;
      round?: number;
      athlete?: { $ref?: string };
      team?: { $ref?: string };
    }>;
  }>;
}

interface EspnDraftAthlete {
  firstName?: string;
  lastName?: string;
  fullName?: string;
  displayName?: string;
  position?: { abbreviation?: string; name?: string };
  college?: { $ref?: string; name?: string; shortName?: string };
}

/**
 * Every pick from an NBA draft year.
 *
 * Structured differently from hockey's, and more expensively: the NHL returns
 * one document with every pick and player name inline, while ESPN returns
 * rounds of `$ref` pointers that each need their own request. That is ~60 extra
 * calls for two rounds, which is why this is capped at the rounds we actually
 * list rather than fetching the whole draft.
 *
 * There is no MLB equivalent. ESPN's draft endpoint returns an empty document
 * for baseball in every year tried, so MLB draftees have no source here — and
 * they spend years in the minors before debuting anyway, so the gap costs less
 * than it would in the other two leagues.
 */
export async function fetchNbaDraft(year: number, maxRounds = 2): Promise<DraftProspect[]> {
  try {
    const doc = await getJson<EspnDraftRounds>(
      `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/${year}/draft/rounds`,
      { retries: 1 }
    );

    const wanted: Array<{ overall: number; round: number; ref: string; teamRef?: string }> = [];
    for (const round of doc.items ?? []) {
      for (const p of round.picks ?? []) {
        const overall = p.overall;
        const r = p.round ?? round.number ?? 1;
        if (!overall || !p.athlete?.$ref || r > maxRounds) continue;
        wanted.push({ overall, round: r, ref: p.athlete.$ref, teamRef: p.team?.$ref });
      }
    }
    if (wanted.length === 0) return [];

    const staleness = Math.max(0, new Date().getFullYear() - year);
    const results = await mapPool<typeof wanted[number], DraftProspect | null>(wanted, 6, async (w) => {
      const a = await getJson<EspnDraftAthlete>(w.ref.replace(/^http:/, "https:"), { retries: 0 });
      const fullName = a.fullName ?? a.displayName ?? "";
      if (!fullName) return null;

      let teamAbbrev: string | null = null;
      let teamName: string | null = null;
      if (w.teamRef) {
        try {
          const t = await getJson<{ abbreviation?: string; displayName?: string }>(
            w.teamRef.replace(/^http:/, "https:"),
            { retries: 0 }
          );
          teamAbbrev = t.abbreviation ?? null;
          teamName = t.displayName ?? null;
        } catch {
          // Cosmetic only.
        }
      }

      return {
        externalId: `draft:nba:${year}:${w.overall}`,
        sport: "nba" as const,
        firstName: a.firstName ?? fullName.split(" ")[0] ?? "",
        lastName: a.lastName ?? fullName.split(" ").slice(1).join(" "),
        fullName,
        position: a.position?.abbreviation ?? a.position?.name ?? null,
        teamAbbrev,
        teamName,
        draftYear: year,
        overallPick: w.overall,
        round: w.round,
        amateurClub: a.college?.shortName ?? a.college?.name ?? null,
        amateurLeague: a.college ? "NCAA" : null,
        fairValue: draftPickValue(w.overall, staleness),
      } satisfies DraftProspect;
    });

    return results.flatMap((r) => (r.ok && r.value ? [r.value] : []));
  } catch {
    return [];
  }
}

/**
 * Only the picks worth listing.
 *
 * Later-round picks mostly never play a professional game, and a board full of
 * $6 lottery tickets is noise rather than a market. First and second round is
 * roughly where public interest and realistic odds both still exist.
 */
export function listableProspects(prospects: DraftProspect[], maxRounds = 2): DraftProspect[] {
  return prospects.filter((p) => p.round <= maxRounds);
}
