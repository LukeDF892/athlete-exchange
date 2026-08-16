import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Player } from "./types";

import {
  CHANGE_WINDOWS,
  WINDOW_LABELS,
  type ChangeWindow,
  type PriceChange,
} from "./types";

export { CHANGE_WINDOWS, WINDOW_LABELS };
export type { ChangeWindow, PriceChange };

/** How far back each window reaches. "career" is handled separately. */
const WINDOW_MS: Record<Exclude<ChangeWindow, "career">, number> = {
  "1D": 24 * 60 * 60 * 1000,
  "1W": 7 * 24 * 60 * 60 * 1000,
  "1M": 30 * 24 * 60 * 60 * 1000,
  "1Y": 365 * 24 * 60 * 60 * 1000,
};

/**
 * Price change per athlete over a window.
 *
 * A window with no tick older than its start returns nothing for that athlete
 * rather than zero. That distinction matters: this market opened recently, so
 * for now most windows genuinely have no history, and reporting "0.00%" would
 * claim the price held steady for a year when in truth it did not exist. The
 * UI renders the absence as "—".
 *
 * "career" is different in kind — it is not a price change at all, but how far
 * today's performance value sits from the athlete's rookie season. That data
 * exists from day one, so it is the one window that always has an answer.
 */
export async function getPriceChanges(
  players: Player[],
  window: ChangeWindow
): Promise<Record<string, PriceChange>> {
  if (window === "career") {
    const out: Record<string, PriceChange> = {};
    for (const p of players) {
      const first = p.careerValue[0];
      if (!first || first.value <= 0) continue;
      out[p.id] = {
        abs: p.fairValue - first.value,
        pct: ((p.fairValue - first.value) / first.value) * 100,
      };
    }
    return out;
  }

  if (!isSupabaseConfigured()) return {};

  try {
    // Price history is public as of migration 0013 — a signed-out visitor sees
    // the same change columns as everyone else, rather than a board of dashes.
    const supabase = await createSupabaseServerClient();

    const since = new Date(Date.now() - WINDOW_MS[window]).toISOString();

    // Paged for the same reason getPlayers is: PostgREST silently caps a
    // response at 1,000 rows, and one tick per athlete per ingest means this
    // query passes that within a single day. Truncation here would not error —
    // it would just leave most of the board showing no change at all.
    const PAGE = 1000;
    const opening = new Map<string, number>();

    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("price_ticks")
        .select("player_id, ts, market_price")
        .gte("ts", since)
        .order("ts", { ascending: true })
        .range(from, from + PAGE - 1);

      if (error) break;
      const rows = (data ?? []) as Array<{ player_id: string; market_price: number }>;
      // Ordered oldest first, so the first tick seen per athlete is the open.
      for (const t of rows) {
        if (!opening.has(t.player_id)) opening.set(t.player_id, Number(t.market_price));
      }
      if (rows.length < PAGE) break;
      if (from > 200_000) break;
    }

    const out: Record<string, PriceChange> = {};
    for (const p of players) {
      const open = opening.get(p.id);
      if (open == null || open <= 0) continue;
      out[p.id] = {
        abs: p.marketPrice - open,
        pct: ((p.marketPrice - open) / open) * 100,
      };
    }
    return out;
  } catch {
    return {};
  }
}
