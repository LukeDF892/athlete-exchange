/**
 * What each bot decides to do.
 *
 * Pure functions over a snapshot of the board and the bot's own position, so
 * the decision logic is testable without a database, a session, or a market.
 *
 * The three strategies exist to produce a market rather than a drift. Momentum
 * alone would run every price to infinity; value alone would pin every price to
 * fair value and nothing would ever move. Together they argue, and the argument
 * is what volatility actually is.
 */
import type { Player } from "@/lib/market/types";
import { positionLimit, quoteBuy } from "@/lib/pricing/engine";
import type { Strategy } from "./identity";

export interface BotView {
  /** Listings the bot may trade, already filtered to tradeable ones. */
  players: Player[];
  /** Percentage change per listing id over the last day, where known. */
  change: Record<string, number>;
  /** Shares the bot currently holds, by listing id. */
  held: Map<string, number>;
  cash: number;
}

export interface BotOrder {
  playerId: string;
  side: "buy" | "sell";
  shares: number;
  /**
   * Whether this sell closes a position or opens a short.
   *
   * `execute_trade` turns an unbacked sell into a short, so without this a bot
   * that tried to close a position it had already closed opened one by
   * accident — which is exactly what happened. The runner requires holdings for
   * a "close" and requires their absence for an "open", so the accident stays
   * impossible while deliberate shorting becomes available.
   */
  intent: "close" | "open";
  /** Why, for the run log — makes a weird market explainable afterwards. */
  reason: string;
}

/** Deterministic per-run randomness, so a bad day can be reproduced. */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    // xorshift32 — small, fast, and good enough to pick trades with.
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

function pick<T>(rng: () => number, items: T[]): T | null {
  return items.length === 0 ? null : items[Math.floor(rng() * items.length)];
}

/**
 * How many shares to buy for a target spend.
 *
 * Solved by walking up rather than inverting the curve: the cost of n shares is
 * an integral, and a closed-form inverse would have to be kept in step with the
 * pricing engine forever. Doubling then bisecting is a few dozen cheap calls and
 * cannot drift away from the real cost function.
 */
export function sharesForBudget(player: Player, budget: number, maxShares: number): number {
  if (budget <= 0 || maxShares <= 0) return 0;
  const cost = (n: number) => {
    try {
      return quoteBuy(player.fairValue, player.sharesOutstanding, n, player.liquidityDepth).net;
    } catch {
      return Infinity;
    }
  };
  if (cost(1) > budget) return 0;

  let lo = 1;
  let hi = 1;
  while (hi < maxShares && cost(hi * 2) <= budget) hi *= 2;
  hi = Math.min(hi * 2, maxShares);

  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (cost(mid) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Room left before this bot hits the per-listing cap. */
function headroom(player: Player, held: number): number {
  return Math.max(0, positionLimit(player.liquidityDepth) - held);
}

/**
 * One bot's orders for one run.
 *
 * Deliberately small: two to four trades each. Twelve bots trading a handful of
 * times is a market ticking over; twelve bots trading hundreds of times is a
 * denial-of-service attack on your own database.
 */
export function decide(strategy: Strategy, view: BotView, rng: () => number): BotOrder[] {
  const orders: BotOrder[] = [];
  const count = 2 + Math.floor(rng() * 3);

  // Never risk everything on one run; a bot that goes to zero stops being a
  // market participant and just sits there.
  let budget = view.cash * 0.35;

  // Selling first frees cash and is what makes a bot capable of taking profit
  // rather than only ever accumulating.
  const holdings = [...view.held.entries()]
    .map(([id, shares]) => ({ player: view.players.find((p) => p.id === id), shares }))
    .filter((h): h is { player: Player; shares: number } => h.player != null && h.shares > 0);

  /**
   * A premium only counts if it was already there this morning.
   *
   * Bots were reacting to the instantaneous price, which on this curve moves
   * the moment anyone buys — so a human purchase manufactured a sell signal for
   * the largest cohort of bots and their own market impact was arbitraged away
   * within one slot. Measuring the *opening* price as well means a bot responds
   * to a listing that has stayed expensive, not to the footprint of whoever
   * just traded it.
   */
  const persistentPremium = (p: Player): number => {
    if (p.fairValue <= 0) return 0;
    const now = ((p.marketPrice - p.fairValue) / p.fairValue) * 100;
    if (p.prevClose == null || p.prevClose <= 0) return now;
    const atOpen = ((p.prevClose - p.fairValue) / p.fairValue) * 100;
    // The smaller of the two: a price that only just spiked has a small
    // opening premium and therefore does not trigger.
    return Math.min(now, atOpen);
  };

  for (const h of holdings) {
    const premium = persistentPremium(h.player);
    const drop = view.change[h.player.id] ?? 0;

    /**
     * Thresholds loosened after the first days of real trading.
     *
     * The opening set (premium > 12%, drop < -6%, 25% noise) produced 158 buys
     * against 12 sells. Bots that almost never sell are not making a market,
     * they are a one-way bid — and because every buy walks a price up the
     * curve, the whole board drifts upward and everyone looks like a genius.
     * These are the same rules, just triggered where a real trader would act
     * rather than only at extremes.
     */
    let sell = false;
    let reason = "";
    if (strategy === "value" && premium > 6) {
      sell = true;
      reason = `trading ${premium.toFixed(1)}% above performance value`;
    } else if (strategy === "momentum" && drop < -3) {
      sell = true;
      reason = `momentum broke, down ${drop.toFixed(1)}%`;
    } else if (strategy === "noise" && rng() < 0.4) {
      sell = true;
      reason = "no particular reason";
    } else if (premium > 20) {
      // Any bot takes a profit that large. Leaving a listing 20% above its
      // performance value unsold is how a price detaches for good.
      sell = true;
      reason = `taking profit, ${premium.toFixed(1)}% above performance value`;
    }

    if (sell) {
      // Partial exits: a bot that always sells everything makes prices step
      // rather than move.
      const shares = Math.max(1, Math.floor(h.shares * (0.4 + rng() * 0.6)));
      orders.push({ playerId: h.player.id, side: "sell", shares, intent: "close", reason });
    }
    if (orders.length >= count) return orders;
  }

  // Candidates to buy, ranked by whatever this strategy believes in.
  const tradeable = view.players.filter((p) => headroom(p, view.held.get(p.id) ?? 0) > 0);
  let pool: Player[];

  if (strategy === "momentum") {
    pool = tradeable
      .filter((p) => (view.change[p.id] ?? 0) > 1.5)
      .sort((a, b) => (view.change[b.id] ?? 0) - (view.change[a.id] ?? 0))
      .slice(0, 40);
    // Nothing has moved yet — on a fresh market every change is zero, so fall
    // back to the most valuable listings rather than sitting the day out.
    if (pool.length === 0) pool = tradeable.slice(0, 60);
  } else if (strategy === "value") {
    pool = tradeable
      .filter((p) => p.marketPrice < p.fairValue * 0.98)
      .sort(
        (a, b) => a.marketPrice / a.fairValue - b.marketPrice / b.fairValue
      )
      .slice(0, 40);
    if (pool.length === 0) pool = tradeable.slice(0, 80);
  } else {
    pool = tradeable;
  }

  /**
   * Value bots short what has run far above performance value.
   *
   * Long-only bots can only ever push prices up, which is why the board drifted
   * and why nothing applied downward pressure to an overpriced listing except a
   * bot that happened to already own it. A bot that can sell something it does
   * not own behaves like a trader rather than a one-way bid.
   *
   * Gated on the *persistent* premium for the same reason as selling: shorting
   * the price someone just moved is fading their footprint, not the market.
   */
  if (strategy === "value" && orders.length < count) {
    const rich = tradeable
      .filter((p) => (view.held.get(p.id) ?? 0) === 0 && persistentPremium(p) > 15)
      .sort((a, b) => persistentPremium(b) - persistentPremium(a))
      .slice(0, 20);
    const target = pick(rng, rich);
    if (target) {
      // Collateral is 1.5x proceeds, so size against buying power, not cash.
      const spend = Math.min(budget * 0.5, 1200 + rng() * 4000);
      const cap = positionLimit(target.liquidityDepth);
      const shares = sharesForBudget(target, spend, cap);
      if (shares > 0) {
        orders.push({
          playerId: target.id,
          side: "sell",
          shares,
          intent: "open",
          reason: `${persistentPremium(target).toFixed(1)}% above performance value, shorting it`,
        });
        budget -= spend;
      }
    }
  }

  while (orders.length < count && budget > 50 && pool.length > 0) {
    const player = pick(rng, pool);
    if (!player) break;

    // Enough to move a price visibly, not enough to corner anything.
    const spend = Math.min(budget, 1500 + rng() * 9000);
    const cap = headroom(player, view.held.get(player.id) ?? 0);
    const shares = sharesForBudget(player, spend, cap);
    if (shares <= 0) {
      pool = pool.filter((p) => p.id !== player.id);
      continue;
    }

    orders.push({
      playerId: player.id,
      side: "buy",
      shares,
      intent: "open",
      reason:
        strategy === "momentum"
          ? `up ${(view.change[player.id] ?? 0).toFixed(1)}%`
          : strategy === "value"
            ? `${(((player.fairValue - player.marketPrice) / player.fairValue) * 100).toFixed(1)}% below performance value`
            : "no particular reason",
    });

    budget -= spend;
    pool = pool.filter((p) => p.id !== player.id);
  }

  return orders;
}
