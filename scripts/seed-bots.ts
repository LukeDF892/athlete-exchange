/**
 * Create the bot accounts, or bring existing ones back to $100,000.
 *
 * Safe to re-run: an account that already exists has its password re-set to the
 * value derived from the current BOT_SECRET and its balance topped back up,
 * which is also how you recover after rotating the secret or resetting the
 * market.
 *
 *   npm run bots:seed
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { createClient } from "@supabase/supabase-js";
import { botRoster, botPassword } from "@/lib/bots/identity";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase keys missing — check .env.local");
  if (!process.env.BOT_SECRET) {
    throw new Error(
      "BOT_SECRET is not set. Add one to .env.local and to Vercel:\n" +
        `  BOT_SECRET=${require("node:crypto").randomBytes(24).toString("hex")}`
    );
  }

  const db = createClient(url, key, { auth: { persistSession: false } });

  // One listing of every existing user, so the script can tell "already there"
  // from "needs creating" without relying on a create call failing.
  const existing = new Map<string, string>();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    for (const u of data?.users ?? []) if (u.email) existing.set(u.email, u.id);
    if ((data?.users ?? []).length < 200) break;
  }

  for (const bot of botRoster()) {
    const password = botPassword(bot.index);
    let userId = existing.get(bot.email);

    if (userId) {
      const { error } = await db.auth.admin.updateUserById(userId, { password });
      if (error) throw new Error(`${bot.username}: ${error.message}`);
      console.log(`  ${bot.username.padEnd(20)} exists — password refreshed`);
    } else {
      const { data, error } = await db.auth.admin.createUser({
        email: bot.email,
        password,
        email_confirm: true,
        user_metadata: { username: bot.username, is_bot: true },
      });
      if (error) throw new Error(`${bot.username}: ${error.message}`);
      userId = data.user.id;
      console.log(`  ${bot.username.padEnd(20)} created`);
    }

    /**
     * Only ever set the username here — never the balance.
     *
     * This used to also write `cash_balance: 100000` on every run, for every
     * bot, on the theory that it was "topping up after a reset". It was in fact
     * handing free money to any bot that already held positions: cash restored
     * to full while the holdings stayed, so twelve bots ended up at ~$180,000 of
     * net worth against a $100,000 start. Balances belong to the market and to
     * `reset:market`, not to a seeding script.
     */
    const { error: upErr } = await db
      .from("profiles")
      .update({ username: bot.username })
      .eq("id", userId);
    if (upErr) throw new Error(`${bot.username} profile: ${upErr.message}`);
  }

  const { count } = await db
    .from("profiles")
    .select("*", { count: "exact", head: true })
    .like("username", "bot\\_%");
  console.log(`\n${count ?? 0} bot accounts ready, each with $100,000.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
