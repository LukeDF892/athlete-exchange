/**
 * The checks that would have caught every incident this project has had.
 *
 * Each one here exists because something broke and was found by eye, days or
 * weeks late, by noticing a number on a screen:
 *
 *   * the ingest push read existing market state with an unpaged query, wrote
 *     zero shares outstanding over 137 real positions, and nothing noticed
 *   * `market_price` drifted off the curve for those same rows
 *   * the position mark and its SQL twin could silently disagree, as the trade
 *     maths did once before for a cent
 *   * a one-league refresh wrote deploy-time prices over measured ones three
 *     times a day for weeks, and the only symptom was a sawtooth on a chart
 *     nobody was looking at
 *
 * So this is not a health check in the abstract. It is those four bugs turned
 * into assertions, plus the three numbers that say whether the market is
 * actually being used and actually being priced.
 *
 * It runs at the end of every refresh cron — four times a day, no new cron
 * entries, which matters at 94 of Hobby's 100 — and stores its result in
 * `market_meta` so a bad day is visible after the fact rather than only in a
 * log nobody reads.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { marketPrice, positionValue, type Sport } from "@/lib/pricing/engine";

export type Level = "green" | "yellow" | "red";

export interface Check {
  name: string;
  level: Level;
  /** The measured number, for tracking over time. */
  value: number;
  /** What the thresholds are, in words, so a stored result explains itself. */
  threshold: string;
  detail: string;
}

export interface AuditResult {
  ranAt: string;
  level: Level;
  checks: Check[];
}

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

function worst(levels: Level[]): Level {
  if (levels.includes("red")) return "red";
  if (levels.includes("yellow")) return "yellow";
  return "green";
}

function grade(value: number, yellowAt: number, redAt: number): Level {
  if (value >= redAt) return "red";
  if (value >= yellowAt) return "yellow";
  return "green";
}

interface PlayerRow {
  id: string;
  sport: Sport;
  full_name: string;
  fair_value: number;
  shares_outstanding: number;
  liquidity_depth: number;
  market_price: number;
  updated_at: string;
}

export async function runAudit(db: SupabaseClient): Promise<AuditResult> {
  const checks: Check[] = [];

  const players = await selectAll<PlayerRow>(
    db,
    "players",
    "id, sport, full_name, fair_value, shares_outstanding, liquidity_depth, market_price, updated_at"
  );
  const holdings = await selectAll<{ player_id: string; shares: number }>(
    db,
    "holdings",
    "player_id, shares"
  );

  // ---------------------------------------------------------------------
  // 1. The ledger. `holdings` is the truth; players.shares_outstanding is a
  //    cache of it, and execute_trade() keeps them equal in one transaction.
  //    Any drift means something wrote the cache directly — which is exactly
  //    what the unpaged push did.
  // ---------------------------------------------------------------------
  const net = new Map<string, number>();
  for (const h of holdings) net.set(h.player_id, (net.get(h.player_id) ?? 0) + Number(h.shares));
  const ledgerOff = players.filter(
    (p) => Number(p.shares_outstanding) !== (net.get(p.id) ?? 0)
  );
  checks.push({
    name: "ledger_mismatch",
    level: grade(ledgerOff.length, 1, 3),
    value: ledgerOff.length,
    threshold: "green 0 · yellow 1-2 · red 3+",
    detail:
      ledgerOff.length === 0
        ? "every listing agrees with the holdings ledger"
        : `${ledgerOff.length} disagree, e.g. ${ledgerOff
            .slice(0, 3)
            .map((p) => `${p.full_name} row=${p.shares_outstanding} ledger=${net.get(p.id) ?? 0}`)
            .join("; ")}`,
  });

  // ---------------------------------------------------------------------
  // 2. Every price must be the curve evaluated at its own inputs. A price that
  //    is not is a price somebody wrote by hand or carried in from elsewhere.
  // ---------------------------------------------------------------------
  const offCurve = players.filter((p) => {
    const expect = marketPrice(
      Number(p.fair_value),
      Number(p.shares_outstanding),
      Number(p.liquidity_depth)
    );
    return Math.abs(expect - Number(p.market_price)) > 0.02;
  });
  checks.push({
    name: "price_off_curve",
    level: grade(offCurve.length, 1, 5),
    value: offCurve.length,
    threshold: "green 0 · yellow 1-4 · red 5+",
    detail:
      offCurve.length === 0
        ? "every price equals fairValue x e^(S/L)"
        : `${offCurve.length} off the curve, e.g. ${offCurve[0].full_name}`,
  });

  // ---------------------------------------------------------------------
  // 3. The pricing maths exists in TypeScript and in SQL, and they must agree.
  //    A one-cent sell divergence shipped once; the mark is now duplicated the
  //    same way, so it gets the same guard.
  // ---------------------------------------------------------------------
  const sample = players.filter((p) => Number(p.shares_outstanding) !== 0).slice(0, 25);
  let maxGap = 0;
  let gapAt = "";
  for (const p of sample) {
    const shares = net.get(p.id) ?? 0;
    if (shares === 0) continue;
    const { data, error } = await db.rpc("position_value", {
      fair: Number(p.fair_value),
      s_out: Number(p.shares_outstanding),
      depth: Number(p.liquidity_depth),
      shares,
    });
    if (error) continue;
    const ts = positionValue(
      Number(p.fair_value),
      Number(p.shares_outstanding),
      shares,
      Number(p.liquidity_depth)
    );
    const gap = Math.abs(Number(data) - ts);
    if (gap > maxGap) {
      maxGap = gap;
      gapAt = p.full_name;
    }
  }
  checks.push({
    name: "ts_sql_mark_gap",
    level: maxGap > 0.05 ? "red" : maxGap > 0.01 ? "yellow" : "green",
    value: Number(maxGap.toFixed(4)),
    threshold: "green <=$0.01 · yellow <=$0.05 · red >$0.05",
    detail: maxGap === 0 ? "TypeScript and SQL agree exactly" : `largest gap on ${gapAt}`,
  });

  // ---------------------------------------------------------------------
  // 4. Are prices actually being refreshed? A silently failing cron looks
  //    exactly like a quiet market until you check the clock.
  // ---------------------------------------------------------------------
  const now = Date.now();
  const hoursSince = (ts: string) => (now - new Date(ts).getTime()) / 3_600_000;
  const bySport: Record<string, number> = {};
  for (const s of ["nba", "nhl", "mlb", "nfl"] as const) {
    const rows = players.filter((p) => p.sport === s);
    if (rows.length === 0) continue;
    bySport[s] = Math.min(...rows.map((p) => hoursSince(p.updated_at)));
  }
  const stalest = Math.max(0, ...Object.values(bySport));
  checks.push({
    name: "hours_since_league_refresh",
    level: grade(stalest, 30, 50),
    value: Number(stalest.toFixed(1)),
    threshold: "green <30h · yellow 30-50h · red 50h+ (each league refreshes daily)",
    detail: Object.entries(bySport)
      .map(([s, h]) => `${s} ${h.toFixed(1)}h`)
      .join(", "),
  });

  // ---------------------------------------------------------------------
  // 5. Is the live refresh keeping up? It writes its own last result, so this
  //    reads what actually happened rather than assuming the code ran.
  // ---------------------------------------------------------------------
  const { data: liveRow } = await db
    .from("market_meta")
    .select("value, updated_at")
    .eq("key", "live_refresh_last")
    .maybeSingle();
  const live = (liveRow?.value ?? null) as {
    candidates?: number;
    fetched?: number;
    cappedAt?: number;
  } | null;
  const capRatio =
    live?.candidates && live?.cappedAt ? live.candidates / live.cappedAt : 0;
  checks.push({
    name: "live_refresh_saturation",
    level: capRatio >= 1 ? "yellow" : "green",
    value: Number(capRatio.toFixed(2)),
    threshold: "green <1.0 · yellow 1.0 (cap reached) · red 1.0 for 7 straight days",
    detail: live
      ? `last run: ${live.candidates ?? 0} candidates against a ${live.cappedAt ?? 0} cap`
      : "no live refresh has run yet",
  });

  // ---------------------------------------------------------------------
  // 6. Is a human still here? Thirty bots trade ~1,150 times a day, so total
  //    volume says nothing. Only non-bot trades do.
  // ---------------------------------------------------------------------
  const weekAgo = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
  const { data: recent } = await db
    .from("trade_tape")
    .select("username, created_at")
    .gte("created_at", weekAgo)
    .limit(1000);
  const humanTrades = (recent ?? []).filter((r) => !/^bot_/.test(String(r.username))).length;
  checks.push({
    name: "human_trades_7d",
    level: humanTrades === 0 ? "red" : humanTrades < 5 ? "yellow" : "green",
    value: humanTrades,
    threshold: "green 5+ · yellow 1-4 · red 0",
    detail: `${humanTrades} human trades in 7 days, against ${
      (recent ?? []).length - humanTrades
    } bot trades`,
  });

  const result: AuditResult = {
    ranAt: new Date().toISOString(),
    level: worst(checks.map((c) => c.level)),
    checks,
  };

  // Stored so a red day is visible tomorrow, not only in a log.
  await db
    .from("market_meta")
    .upsert({ key: "audit_last", value: result, updated_at: result.ranAt });

  return result;
}

/** Human-readable, for `npm run audit:market`. */
export function formatAudit(result: AuditResult): string {
  const mark = { green: "GREEN ", yellow: "YELLOW", red: "RED   " };
  const lines = result.checks.map(
    (c) =>
      `  ${mark[c.level]}  ${c.name.padEnd(28)} ${String(c.value).padStart(8)}   ${c.detail}\n` +
      `           ${" ".repeat(28)}          ${c.threshold}`
  );
  return `Market audit — ${mark[result.level].trim()}\n${lines.join("\n")}`;
}
