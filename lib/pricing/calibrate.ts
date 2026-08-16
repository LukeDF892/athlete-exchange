import {
  DEFAULT_CALIBRATION,
  positionGroup,
  rawProductionScore,
  type Calibration,
  type PositionGroup,
  type Sport,
  type StatLine,
  type StatWindow,
} from "./engine";

export interface CalibrationSubject {
  sport: Sport;
  position: string | null;
  isGoalie: boolean;
  recent: StatLine | null;
  season: StatLine | null;
  career: StatLine | null;
}

/**
 * Where the "elite" anchor sits in each position's distribution.
 *
 * A percentile, not a fixed count. Averaging the top 5 sounds equivalent but
 * silently lets league size set prices: the NHL fields 806 players across three
 * position groups and the NBA 474, so top-5-of-806 is a far harsher bar than
 * top-5-of-474. That pushed the NHL elite anchor up, compressed every NHL price
 * beneath it, and left the best NBA player at $392 against the best NHL player
 * at $237 even though the two leagues' medians matched almost exactly.
 *
 * Top 2.5% means the same thing in a league of 200 as in a league of 800.
 */
const ELITE_PERCENTILE = 0.975;

/** Below this, a line is too small a sample to describe a position. */
const MIN_GAMES: Record<StatWindow, number> = { recent: 3, season: 20, career: 40 };

/**
 * Measure what a typical and an elite season look like at each position, from
 * the league as it actually is, for each stat window independently.
 *
 * Positions are scored on their own raw scales — a defenceman's formula pays
 * for ice time, a forward's does not — so those scales must be tied together
 * before prices are comparable. Rather than hardcoding what "elite" means and
 * watching it drift, this reads the real distribution and anchors two points
 * per window: the median and the elite mark.
 *
 * The result is that a top-five defenceman and a top-five centre land at
 * similar prices, and a replacement-level player at either position does too.
 * You are buying the best available at that job, not betting on which job
 * happens to accumulate more counting stats.
 */
export function calibrateLeague(subjects: CalibrationSubject[]): Calibration {
  const windows: StatWindow[] = ["recent", "season", "career"];
  const out: Calibration = {
    recent: { ...DEFAULT_CALIBRATION.recent },
    season: { ...DEFAULT_CALIBRATION.season },
    career: { ...DEFAULT_CALIBRATION.career },
  };

  for (const window of windows) {
    const byGroup = new Map<PositionGroup, number[]>();

    for (const s of subjects) {
      const line = s[window];
      const group = positionGroup(s.sport, s.position, s.isGoalie);
      const raw = rawProductionScore(group, line);
      // Fringe samples would drag the median down and inflate everyone above.
      if (raw == null || raw <= 0) continue;
      if ((line?.gamesPlayed ?? 0) < MIN_GAMES[window]) continue;

      const list = byGroup.get(group);
      if (list) list.push(raw);
      else byGroup.set(group, [raw]);
    }

    for (const [group, values] of byGroup) {
      // Too few qualifying players to trust a measurement — keep the fallback.
      if (values.length < 12) continue;
      const median = percentile(values, 0.5);
      // Average the top slice rather than taking a single value, so one freak
      // season cannot define what elite means for everyone else.
      const elite = topSliceMean(values, ELITE_PERCENTILE);
      // A degenerate spread would make the mapping meaningless.
      if (elite > median) out[window][group] = { median, elite };
    }
  }

  return out;
}

export function topSliceMean(values: number[], percentile: number): number {
  const sorted = [...values].sort((a, b) => b - a);
  // At least 3 players so the anchor is never one outlier, at most 5% of the
  // group so it stays genuinely elite in a large league.
  const count = Math.max(3, Math.round(sorted.length * (1 - percentile)));
  const take = sorted.slice(0, Math.min(count, sorted.length));
  return take.reduce((a, b) => a + b, 0) / take.length;
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
