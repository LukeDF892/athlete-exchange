import { liquidityDepth, marketPrice, type Sport } from "@/lib/pricing/engine";
import type { Player, TeamComponent } from "./types";

/**
 * Teams as tradeable index funds.
 *
 * A team is priced as a value-weighted index of its roster, the same way an ETF
 * tracks a market-cap-weighted basket: every athlete contributes in proportion
 * to what they are already worth, so a roster's stars move it more than its
 * bench does.
 *
 *     teamValue = Σ(vᵢ²) / Σ(vᵢ)
 *
 * That is the value-weighted mean. A plain average would say a team of one
 * superstar and eleven replacements is mediocre; this says it is expensive,
 * which is how a basket of assets actually prices.
 *
 * The result lands in the same dollar range as a player, so a team sits on the
 * board next to the athletes it contains and the comparison means something.
 */
export function buildTeams(players: Player[]): Player[] {
  const byTeam = new Map<string, Player[]>();

  for (const p of players) {
    // Free agents and anyone the feed left unassigned cannot belong to a team.
    if (!p.teamAbbrev || !p.teamName) continue;
    const key = `${p.sport}:${p.teamAbbrev}`;
    const list = byTeam.get(key);
    if (list) list.push(p);
    else byTeam.set(key, [p]);
  }

  const teams: Player[] = [];

  for (const [key, roster] of byTeam) {
    // A handful of players is a data gap, not a team.
    if (roster.length < 5) continue;

    const [sport, abbrev] = key.split(":") as [Sport, string];
    const sumV = roster.reduce((a, p) => a + p.fairValue, 0);
    const sumV2 = roster.reduce((a, p) => a + p.fairValue * p.fairValue, 0);
    if (sumV <= 0) continue;

    const value = round2(sumV2 / sumV);
    // Deeper than a single athlete: an index should be harder to move, and a
    // team represents far more underlying value than any one player.
    const depth = Math.round(liquidityDepth(value) * 2.5);

    const sorted = [...roster].sort((a, b) => b.fairValue - a.fairValue);
    const components: TeamComponent[] = sorted.slice(0, 12).map((p) => ({
      playerId: p.id,
      fullName: p.fullName,
      position: p.position,
      fairValue: p.fairValue,
      weightPct: round2((p.fairValue / sumV) * 100),
      injured: Boolean(p.injury),
    }));

    const injuredCount = roster.filter((p) => p.injury).length;
    const teamName = sorted[0].teamName ?? abbrev;

    teams.push({
      id: `team-${sport}-${abbrev.toLowerCase()}`,
      externalId: `team:${sport}:${abbrev}`,
      kind: "team",
      sport,
      fullName: teamName,
      firstName: teamName,
      lastName: "",
      position: "TEAM",
      jersey: null,
      teamAbbrev: abbrev,
      teamName,
      headshotUrl: null,
      ageYears: round2(
        roster.reduce((a, p) => a + (p.ageYears ?? 0), 0) / roster.length
      ),
      isGoalie: false,
      fairValue: value,
      openingFairValue: value,
      liquidityDepth: depth,
      sharesOutstanding: 0,
      marketPrice: marketPrice(value, 0, depth),
      prevClose: null,
      statTables: [
        {
          window: "season",
          label: "Roster",
          rows: [
            { label: "Players", value: String(roster.length) },
            { label: "Top", value: sorted[0].fullName },
            { label: "Avg value", value: `$${(sumV / roster.length).toFixed(0)}` },
            { label: "Injured", value: String(injuredCount) },
          ],
        },
      ],
      gameLog: [],
      // A team has no rookie season of its own; its history is the sum of the
      // careers on it, which is not the same thing and would be misleading.
      careerValue: [],
      injury: null,
      healthyFairValue: value,
      components,
    });
  }

  return teams.sort((a, b) => b.fairValue - a.fairValue);
}

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}
