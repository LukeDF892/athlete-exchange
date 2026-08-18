/**
 * The league yardstick, kept where both pricing paths can reach it.
 *
 * `fairValue()` scores an athlete against the median and elite production of
 * their own position group, and those marks are measured across every player
 * fetched during a full ingest. That was fine while pricing only ever happened
 * inside an ingest. A live refresh cannot re-measure five thousand players to
 * reprice the forty who are playing tonight, so the marks are stored at ingest
 * and read back here.
 *
 * Both paths pricing against the same yardstick is the whole point. Two
 * calibrations would make one player worth two different amounts depending on
 * which job touched them last, and the price would oscillate between them every
 * ten minutes with no trade behind it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_CALIBRATION, type Calibration, type Sport } from "@/lib/pricing/engine";

const KEY = "calibration";
const SPORTS_KEY = "calibration_sports";

/**
 * Merge a run's calibration into what is stored, one sport at a time.
 *
 * A scheduled refresh runs a single league, so its `calibrateLeague()` result
 * only measured that league — every other position group in it is the built-in
 * fallback rather than a measurement. Writing it whole would quietly reset the
 * other three leagues to defaults and reprice the entire board against a
 * yardstick nobody measured. Position groups are sport-prefixed
 * ("nhl-forward", "mlb-pitcher"), so the merge is exact.
 */
export function mergeCalibration(
  stored: Calibration | null,
  fresh: Calibration,
  sports: Sport[]
): Calibration {
  const base: Calibration = stored ?? DEFAULT_CALIBRATION;
  const out = {
    recent: { ...base.recent },
    season: { ...base.season },
    career: { ...base.career },
  } as Calibration;

  for (const window of ["recent", "season", "career"] as const) {
    for (const group of Object.keys(fresh[window]) as Array<keyof Calibration["recent"]>) {
      const sport = String(group).split("-")[0] as Sport;
      if (sports.includes(sport)) out[window][group] = fresh[window][group];
    }
  }
  return out;
}

export async function saveCalibration(
  db: SupabaseClient,
  fresh: Calibration,
  sports: Sport[]
): Promise<void> {
  const stored = await loadCalibration(db);
  const merged = mergeCalibration(stored, fresh, sports);
  const { error } = await db
    .from("market_meta")
    .upsert({ key: KEY, value: merged, updated_at: new Date().toISOString() });
  if (error) throw error;

  // Which leagues have actually been measured, as opposed to sitting at the
  // built-in fallback. Without this the stored calibration is indistinguishable
  // from a measured one for a league no ingest has ever run — and the live
  // refresh would reprice, say, an NFL preseason roster against marks nobody
  // took, moving real prices for no reason at all.
  const measured = new Set([...(await loadCalibratedSports(db)), ...sports]);
  const { error: sportsErr } = await db.from("market_meta").upsert({
    key: SPORTS_KEY,
    value: [...measured],
    updated_at: new Date().toISOString(),
  });
  if (sportsErr) throw sportsErr;
}

/** Leagues whose median and elite marks come from a real measurement. */
export async function loadCalibratedSports(db: SupabaseClient): Promise<Sport[]> {
  const { data, error } = await db
    .from("market_meta")
    .select("value")
    .eq("key", SPORTS_KEY)
    .maybeSingle();
  if (error || !Array.isArray(data?.value)) return [];
  return data.value as Sport[];
}

/**
 * Returns null rather than the default when nothing is stored.
 *
 * The caller needs to tell "no calibration yet" from "calibrated, and these are
 * the numbers" — pricing a live game against fallback marks would move every
 * price on the board for a reason that has nothing to do with the game.
 */
export async function loadCalibration(db: SupabaseClient): Promise<Calibration | null> {
  const { data, error } = await db.from("market_meta").select("value").eq("key", KEY).maybeSingle();
  if (error || !data?.value) return null;
  return data.value as Calibration;
}
