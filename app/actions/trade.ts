"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";

export interface TradeResult {
  ok: true;
  side: "buy" | "sell";
  shares: number;
  avgPrice: number;
  net: number;
  priceAfter: number;
}

/**
 * Executes a trade.
 *
 * Deliberately thin: this passes the player, side and quantity to the database
 * and nothing else. It does NOT send a price. `execute_trade()` recomputes the
 * bonding-curve cost from server-held state inside one transaction, so the
 * quote the browser displayed is never trusted — a tampered client can only
 * mislead itself.
 */
export async function executeTrade(
  playerId: string,
  side: "buy" | "sell",
  shares: number
): Promise<TradeResult> {
  if (!isSupabaseConfigured()) {
    throw new Error("Trading requires a Supabase project. See the README.");
  }
  if (!Number.isInteger(shares) || shares <= 0) {
    throw new Error("Enter a whole number of shares.");
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Sign in to trade.");

  const { data, error } = await supabase.rpc("execute_trade", {
    p_player_id: playerId,
    p_side: side,
    p_shares: shares,
  });

  if (error) {
    // Postgres raises these with a readable message ("insufficient funds: need
    // 1200, have 800"), which is exactly what the trader should see.
    throw new Error(error.message);
  }

  const result = data as {
    side: "buy" | "sell";
    shares: number;
    avgPrice: number;
    net: number;
    priceAfter: number;
  };

  revalidatePath(`/player/${playerId}`);
  revalidatePath("/portfolio");
  revalidatePath("/");

  return {
    ok: true,
    side: result.side,
    shares: Number(result.shares),
    avgPrice: Number(result.avgPrice),
    net: Number(result.net),
    priceAfter: Number(result.priceAfter),
  };
}

/**
 * Rename yourself.
 *
 * The name travels to a public leaderboard, so the rules live in the database
 * (set_username) rather than here — a check that only exists in a form is a
 * check anyone can skip by calling the API directly.
 */
export async function changeUsername(username: string): Promise<{ username: string }> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_username", { p_username: username });

  if (error) {
    // Postgres prefixes raised exceptions; the message itself is already
    // written for a person to read.
    throw new Error(error.message.replace(/^.*?:\s*/, ""));
  }

  revalidatePath("/portfolio");
  revalidatePath("/leaderboard");
  return { username: String(data) };
}

/**
 * Turn the daily email on or off.
 *
 * Stored on the user's own auth metadata, so the preference belongs to them
 * rather than to a table the operator maintains — and absent means no, which is
 * why nobody who has never touched this receives anything.
 */
export async function setEmailDigest(enabled: boolean): Promise<{ enabled: boolean }> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.updateUser({ data: { email_digest: enabled } });
  if (error) throw new Error(error.message);

  revalidatePath("/portfolio");
  return { enabled };
}

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  revalidatePath("/");
}
