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

    // The signup trigger creates the profile row, but it reads the username
    // from metadata only at creation — so set it explicitly, and top the
    // balance back up in case this is a post-reset run.
    const { error: upErr } = await db
      .from("profiles")
      .update({ username: bot.username, cash_balance: 100000 })
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
