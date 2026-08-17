/**
 * What everyone else is doing.
 *
 * The board showed prices and the leaderboard showed standings, but nothing
 * showed *activity* — with twelve bots and a few friends trading, a busy market
 * still felt like an empty room. This is the tape: who bought what, just now.
 *
 * It reads `trade_tape`, a view that deliberately publishes less than the
 * `trades` table does. Share counts and listings are market information; the
 * cash each trade moved is not, so it is not in the view at all.
 */
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";
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

export async function getTradeTape(limit = 12): Promise<TapeEntry[]> {
  if (!isSupabaseConfigured()) return [];
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("trade_tape")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error || !data) return [];

    return data.map((r) => ({
      id: String(r.id),
      createdAt: String(r.created_at),
      side: r.side as "buy" | "sell",
      shares: Number(r.shares),
      username: String(r.username),
      playerId: String(r.player_id),
      playerName: String(r.player_name),
      sport: r.sport as Sport,
      teamAbbrev: r.team_abbrev as string | null,
      isBot: /^bot_/.test(String(r.username)),
    }));
  } catch {
    return [];
  }
}
