/**
 * Put the exchange back to opening day.
 *
 * Every balance returns to $100,000, every position and trade is erased, and
 * every listing goes back to zero shares outstanding — which, because
 * `price(S) = fairValue × e^(S/L)` and S is now 0, means market price equals
 * fair value again for everyone. Price history is deleted too, so the change
 * columns read nothing rather than reporting a fall caused by the reset itself.
 *
 * This is irreversible and it destroys other people's data, so it refuses to do
 * anything without `--yes` on the command line. There is no environment
 * variable that enables it, deliberately: a flag someone can set once and forget
 * is how a reset ends up running in production by accident.
 *
 *   npm run reset:market -- --yes
 *
 * Watchlists are deliberately kept. Following an athlete is a preference, not a
 * balance, and silently unfollowing everyone would be a surprise nobody asked
 * for.
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { createClient } from "@supabase/supabase-js";

const PAGE = 1000;

async function main() {
  if (!process.argv.includes("--yes")) {
    console.error(
      "Refusing to run.\n\n" +
        "This deletes every trade, position, portfolio snapshot and price tick,\n" +
        "and resets every balance to $100,000. It cannot be undone.\n\n" +
        "Re-run with --yes if that is what you want:\n" +
        "  npm run reset:market -- --yes\n"
    );
    process.exit(1);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase keys missing — check .env.local");

  const db = createClient(url, key, { auth: { persistSession: false } });

  const count = async (table: string) => {
    const { count: n } = await db.from(table).select("*", { count: "exact", head: true });
    return n ?? 0;
  };

  console.log("Before:");
  for (const t of ["profiles", "holdings", "trades", "price_ticks", "portfolio_snapshots"]) {
    console.log(`  ${t.padEnd(20)} ${await count(t)}`);
  }

  // Order matters only for readability here — every one of these tables
  // cascades from profiles or players, and nothing references them back.
  // `neq` on a column that is never null is how PostgREST expresses
  // "delete everything"; it refuses an unfiltered delete on purpose.
  console.log("\nDeleting…");
  for (const t of ["trades", "holdings", "portfolio_snapshots"]) {
    const { error } = await db.from(t).delete().neq("user_id", "00000000-0000-0000-0000-000000000000");
    if (error) throw new Error(`${t}: ${error.message}`);
    console.log(`  ${t} cleared`);
  }
  {
    const { error } = await db.from("price_ticks").delete().gt("id", 0);
    if (error) throw new Error(`price_ticks: ${error.message}`);
    console.log("  price_ticks cleared");
  }

  console.log("\nResetting balances…");
  const { error: cashErr } = await db
    .from("profiles")
    .update({ cash_balance: 100000 })
    .neq("id", "00000000-0000-0000-0000-000000000000");
  if (cashErr) throw new Error(`profiles: ${cashErr.message}`);

  // Back onto the curve at S = 0. market_price is recomputed rather than copied
  // blindly: at zero shares the curve gives exactly fair value, so this is the
  // same number, but writing it as the formula keeps the two in step if the
  // curve ever changes.
  console.log("Reopening every listing at fair value…");
  const all: Array<{ id: string; fair_value: number }> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("players")
      .select("id, fair_value")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`players read: ${error.message}`);
    const rows = (data ?? []) as Array<{ id: string; fair_value: number }>;
    all.push(...rows);
    if (rows.length < PAGE) break;
  }

  // Grouped by price rather than updated row by row. PostgREST cannot express
  // "set market_price = fair_value" as an expression, and one request per
  // listing is ~3,700 round trips; bucketing by distinct fair value collapses
  // that to a few hundred, because the low end of the board is heavily
  // clustered around the $4 floor.
  const buckets = new Map<number, string[]>();
  for (const r of all) {
    const fv = Number(r.fair_value);
    const list = buckets.get(fv);
    if (list) list.push(r.id);
    else buckets.set(fv, [r.id]);
  }

  let touched = 0;
  const entries = [...buckets.entries()];
  const CONCURRENCY = 8;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (cursor < entries.length) {
        const [fv, ids] = entries[cursor++];
        // `in` has a URL length limit, so large buckets are chunked.
        for (let i = 0; i < ids.length; i += 200) {
          const slice = ids.slice(i, i + 200);
          const { error: upErr } = await db
            .from("players")
            .update({
              shares_outstanding: 0,
              market_price: fv,
              opening_fair_value: fv,
              prev_close: null,
            })
            .in("id", slice);
          if (upErr) throw new Error(`players update: ${upErr.message}`);
          touched += slice.length;
        }
      }
    })
  );
  console.log(`  ${touched} listings reopened across ${buckets.size} price buckets`);

  console.log("\nAfter:");
  for (const t of ["profiles", "holdings", "trades", "price_ticks", "portfolio_snapshots"]) {
    console.log(`  ${t.padEnd(20)} ${await count(t)}`);
  }
  const { data: sample } = await db
    .from("profiles")
    .select("username, cash_balance")
    .order("username")
    .limit(10);
  console.log("\nBalances:", JSON.stringify(sample));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
