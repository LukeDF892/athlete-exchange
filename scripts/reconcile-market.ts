/**
 * Rebuilds `players` market state from the positions people actually hold.
 *
 * The bonding curve mints a share on every buy and burns one on every sell, so
 * `players.shares_outstanding` is not an independent fact — it is the sum of
 * every holding in that listing, and `execute_trade()` maintains both in one
 * transaction. That makes `holdings` the ground truth and this script a way
 * back from any state where the two disagree.
 *
 * They disagreed because the ingest push read existing market state with an
 * unpaged query. PostgREST caps a response at 1,000 rows without erroring, so
 * on a 5,476-row board four fifths of the listings looked new and were upserted
 * with zero shares outstanding and a price reset to fair value. Positions,
 * cash and trade history were untouched — only the market's memory of them —
 * so the damage is fully reconstructible:
 *
 *   shares_outstanding  <- sum of holdings (exact)
 *   liquidity_depth     <- solved from the last price tick, which recorded
 *                          price, fair value and shares together (exact to the
 *                          cent the tick was rounded to)
 *   market_price        <- marketPrice(fair_value, shares, depth), the same
 *                          function the app and execute_trade() use
 *
 * `opening_fair_value` is deliberately NOT guessed at. Nothing computes with it
 * (the day-change column reads prev_close), no record of the old value exists,
 * and inventing one would put a number in the database that nobody could
 * later explain.
 *
 * Dry by default. Pass --apply to write.
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { marketPrice } from "@/lib/pricing/engine";

const PAGE = 1000;

async function selectAll<T>(db: SupabaseClient, table: string, columns: string): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from(table).select(columns).range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    all.push(...rows);
    if (rows.length < PAGE) return all;
    if (all.length >= 100_000) return all;
  }
}

interface PlayerRow {
  id: string;
  full_name: string;
  shares_outstanding: number;
  market_price: number;
  fair_value: number;
  liquidity_depth: number;
}

interface TickRow {
  player_id: string;
  ts: string;
  market_price: number;
  fair_value: number;
  shares_outstanding: number;
}

/**
 * The liquidity depth that produced a recorded tick.
 *
 * price = fairValue x e^(S/L) inverts to L = S / ln(price/fairValue), but the
 * tick stored price rounded to the cent, so that inversion lands near the true
 * depth rather than on it. Depth is an integer, so the estimate is used only to
 * centre a search: the answer is the integer that reproduces the recorded price
 * exactly, preferring the one that also looks like liquidityDepth() built it
 * (round(openingFairValue x 45)) when several do.
 */
function depthFromTick(tick: TickRow): number | null {
  const { shares_outstanding: s, market_price: p, fair_value: fv } = tick;
  if (!s || fv <= 0 || p <= 0) return null;
  const ratio = Math.log(p / fv);
  if (!Number.isFinite(ratio) || ratio === 0) return null;

  const estimate = s / ratio;
  if (!Number.isFinite(estimate) || estimate <= 0) return null;

  const exact: number[] = [];
  for (let l = Math.max(600, Math.round(estimate) - 40); l <= Math.round(estimate) + 40; l++) {
    if (Math.round(fv * Math.exp(s / l) * 100) / 100 === p) exact.push(l);
  }
  if (exact.length === 0) return Math.max(600, Math.round(estimate));
  // Among depths that reproduce the price, prefer one on the x45 grid.
  const onGrid = exact.filter((l) => l % 45 === 0 || Math.abs(l - 45 * Math.round(l / 45)) <= 1);
  const pick = onGrid.length > 0 ? onGrid : exact;
  return pick[Math.floor(pick.length / 2)];
}

async function main() {
  const apply = process.argv.includes("--apply");
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  const players = await selectAll<PlayerRow>(
    db,
    "players",
    "id, full_name, shares_outstanding, market_price, fair_value, liquidity_depth"
  );
  const holdings = await selectAll<{ player_id: string; shares: number }>(
    db,
    "holdings",
    "player_id, shares"
  );

  const net = new Map<string, number>();
  for (const h of holdings) net.set(h.player_id, (net.get(h.player_id) ?? 0) + Number(h.shares));

  const wrong = players.filter((p) => Number(p.shares_outstanding) !== (net.get(p.id) ?? 0));
  console.log(
    `${players.length} listings, ${net.size} with holdings — ${wrong.length} disagree with the ledger`
  );
  if (wrong.length === 0) return;

  // Last recorded tick per affected listing, for the depth solve.
  const ticks = new Map<string, TickRow>();
  for (const chunk of chunk_(wrong.map((p) => p.id), 50)) {
    const { data, error } = await db
      .from("price_ticks")
      .select("player_id, ts, market_price, fair_value, shares_outstanding")
      .in("player_id", chunk)
      .order("ts", { ascending: false });
    if (error) throw error;
    for (const t of (data ?? []) as TickRow[]) if (!ticks.has(t.player_id)) ticks.set(t.player_id, t);
  }

  const updates: Array<{
    id: string;
    name: string;
    shares: number;
    depth: number;
    price: number;
    was: number;
    depthWas: number;
  }> = [];

  for (const p of wrong) {
    const shares = net.get(p.id) ?? 0;
    const tick = ticks.get(p.id);
    // Only a tick that recorded the same position can speak to the depth that
    // priced it; anything else is a different point on a different curve.
    const depth =
      tick && Number(tick.shares_outstanding) === shares
        ? (depthFromTick(tick) ?? Number(p.liquidity_depth))
        : Number(p.liquidity_depth);
    const price = marketPrice(Number(p.fair_value), shares, depth);
    updates.push({
      id: p.id,
      name: p.full_name,
      shares,
      depth,
      price,
      was: Number(p.market_price),
      depthWas: Number(p.liquidity_depth),
    });
  }

  updates.sort((a, b) => Math.abs(b.price - b.was) - Math.abs(a.price - a.was));
  console.log("\nLargest corrections:");
  for (const u of updates.slice(0, 12)) {
    console.log(
      `  ${u.name.padEnd(24)} S 0 -> ${String(u.shares).padStart(5)}  ` +
        `L ${u.depthWas} -> ${u.depth}  $${u.was.toFixed(2)} -> $${u.price.toFixed(2)}`
    );
  }

  if (!apply) {
    console.log(`\nDry run. Pass --apply to write ${updates.length} listings.`);
    return;
  }

  for (const u of updates) {
    const { error } = await db
      .from("players")
      .update({
        shares_outstanding: u.shares,
        liquidity_depth: u.depth,
        market_price: u.price,
        updated_at: new Date().toISOString(),
      })
      .eq("id", u.id);
    if (error) throw error;
  }
  console.log(`\nRepaired ${updates.length} listings.`);

  // A tick so the chart records the correction rather than jumping without
  // explanation between two points that disagree.
  const { error: tickErr } = await db.from("price_ticks").insert(
    updates.map((u) => ({
      player_id: u.id,
      market_price: u.price,
      fair_value: players.find((p) => p.id === u.id)!.fair_value,
      shares_outstanding: u.shares,
    }))
  );
  if (tickErr) throw tickErr;
  console.log(`Wrote ${updates.length} price ticks.`);
}

function* chunk_<T>(arr: T[], size: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
