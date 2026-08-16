import { NextResponse } from "next/server";
import { runBots } from "@/lib/bots/run";

/**
 * A day of bot trading.
 *
 * Kept as its own route rather than bolted onto the refresh, for two reasons.
 * The refresh already uses about half of its 300-second budget on the ingest,
 * and more importantly the two jobs should be able to fail independently: a
 * problem with the bots must never stop prices being updated, and a feed outage
 * should not stop the market ticking over.
 *
 * It runs after the refresh, so the bots see the day's new fundamentals and
 * trade against them — which is what makes momentum mean anything.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  try {
    const result = await runBots();
    return NextResponse.json({
      ok: true,
      ...result,
      // The log is the only record of why a price moved, so it is returned
      // rather than only written to a console nobody reads.
      log: result.log.slice(0, 60),
      seconds: Math.round((Date.now() - started) / 1000),
    });
  } catch (err) {
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
