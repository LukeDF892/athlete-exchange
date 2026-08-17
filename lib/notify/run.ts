/**
 * Send everyone who asked for it their daily digest.
 *
 * Runs from the scheduled refresh, after prices have been rewritten, so the
 * numbers in the email match the board someone sees when they follow the link.
 *
 * Reads holdings and watchlists with the service role because there is no user
 * session in a cron — which is exactly why this file is small and does one
 * thing. The service key bypasses row-level security, so every query here is
 * explicitly scoped by `user_id` rather than relying on a policy to scope it.
 */
import { createClient } from "@supabase/supabase-js";
import { getPlayers } from "@/lib/market/source";
import { getDigest, buildPersonalDigest } from "@/lib/market/digest";
import { digestRecipients, renderDigest, sendEmail } from "./email";

export interface DigestRun {
  recipients: number;
  sent: number;
  skipped: number;
  failed: number;
  /** True when no provider is configured, so nothing could have been sent. */
  inert: boolean;
}

export async function sendDailyDigests(siteUrl: string): Promise<DigestRun> {
  const inert = !process.env.RESEND_API_KEY || !process.env.DIGEST_FROM;
  const recipients = await digestRecipients();
  const result: DigestRun = { recipients: recipients.length, sent: 0, skipped: 0, failed: 0, inert };
  if (recipients.length === 0) return result;

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  // Fetched once and shared: the market-wide comparison is identical for
  // everybody, and only the filtering differs per person.
  const players = await getPlayers();
  const market = await getDigest(players, 5000);
  if (!market.hasHistory) return result;

  for (const r of recipients) {
    try {
      const [{ data: holdingRows }, { data: watchRows }] = await Promise.all([
        db.from("holdings").select("player_id, shares").eq("user_id", r.userId).neq("shares", 0),
        db.from("watchlist").select("player_id").eq("user_id", r.userId),
      ]);

      const held = new Map((holdingRows ?? []).map((h) => [String(h.player_id), Number(h.shares)]));
      const watched = new Set((watchRows ?? []).map((w) => String(w.player_id)));
      if (held.size === 0 && watched.size === 0) {
        result.skipped++;
        continue;
      }

      const personal = buildPersonalDigest(players, market, held, watched);
      const message = renderDigest(r, personal, siteUrl);
      // renderDigest returns null on a quiet day rather than mailing "nothing
      // happened", which is the fastest way to teach someone to ignore you.
      if (!message) {
        result.skipped++;
        continue;
      }

      const outcome = await sendEmail(r.email, message.subject, message.text);
      if (outcome === "sent") result.sent++;
      else if (outcome === "skipped") result.skipped++;
      else result.failed++;
    } catch {
      result.failed++;
    }
  }

  return result;
}
