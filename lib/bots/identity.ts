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
 * Twelve bots, weighted toward the strategies that make a market rather than
 * just add noise. Momentum chases moves and creates trends; value pushes back
 * toward fair value and stops those trends running away. Noise exists so the
 * board is not perfectly predictable.
 */
const ROSTER: Strategy[] = [
  "momentum",
  "momentum",
  "momentum",
  "momentum",
  "value",
  "value",
  "value",
  "value",
  "value",
  "noise",
  "noise",
  "noise",
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
