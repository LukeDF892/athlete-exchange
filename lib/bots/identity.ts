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
 * Thirty bots, weighted toward value.
 *
 * Started at twelve, which moved prices but thinly — a slot woke three bots and
 * a quiet listing could go days untouched. Thirty wakes seven or eight per slot,
 * so the board ticks over continuously rather than in visible bursts.
 *
 * The mix is deliberately value-heavy rather than an even split. Value bots are
 * the ones that *sell* into a premium, and the first week of real trading ran
 * 158 buys to 12 sells — momentum and noise both accumulate, so adding them in
 * equal measure would have made the upward drift worse rather than better.
 */
const ROSTER: Strategy[] = [
  ...Array<Strategy>(9).fill("momentum"),
  ...Array<Strategy>(14).fill("value"),
  ...Array<Strategy>(7).fill("noise"),
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
 * Hobby scheduling is only accurate to the hour (a job set for 14:00 fires
 * somewhere in 14:00-14:59), which is a feature here: trades do not land at
 * predictable clock times.
 */
export const SLOT_HOURS = [13, 15, 16, 18, 19, 21, 22, 23] as const;

/**
 * Which bots trade in a given slot.
 *
 * Each bot is active in two of the eight slots, and each slot wakes roughly a
 * quarter of the roster. Staggering by `(index + slot)` rather than by strategy means momentum
 * and value bots are rarely awake together in the same slot — so a price gets
 * pushed in one slot and argued with a few hours later, instead of both
 * happening at once and cancelling out.
 */
export function botsForSlot(slot: number): BotIdentity[] {
  return botRoster().filter((b) => (b.index + slot) % 4 === 0);
}

/**
 * The slot that most recently began, or null before the first one of the day.
 *
 * Derived from the hour rather than from an exact time so a cron that fires 40
 * minutes late still resolves to the slot it was scheduled for.
 */
export function currentSlot(now = new Date()): number | null {
  const hour = now.getUTCHours();
  let found: number | null = null;
  SLOT_HOURS.forEach((h, i) => {
    if (hour >= h) found = i;
  });
  return found;
}
