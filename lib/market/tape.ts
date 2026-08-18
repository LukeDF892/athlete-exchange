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
import { toTapeEntry, type TapeEntry, type TapeRow } from "@/lib/market/tape-row";

export type { TapeEntry } from "@/lib/market/tape-row";

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

    return (data as TapeRow[]).map(toTapeEntry);
  } catch {
    return [];
  }
}


/**
 * Every trader's activity on one athlete.
 *
 * The player page previously showed only your own trades, which made a busy
 * listing look untouched — you could be the fifth person to buy someone that
 * day and see a single line. This is the same tape the homepage uses, narrowed
 * to one listing, so "what is everyone doing with this athlete" is answerable
 * from the page where you decide whether to join them.
 *
 * Same restraint as the market-wide tape: share counts and sides, never the
 * cash each trade moved.
 */
export async function getPlayerTape(playerId: string, limit = 20): Promise<TapeEntry[]> {
  if (!isSupabaseConfigured()) return [];
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("trade_tape")
      .select("*")
      .eq("player_id", playerId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error || !data) return [];

    return (data as TapeRow[]).map(toTapeEntry);
  } catch {
    return [];
  }
}
