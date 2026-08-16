import { NextResponse } from "next/server";
import { runIngest } from "@/lib/ingest/run";

/**
 * The scheduled refresh that makes fair value a moving number.
 *
 * Until this existed, performance value was computed once and frozen: a player
 * could score fifty points and their fundamentals would not budge until someone
 * ran the ingest by hand. That made the whole premise — market price drifting
 * away from what production justifies — half-inert, because only one of the two
 * lines could actually move.
 *
 * Vercel invokes this on the schedule in vercel.ts. It also writes a price tick
 * per listing, which is what fills in the 1W/1M/1Y change windows that
 * currently read "—" for want of history.
 */
export const dynamic = "force-dynamic";
/**
 * The Hobby plan's ceiling. A full three-league ingest takes about 140 seconds
 * locally, so this has headroom — but not a lot, and the MLB pool is the part
 * that grows. If a refresh ever times out, the fix is to split the schedule
 * into one cron per league rather than to raise this.
 */
export const maxDuration = 300;

export async function GET(request: Request) {
  // Vercel signs cron invocations with CRON_SECRET. Anything else is a stranger
  // hitting a public URL that rewrites every price on the board, so it is
  // rejected rather than merely rate limited.
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  try {
    const result = await runIngest({ push: true });

    // Record every trader's net worth *after* prices update, so the point on
    // their chart matches the board they would have seen that morning.
    let snapshots = 0;
    try {
      const { createClient } = await import("@supabase/supabase-js");
      const db = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { auth: { persistSession: false } }
      );
      const { data } = await db.rpc("snapshot_portfolios");
      snapshots = Number(data ?? 0);
    } catch {
      // A missed snapshot costs one point on a chart; it must not fail the
      // refresh, which is the part that keeps prices current.
    }

    // Last, and never allowed to fail the refresh: prices being current matters
    // more than a mail going out, and this is the step most likely to break
    // because it depends on a third-party provider.
    let digests = { recipients: 0, sent: 0, skipped: 0, failed: 0, inert: true };
    try {
      const { sendDailyDigests } = await import("@/lib/notify/run");
      const site =
        process.env.NEXT_PUBLIC_SITE_URL ?? "https://athlete-exchange-six.vercel.app";
      digests = await sendDailyDigests(site);
    } catch {
      // No provider configured, or the provider is down. Either way the board
      // is already updated, which is what this route exists to do.
    }

    return NextResponse.json({
      ok: true,
      ...result,
      snapshots,
      digests,
      seconds: Math.round((Date.now() - started) / 1000),
    });
  } catch (err) {
    // Returning 500 makes a failed refresh visible in Vercel's cron log rather
    // than silently leaving yesterday's prices in place.
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        seconds: Math.round((Date.now() - started) / 1000),
      },
      { status: 500 }
    );
  }
}
