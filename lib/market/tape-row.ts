/**
 * The shape of a tape row, and how to read one.
 *
 * Split out of `lib/market/tape.ts` so the browser can use it: that module
 * reaches for the Supabase *server* client, which drags `next/headers` into any
 * bundle that imports it and breaks the build. The tape is now live, so the
 * client reads `trade_tape` for itself — and needs the same mapping the server
 * uses, not a second copy of it that can drift.
 */
import type { Sport } from "@/lib/pricing/engine";

export interface TapeEntry {
  id: string;
  createdAt: string;
  side: "buy" | "sell";
  shares: number;
  username: string;
  playerId: string;
  playerName: string;
  sport: Sport;
  teamAbbrev: string | null;
  /** Bots are labelled, so nobody mistakes one for a person. */
  isBot: boolean;
}

/** One row of the `trade_tape` view, as PostgREST returns it. */
export interface TapeRow {
  id: string | number;
  created_at: string;
  side: string;
  shares: number | string;
  username: string;
  player_id: string;
  player_name: string;
  sport: string;
  team_abbrev: string | null;
}

export function toTapeEntry(r: TapeRow): TapeEntry {
  return {
    id: String(r.id),
    createdAt: String(r.created_at),
    side: r.side as "buy" | "sell",
    shares: Number(r.shares),
    username: String(r.username),
    playerId: String(r.player_id),
    playerName: String(r.player_name),
    sport: r.sport as Sport,
    teamAbbrev: r.team_abbrev,
    isBot: /^bot_/.test(String(r.username)),
  };
}
