"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * The one write path an operator has.
 *
 * Everything else on /admin is a read. Retirement is the exception because it
 * cannot be done any other way — the mechanic was built in migration 0011 and
 * then had no trigger, so the only way to retire an athlete was to open the SQL
 * editor and hand-write a function call against production.
 *
 * Authorisation is not decided here. `announce_retirement` and
 * `settle_retirement` both check `is_admin()` inside the database and raise
 * 42501 otherwise, so these actions cannot grant anything the caller does not
 * already have — even if this file were reachable some other way. That is why
 * they check `auth.uid()` rather than trusting the service role: it means a
 * leaked server key still cannot retire anybody.
 */

export interface AthleteMatch {
  id: string;
  fullName: string;
  sport: string;
  teamAbbrev: string | null;
  status: string;
  marketPrice: number;
  settlesAt: string | null;
}

/** Find listings by name, so the operator picks a real id rather than typing one. */
export async function searchListings(query: string): Promise<AthleteMatch[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("players")
    .select("id, full_name, sport, team_abbrev, status, market_price, settles_at")
    .ilike("full_name", `%${q}%`)
    .eq("kind", "athlete")
    .order("market_price", { ascending: false })
    .limit(10);

  if (error || !data) return [];
  return data.map((r) => ({
    id: String(r.id),
    fullName: String(r.full_name),
    sport: String(r.sport),
    teamAbbrev: r.team_abbrev as string | null,
    status: (r.status as string) ?? "active",
    marketPrice: Number(r.market_price),
    settlesAt: r.settles_at as string | null,
  }));
}

/** Start the countdown. Holders keep trading until it expires. */
export async function announceRetirement(
  playerId: string,
  days: number
): Promise<{ message: string }> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("announce_retirement", {
    p_player_id: playerId,
    p_days: days,
  });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));

  revalidatePath("/admin");
  revalidatePath(`/player/${playerId}`);
  revalidatePath("/");
  return { message: describe(data, "Retirement announced") };
}

/** Buy every holder out at the settlement price and close the listing. */
export async function settleRetirement(playerId: string): Promise<{ message: string }> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("settle_retirement", { p_player_id: playerId });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));

  revalidatePath("/admin");
  revalidatePath(`/player/${playerId}`);
  revalidatePath("/");
  return { message: describe(data, "Settled") };
}

/** The functions return jsonb; surface whatever detail they chose to include. */
function describe(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const o = payload as Record<string, unknown>;
    const parts = Object.entries(o)
      .filter(([, v]) => v != null && typeof v !== "object")
      .map(([k, v]) => `${k.replace(/_/g, " ")}: ${String(v)}`);
    if (parts.length > 0) return `${fallback} — ${parts.join(", ")}`;
  }
  return fallback;
}
