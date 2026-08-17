/**
 * Who the bots are.
 *
 * Bots are ordinary accounts. They sign in with a password and call
 * `execute_trade()` exactly as a person does, which is the whole point: they
 * are subject to the same position limits, the same cash checks and the same
 * rounding. A bot that wrote to `holdings` directly with the service key would
 * be able to do things no human can, and the prices it produced would be a
 * fiction rather than a market.
 *
 * Their names say what they are. Nobody should look at the leaderboard and
 * wonder whether they are losing to a person.
 *
 * Credentials are derived rather than stored: the password for bot *n* is an
 * HMAC of `BOT_SECRET` and the bot's index, so the scheduled run can sign in
 * without a secrets table, and rotating `BOT_SECRET` orphans every bot at once.
 */
import { createHmac } from "node:crypto";

export type Strategy = "momentum" | "value" | "noise";

export interface BotIdentity {
  index: number;
  username: string;
  email: string;
  strategy: Strategy;
}

/**
 * Fifty bots.
 *
 * Started at twelve, which moved prices but thinly — a slot woke three bots and
 * a quiet listing could go days untouched. Fifty wakes eight or nine per slot
 * across seventeen slots, so roughly twenty-five trades land every hour and a
 * listing outside the top hundred still gets touched.
 *
 * The mix was value-heavy to fix an early 158-buys-to-12-sells imbalance, and
 * overshot: with value bots the largest cohort, the market's dominant reflex
 * became fading whatever had just moved, so a human's own market impact was
 * arbitraged away within a slot. Now roughly even between momentum and value —
 * buying sometimes begets buying — and value bots can short, which gives them a
 * way to press an overpriced listing without needing to own it first.
 */
const ROSTER: Strategy[] = [
  ...Array<Strategy>(20).fill("momentum"),
  ...Array<Strategy>(18).fill("value"),
  ...Array<Strategy>(12).fill("noise"),
];

export function botRoster(): BotIdentity[] {
  return ROSTER.map((strategy, i) => {
    const index = i + 1;
    return {
      index,
      strategy,
      username: `bot_${strategy}_${index}`,
      // .invalid is reserved by RFC 2606 and can never resolve, so these
      // addresses cannot accidentally mail a real person.
      email: `bot-${index}@bots.athlete-exchange.invalid`,
    };
  });
}

/** Deterministic per-bot password. Requires BOT_SECRET to be set. */
export function botPassword(index: number): string {
  const secret = process.env.BOT_SECRET;
  if (!secret) throw new Error("BOT_SECRET is not set — bots cannot sign in");
  // Prefixed to satisfy any password policy that wants mixed character classes.
  return `Bx1!${createHmac("sha256", secret).update(`bot-${index}`).digest("hex").slice(0, 32)}`;
}

/** True for usernames this module owns, used to label them in the UI. */
export function isBotUsername(username: string): boolean {
  return /^bot_(momentum|value|noise)_\d+$/.test(username);
}

/**
 * When trading happens, in UTC hours.
 *
 * Every bot used to fire in one eight-second burst, which put a day's
 * worth of movement into a single instant: the price chart showed one vertical
 * step and nothing else, which is not what a market looks like.
 *
 * Vercel's Hobby plan caps each cron job at one run per day, but allows a
 * hundred jobs — so spreading the day is a matter of scheduling several jobs at
 * different hours rather than one frequent job. Each of these hours is its own
 * entry in vercel.json.
 *
 * Twenty-minute slots were still bursts: a handful of orders in fifteen seconds
 * and then nothing for the rest of the twenty minutes. Two things fix that
 * together — firing points every ten minutes, and a run that *spreads its
 * orders across its whole five-minute budget* rather than emptying them at
 * once. Between them the market is doing something roughly every twenty
 * seconds, with a pause of about five minutes between runs rather than twenty.
 *
 * Ninety slots is close to Hobby's hundred-job ceiling, four of which the
 * refresh already uses. That ceiling is the reason the day stops at 02:00
 * rather than 04:00: coverage was worth more than the last two hours.
 *
 * Hobby's scheduling is only accurate to the hour, so a job set for 14:20 may
 * land anywhere in that hour. That is why each cron entry names its own slot in
 * the query string rather than letting the route infer one from the clock: the
 * batch that runs is decided by which job fired, not by when it happened to.
 * The jitter then works in our favour, scattering the three firings within the
 * hour instead of pinning them to the same minutes every day.
 *
 * The 04:00-10:00 gap is deliberate — that is the small hours in Atlantic time,
 * and a market that is quiet overnight reads as a market rather than a machine.
 */
export const SLOT_TIMES: ReadonlyArray<{ hour: number; minute: number }> = (() => {
  const hours = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1];
  return hours.flatMap((hour) => [0, 10, 20, 30, 40, 50].map((minute) => ({ hour, minute })));
})();

/** Kept for the clock fallback and for tests that reason about coverage. */
export const SLOT_HOURS = SLOT_TIMES.map((t) => t.hour);

/**
 * Which bots trade in a given slot.
 *
 * Each slot wakes about four bots, and each bot trades in seven or eight of the
 * ninety slots. Four bots is enough orders to keep a five-minute run busy once
 * they are spaced out, without any one bot trading so often it runs out of cash. Staggering by `(index + slot)` rather than by strategy
 * means momentum and value bots are rarely awake together in the same slot — so
 * a price gets pushed in one slot and argued with a few hours later, instead of
 * both happening at once and cancelling out.
 */
export function botsForSlot(slot: number): BotIdentity[] {
  return botRoster().filter((b) => (b.index + slot) % 12 === 0);
}

/**
 * The slot that most recently began.
 *
 * Only a fallback: every scheduled run names its own slot in the query string,
 * because Hobby fires a job anywhere within its hour and inferring the batch
 * from the clock would let jitter pick the wrong one. This exists for manual
 * runs.
 *
 * The trading day wraps past midnight (11:00 through 03:40), so "most recent"
 * cannot be a simple scan for the largest time at or before now — after
 * midnight every evening slot is numerically *ahead*, and a naive scan lands on
 * the wrong end of the list. Measuring how long ago each slot fired, modulo a
 * day, is correct across the wrap.
 */
export function currentSlot(now = new Date()): number | null {
  if (SLOT_TIMES.length === 0) return null;
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();

  let best = 0;
  let bestAge = Number.POSITIVE_INFINITY;
  SLOT_TIMES.forEach((t, i) => {
    const age = (mins - (t.hour * 60 + t.minute) + 1440) % 1440;
    if (age < bestAge) {
      bestAge = age;
      best = i;
    }
  });
  return best;
}
