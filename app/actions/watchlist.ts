"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";

/**
 * Follow or unfollow an athlete.
 *
 * Separate from holdings on purpose: the athletes you want to read about are
 * not the same set as the ones you own. Following is how you track someone you
 * are thinking about buying, and it drives the news filter as well as the
 * watchlist itself.
 */
export async function toggleWatch(playerId: string): Promise<{ watching: boolean }> {
  if (!isSupabaseConfigured()) throw new Error("Following requires a Supabase project.");

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Sign in to follow athletes.");

  const { data: existing } = await supabase
    .from("watchlist")
    .select("player_id")
    .eq("user_id", user.id)
    .eq("player_id", playerId)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from("watchlist")
      .delete()
      .eq("user_id", user.id)
      .eq("player_id", playerId);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase
      .from("watchlist")
      .insert({ user_id: user.id, player_id: playerId });
    if (error) throw new Error(error.message);
  }

  revalidatePath(`/player/${playerId}`);
  revalidatePath("/portfolio");
  revalidatePath("/news");

  return { watching: !existing };
}
