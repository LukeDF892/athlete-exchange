/**
 * A bot's open positions, readable by anyone.
 *
 * Human traders are deliberately excluded. /terms promises that other users can
 * see your username and net worth and nothing else, and three real accounts
 * signed up under that promise — so making everyone's holdings public would
 * break a commitment rather than add a feature. Bots agreed to nothing, and
 * showing what they hold makes their strategies legible: you can see the value
 * bots buying discounts and the momentum bots chasing moves, which is the whole
 * reason they exist.
 */
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Sport } from "@/lib/pricing/engine";

export interface TraderPosition {
  playerId: string;
  playerName: string;
  sport: Sport;
  teamAbbrev: string | null;
  shares: number;
  avgCost: number;
  marketPrice: number;
  fairValue: number;
  marketValue: number;
  unrealizedPnl: number;
}

export async function getBotPositions(username: string): Promise<TraderPosition[]> {
  if (!isSupabaseConfigured()) return [];
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("bot_positions")
      .select("*")
      .eq("username", username);
    if (error || !data) return [];

    return data
      .map((r) => {
        const shares = Number(r.shares);
        const avgCost = Number(r.avg_cost);
        const marketPrice = Number(r.market_price);
        // Negative shares are a short: value is what covering would cost, so it
        // carries as negative and profit is still value minus basis.
        const marketValue = shares * marketPrice;
        return {
          playerId: String(r.player_id),
          playerName: String(r.player_name),
          sport: r.sport as Sport,
          teamAbbrev: r.team_abbrev as string | null,
          shares,
          avgCost,
          marketPrice,
          fairValue: Number(r.fair_value),
          marketValue,
          unrealizedPnl: marketValue - shares * avgCost,
        };
      })
      .sort((a, b) => Math.abs(b.marketValue) - Math.abs(a.marketValue));
  } catch {
    return [];
  }
}
