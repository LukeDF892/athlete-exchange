/**
 * What the operator can see.
 *
 * Everything here is a plain read through the signed-in user's own client, so
 * the database decides who is allowed to see it. Migration 0008 grants the
 * operator SELECT across profiles, trades, holdings and watchlist — and only
 * SELECT. There is deliberately no admin write path: no adjusting balances, no
 * deleting trades, no editing prices. An operator who cannot alter the market
 * cannot quietly favour themselves in it, and users are told exactly this in
 * /terms before they sign up.
 *
 * If a non-admin loads these functions, RLS returns their own rows or none at
 * all rather than erroring, so the page falls back to "you are not an
 * operator" instead of leaking the shape of the data.
 */
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { AuditResult } from "@/lib/market/audit";

export interface AdminOverview {
  traders: number;
  tradesTotal: number;
  tradesToday: number;
  cashHeld: number;
  positionsOpen: number;
  watchlistRows: number;
  newestSignup: string | null;
}

export interface AdminTrade {
  id: string;
  username: string;
  playerName: string;
  side: "buy" | "sell";
  shares: number;
  avgPrice: number;
  net: number;
  createdAt: string;
}

/** True when the signed-in user is flagged as the operator. */
export async function isAdmin(): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return false;

    const { data } = await supabase
      .from("profiles")
      .select("is_admin")
      .eq("id", user.id)
      .maybeSingle();
    return data?.is_admin === true;
  } catch {
    return false;
  }
}

export async function getAdminOverview(): Promise<AdminOverview | null> {
  if (!isSupabaseConfigured()) return null;
  try {
    const supabase = await createSupabaseServerClient();
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);

    const [profiles, trades, todays, holdings, watch] = await Promise.all([
      supabase.from("profiles").select("cash_balance, created_at"),
      supabase.from("trades").select("id", { count: "exact", head: true }),
      supabase
        .from("trades")
        .select("id", { count: "exact", head: true })
        .gte("created_at", midnight.toISOString()),
      supabase.from("holdings").select("shares", { count: "exact", head: true }).gt("shares", 0),
      supabase.from("watchlist").select("user_id", { count: "exact", head: true }),
    ]);

    const rows = profiles.data ?? [];
    return {
      traders: rows.length,
      tradesTotal: trades.count ?? 0,
      tradesToday: todays.count ?? 0,
      cashHeld: rows.reduce((a, r) => a + Number(r.cash_balance ?? 0), 0),
      positionsOpen: holdings.count ?? 0,
      watchlistRows: watch.count ?? 0,
      newestSignup: rows
        .map((r) => String(r.created_at))
        .sort()
        .at(-1) ?? null,
    };
  } catch {
    return null;
  }
}

/** The most recent trades across every account. */
export async function getAdminTrades(limit = 50): Promise<AdminTrade[]> {
  if (!isSupabaseConfigured()) return [];
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("trades")
      .select("id, side, shares, avg_price, net, created_at, user_id, players(full_name)")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error || !data) return [];

    // Usernames come from a second query rather than a join, because trades
    // references profiles by id and PostgREST will not embed a table the
    // requesting role reaches only through a policy.
    const ids = [...new Set(data.map((t) => String(t.user_id)))];
    const { data: profiles } = await supabase.from("profiles").select("id, username").in("id", ids);
    const names = new Map((profiles ?? []).map((p) => [String(p.id), String(p.username)]));

    return data.map((t) => {
      const player = t.players as unknown as { full_name?: string } | null;
      return {
        id: String(t.id),
        username: names.get(String(t.user_id)) ?? "unknown",
        playerName: player?.full_name ?? "—",
        side: t.side as "buy" | "sell",
        shares: Number(t.shares),
        avgPrice: Number(t.avg_price),
        net: Number(t.net),
        createdAt: String(t.created_at),
      };
    });
  } catch {
    return [];
  }
}

/**
 * The last recorded audit, for the operator page.
 *
 * Read with the service key rather than the operator's own client, because
 * `market_meta` is revoked from `authenticated` on purpose — it holds the
 * calibration the whole board is priced against, and nothing signed in has any
 * business reading or writing it. This is still a read, and it is still behind
 * the `isAdmin()` gate the rest of this module uses, so the read-only property
 * of the operator page is intact.
 */
export async function getLastAudit(): Promise<AuditResult | null> {
  if (!isSupabaseConfigured()) return null;
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    );
    const { data, error } = await db
      .from("market_meta")
      .select("value")
      .eq("key", "audit_last")
      .maybeSingle();
    if (error || !data?.value) return null;
    return data.value as AuditResult;
  } catch {
    return null;
  }
}
