/**
 * What actually moved.
 *
 * The board can be sorted by price, but a market's news is its *changes*, and
 * those were only visible by scanning three thousand rows for a coloured
 * number. The digest answers the question people open the site to ask: what is
 * different since yesterday, and why.
 *
 * Two kinds of movement are separated deliberately, because they mean opposite
 * things to a trader:
 *
 *   * **performance** — fair value moved, so the athlete genuinely played
 *     better or worse (or got hurt). This is new information.
 *   * **market** — the price moved but fair value did not, so opinion moved.
 *     This is other traders, not the athlete.
 *
 * Collapsing them into one "movers" list would tell you a price changed while
 * hiding the only part that says whether it should have.
 */
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Player } from "./types";

export interface Mover {
  player: Player;
  from: number;
  to: number;
  abs: number;
  pct: number;
}

export interface Digest {
  /** When the oldest tick in the comparison was taken. */
  since: string | null;
  performance: { up: Mover[]; down: Mover[] };
  market: { up: Mover[]; down: Mover[] };
  /** Athletes whose injury status is currently discounting their price. */
  injured: Player[];
  /** True when price history exists at all — false on a brand new database. */
  hasHistory: boolean;
}

const EMPTY: Digest = {
  since: null,
  performance: { up: [], down: [] },
  market: { up: [], down: [] },
  injured: [],
  hasHistory: false,
};

const PAGE = 1000;
const LOOKBACK_HOURS = 36;

interface Tick {
  player_id: string;
  ts: string;
  market_price: number;
  fair_value: number;
}

/**
 * The day's movement.
 *
 * Compares each listing's current values against its oldest tick inside the
 * lookback. The window is 36 hours rather than 24 so a refresh that runs a
 * little late still finds yesterday's tick instead of silently reporting no
 * movement.
 */
export async function getDigest(players: Player[], limit = 8): Promise<Digest> {
  if (!isSupabaseConfigured()) return EMPTY;

  try {
    // Price history is public as of migration 0013, so the digest is too — it
    // is the page most likely to make a first-time visitor understand what this
    // market is, and it was showing them an empty state.
    const supabase = await createSupabaseServerClient();

    const since = new Date(Date.now() - LOOKBACK_HOURS * 3600_000).toISOString();

    // Paginated: PostgREST caps a response at 1,000 rows without saying so, and
    // one tick per listing per day is already several thousand.
    const ticks: Tick[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("price_ticks")
        .select("player_id, ts, market_price, fair_value")
        .gte("ts", since)
        .order("ts", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) break;
      const rows = (data ?? []) as Tick[];
      ticks.push(...rows);
      if (rows.length < PAGE) break;
      if (ticks.length >= 40_000) break;
    }

    if (ticks.length === 0) return { ...EMPTY, injured: injuredFrom(players) };

    // Ascending order means the first tick seen per listing is the oldest.
    const oldest = new Map<string, Tick>();
    for (const t of ticks) if (!oldest.has(t.player_id)) oldest.set(t.player_id, t);

    const byId = new Map(players.map((p) => [p.id, p]));
    const performance: Mover[] = [];
    const market: Mover[] = [];

    for (const [playerId, tick] of oldest) {
      const player = byId.get(playerId);
      if (!player) continue;

      const fvFrom = Number(tick.fair_value);
      if (fvFrom > 0 && Math.abs(player.fairValue - fvFrom) > 0.005) {
        performance.push({
          player,
          from: fvFrom,
          to: player.fairValue,
          abs: player.fairValue - fvFrom,
          pct: ((player.fairValue - fvFrom) / fvFrom) * 100,
        });
      }

      const mpFrom = Number(tick.market_price);
      // Only counted as market movement when fair value held still — otherwise
      // it is the performance move above, showing up a second time.
      const fundamentalsHeld = fvFrom > 0 && Math.abs(player.fairValue - fvFrom) <= 0.005;
      if (mpFrom > 0 && fundamentalsHeld && Math.abs(player.marketPrice - mpFrom) > 0.005) {
        market.push({
          player,
          from: mpFrom,
          to: player.marketPrice,
          abs: player.marketPrice - mpFrom,
          pct: ((player.marketPrice - mpFrom) / mpFrom) * 100,
        });
      }
    }

    const byPct = (a: Mover, b: Mover) => b.pct - a.pct;
    const top = (list: Mover[], dir: "up" | "down") =>
      list
        .filter((m) => (dir === "up" ? m.pct > 0 : m.pct < 0))
        .sort(dir === "up" ? byPct : (a, b) => a.pct - b.pct)
        .slice(0, limit);

    return {
      since: ticks[0]?.ts ?? null,
      performance: { up: top(performance, "up"), down: top(performance, "down") },
      market: { up: top(market, "up"), down: top(market, "down") },
      injured: injuredFrom(players, limit),
      hasHistory: true,
    };
  } catch {
    return EMPTY;
  }
}

export interface PersonalDigest {
  /** Movement in listings you hold, largest effect on your money first. */
  holdings: Array<Mover & { shares: number; valueChange: number }>;
  /** Movement in listings you follow but do not own. */
  watching: Mover[];
  /** Listings you hold that are retiring, soonest first. */
  retiring: Player[];
}

/**
 * The same movement, narrowed to what a trader actually owns.
 *
 * The market-wide digest answers "what happened today"; this answers "what
 * happened to me", which is the question people actually have. Holdings are
 * ranked by the cash effect rather than the percentage, because a 2% move on a
 * large position matters more than a 30% move on one share — ranking by percent
 * would put the trivia first.
 */
export async function getPersonalDigest(players: Player[]): Promise<PersonalDigest | null> {
  const empty: PersonalDigest = { holdings: [], watching: [], retiring: [] };
  if (!isSupabaseConfigured()) return null;

  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    const [{ data: holdingRows }, { data: watchRows }] = await Promise.all([
      supabase.from("holdings").select("player_id, shares").gt("shares", 0),
      supabase.from("watchlist").select("player_id"),
    ]);

    const held = new Map(
      (holdingRows ?? []).map((h) => [String(h.player_id), Number(h.shares)])
    );
    const watched = new Set((watchRows ?? []).map((w) => String(w.player_id)));
    if (held.size === 0 && watched.size === 0) return empty;

    // The market digest already did the tick comparison; reuse it rather than
    // querying price history a second time.
    const market = await getDigest(players, 5000);
    return buildPersonalDigest(players, market, held, watched);
  } catch {
    return null;
  }
}

/**
 * The pure half, shared by the signed-in page and the scheduled email.
 *
 * Split out because the email runs from a cron with no user session and so
 * cannot reuse the request-scoped Supabase client. Both callers must produce
 * the same digest or the email would describe a different day than the page.
 */
export function buildPersonalDigest(
  players: Player[],
  market: Digest,
  held: Map<string, number>,
  watched: Set<string>
): PersonalDigest {
  const all = [
    ...market.performance.up,
    ...market.performance.down,
    ...market.market.up,
    ...market.market.down,
  ];

  const byDbId = new Map(players.map((p) => [p.id, p]));
  const holdings: PersonalDigest["holdings"] = [];
  const watching: Mover[] = [];

  for (const m of all) {
    const shares = held.get(m.player.id);
    if (shares != null) {
      holdings.push({ ...m, shares, valueChange: m.abs * shares });
    } else if (watched.has(m.player.id)) {
      watching.push(m);
    }
  }

  holdings.sort((a, b) => Math.abs(b.valueChange) - Math.abs(a.valueChange));
  watching.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));

  const retiring = [...held.keys()]
    .map((id) => byDbId.get(id))
    .filter((p): p is Player => p != null && p.status === "retiring")
    .sort((a, b) => (a.settlesAt ?? "").localeCompare(b.settlesAt ?? ""));

  return { holdings: holdings.slice(0, 10), watching: watching.slice(0, 5), retiring };
}

/** Currently injured listings, most heavily discounted first. */
function injuredFrom(players: Player[], limit = 8): Player[] {
  return players
    .filter((p) => p.injury != null && p.injury.multiplier < 1)
    .sort((a, b) => (a.injury!.multiplier ?? 1) - (b.injury!.multiplier ?? 1))
    .slice(0, limit);
}
