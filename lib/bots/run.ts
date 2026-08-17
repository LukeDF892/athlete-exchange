/**
 * Run a day of bot trading.
 *
 * Each bot signs in as itself and calls `execute_trade()`, so every order goes
 * through exactly the same function a person's order does — the position cap,
 * the cash check, the settled-listing guard and the cent-exact rounding all
 * apply. Nothing here can move a price in a way a human could not.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Player } from "@/lib/market/types";
import { botRoster, botPassword, botsForSlot, currentSlot } from "./identity";
import { decide, makeRng, type BotView } from "./strategies";

export interface BotRunResult {
  bots: number;
  signedIn: number;
  ordersPlaced: number;
  ordersRejected: number;
  volume: number;
  /** Which trading slot ran, or "all" for a manual run. */
  slot: number | string | null;
  log: string[];
}

/** A listing a bot is allowed to touch. */
function tradeable(p: Player): boolean {
  return p.status !== "settled" && p.marketPrice > 0 && p.liquidityDepth > 0;
}

/**
 * Day-over-day percentage change per listing, which is what momentum reads.
 *
 * Computed from `prev_close` rather than the tick table: the ingest already
 * records the previous market price on every listing, so this needs no extra
 * query and is exactly the number the board's own change column shows.
 */
function changeMap(players: Player[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of players) {
    if (p.prevClose && p.prevClose > 0) {
      out[p.id] = ((p.marketPrice - p.prevClose) / p.prevClose) * 100;
    }
  }
  return out;
}

/**
 * Every listing, paged.
 *
 * Only the handful of fields a trading decision needs — sending the full row
 * for 3,700 listings would pull stat tables and game logs the bots never read.
 * Paged because PostgREST silently caps a response at 1,000 rows.
 */
async function readBoard(url: string, anon: string): Promise<Player[]> {
  const db = createClient(url, anon, { auth: { persistSession: false } });
  const out: Player[] = [];
  const PAGE = 1000;

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("players")
      .select(
        "id, full_name, sport, fair_value, market_price, prev_close, shares_outstanding, liquidity_depth, status"
      )
      .order("market_price", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) break;
    const rows = data ?? [];
    for (const r of rows) {
      out.push({
        id: String(r.id),
        fullName: String(r.full_name),
        sport: r.sport,
        fairValue: Number(r.fair_value),
        marketPrice: Number(r.market_price),
        prevClose: r.prev_close == null ? null : Number(r.prev_close),
        sharesOutstanding: Number(r.shares_outstanding),
        liquidityDepth: Number(r.liquidity_depth),
        status: (r.status as string) ?? "active",
      } as Player);
    }
    if (rows.length < PAGE) break;
    if (out.length >= 20_000) break;
  }
  return out;
}

export interface RunOptions {
  seed?: number;
  /** Which trading slot to run. Defaults to whichever one the clock is in. */
  slot?: number | null;
  /** Ignore slots and wake every bot — for a manual run, never the cron. */
  all?: boolean;
}

export async function runBots(options: RunOptions = {}): Promise<BotRunResult> {
  const seed = options.seed ?? Date.now();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const result: BotRunResult = {
    bots: 0,
    signedIn: 0,
    ordersPlaced: 0,
    ordersRejected: 0,
    volume: 0,
    slot: null,
    log: [],
  };
  if (!url || !anon || !process.env.BOT_SECRET) {
    result.log.push("bots disabled — BOT_SECRET or Supabase keys missing");
    return result;
  }

  // Read the board with a plain keyless client rather than the app's
  // request-scoped one. Market data is public (migration 0013), so no session
  // is needed — and depending on `cookies()` would tie the bots to running
  // inside a request, which they do not.
  const all = await readBoard(url, anon);
  const players = all.filter(tradeable);
  if (players.length === 0) {
    result.log.push("no tradeable listings");
    return result;
  }
  const change = changeMap(players);

  // Only the bots whose slot this is. Waking all twelve at once is what made
  // the chart a single vertical step instead of a day's trading.
  const slot = options.slot ?? currentSlot();
  const roster = options.all
    ? botRoster()
    : slot == null
      ? []
      : botsForSlot(slot);

  result.slot = options.all ? "all" : slot;
  result.bots = roster.length;
  if (roster.length === 0) {
    result.log.push(
      slot == null && !options.all
        ? "before the first trading slot of the day — nothing to do"
        : `no bots assigned to slot ${slot}`
    );
    return result;
  }

  for (const bot of roster) {
    const rng = makeRng(seed + bot.index * 7919);
    let client: SupabaseClient;
    try {
      client = createClient(url, anon, { auth: { persistSession: false } });
      const { error } = await client.auth.signInWithPassword({
        email: bot.email,
        password: botPassword(bot.index),
      });
      if (error) {
        result.log.push(`${bot.username}: cannot sign in (${error.message})`);
        continue;
      }
      result.signedIn++;
    } catch (err) {
      result.log.push(`${bot.username}: ${err instanceof Error ? err.message : "sign-in failed"}`);
      continue;
    }

    try {
      const [{ data: profile }, { data: holdings }] = await Promise.all([
        client.from("profiles").select("cash_balance").maybeSingle(),
        // Every position, including negative ones. Filtering to `> 0` hid any
        // short a bot had accidentally opened, so it never covered — and a
        // later "sell" against a position the bot could not see opened a
        // *second* short on top.
        client.from("holdings").select("player_id, shares").neq("shares", 0),
      ]);

      const view: BotView = {
        players,
        change,
        held: new Map((holdings ?? []).map((h) => [String(h.player_id), Number(h.shares)])),
        cash: Number(profile?.cash_balance ?? 0),
      };

      /**
       * Close any short first, before anything else this bot does.
       *
       * Bots are meant to be long-only. They ended up holding five shorts
       * anyway, because `execute_trade` turns a sell with no position into a
       * short — so any drift between what a bot thought it held and what the
       * database held (two slots overlapping, a position closed moments
       * earlier) silently opened one. Covering here means such a position
       * cannot survive, whatever caused it.
       */
      const shorts = [...view.held.entries()].filter(([, n]) => n < 0);
      for (const [playerId, n] of shorts) {
        const { error } = await client.rpc("execute_trade", {
          p_player_id: playerId,
          p_side: "buy",
          p_shares: Math.abs(n),
        });
        if (error) {
          result.ordersRejected++;
          continue;
        }
        result.ordersPlaced++;
        view.held.delete(playerId);
        result.log.push(`${bot.username} cover ${Math.abs(n)} — bots do not hold shorts`);
      }

      for (const order of decide(bot.strategy, view, rng)) {
        /**
         * Never sell more than is actually held at this instant.
         *
         * `decide()` works from a snapshot taken before the first order; by the
         * time a later order runs, an earlier one has already moved the
         * position. Selling into that gap is exactly how an unintended short
         * gets opened, so the size is re-checked against the live row.
         */
        if (order.side === "sell") {
          const { data: cur } = await client
            .from("holdings")
            .select("shares")
            .eq("player_id", order.playerId)
            .maybeSingle();
          const heldNow = Number(cur?.shares ?? 0);
          if (heldNow <= 0) continue;
          order.shares = Math.min(order.shares, heldNow);
        }

        const { data, error } = await client.rpc("execute_trade", {
          p_player_id: order.playerId,
          p_side: order.side,
          p_shares: order.shares,
        });
        if (error) {
          // Rejections are normal and informative: a bot hitting the position
          // cap or running out of cash is the limits doing their job, not a
          // bug, so they are counted rather than thrown.
          result.ordersRejected++;
          continue;
        }
        const net = Number((data as { net?: number } | null)?.net ?? 0);
        result.ordersPlaced++;
        result.volume += net;
        const name = players.find((p) => p.id === order.playerId)?.fullName ?? "?";
        result.log.push(
          `${bot.username} ${order.side} ${order.shares} ${name} — ${order.reason}`
        );
      }
    } finally {
      await client.auth.signOut();
    }
  }

  return result;
}
