/**
 * A team's listed players, with injuries surfaced.
 *
 * Reads the board rather than a feed: everything needed is already on the
 * player row, including the injury that discounted its price. That matters for
 * consistency — the injury shown here is the same one the price was built from,
 * not a second opinion fetched separately that might disagree.
 */
import { getPlayers } from "@/lib/market/source";
import type { Player } from "@/lib/market/types";
import type { Sport } from "@/lib/pricing/engine";

export interface TeamRoster {
  teamAbbrev: string;
  teamName: string | null;
  players: Player[];
  injured: Player[];
}

export async function getTeamRoster(sport: Sport, teamAbbrev: string): Promise<TeamRoster | null> {
  const all = await getPlayers();
  const want = teamAbbrev.toUpperCase();

  const players = all
    .filter(
      (p) =>
        p.kind === "athlete" &&
        p.sport === sport &&
        (p.teamAbbrev ?? "").toUpperCase() === want
    )
    // Most valuable first: on a roster of fifty, the names worth trading are
    // the ones a reader is looking for.
    .sort((a, b) => b.marketPrice - a.marketPrice);

  if (players.length === 0) return null;

  return {
    teamAbbrev: want,
    teamName: players.find((p) => p.teamName)?.teamName ?? null,
    players,
    injured: players.filter((p) => p.injury != null),
  };
}
