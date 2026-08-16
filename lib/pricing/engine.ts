/**
 * The pricing engine.
 *
 * Two numbers drive every athlete on the exchange:
 *
 *   1. FAIR VALUE  — derived purely from on-ice/on-court production. This is the
 *      "fundamentals" line. It moves when a player plays, not when anyone trades.
 *
 *   2. MARKET PRICE — what people are actually paying. It rides a bonding curve
 *      anchored to fair value, so net buying pushes it to a premium and net
 *      selling to a discount.
 *
 * price(S) = V * exp(S / L)
 *
 *   V = fair value ($), S = net shares outstanding, L = liquidity depth (shares).
 *
 * At launch S = 0, so market price === fair value. That is the answer to the
 * "where does the starting price come from?" problem: performance sets the
 * opening bell, the crowd takes it from there.
 *
 * Because the curve is integrable in closed form, buying n shares costs exactly
 * the area under it, which means there is always a counterparty and no user can
 * round-trip a trade for free profit.
 */

export type Sport = "nba" | "nhl" | "mlb";

/** Normalized production line for one player over some window of games. */
export interface StatLine {
  gamesPlayed: number;
  // Basketball
  points?: number;
  rebounds?: number;
  assists?: number;
  steals?: number;
  blocks?: number;
  turnovers?: number;
  minutes?: number;
  fieldGoalPct?: number;
  // Hockey (skaters)
  goals?: number;
  hockeyAssists?: number;
  plusMinus?: number;
  timeOnIcePerGame?: number;
  shots?: number;
  // Hockey (goalies)
  savePct?: number;
  goalsAgainstAverage?: number;
  wins?: number;
  isGoalie?: boolean;
  // Baseball (batters)
  onBasePlusSlugging?: number;
  homeRuns?: number;
  runsBattedIn?: number;
  stolenBases?: number;
  plateAppearances?: number;
  // Baseball (pitchers)
  earnedRunAverage?: number;
  whip?: number;
  inningsPitched?: number;
  pitcherStrikeouts?: number;
  saves?: number;
  isPitcher?: boolean;
}

export interface FairValueInput {
  sport: Sport;
  /** Most recent 5-10 games. Drives short-term swings. */
  recent?: StatLine | null;
  /** Current season to date. */
  season?: StatLine | null;
  /** Career totals, averaged per game. */
  career?: StatLine | null;
  ageYears?: number | null;
  /** Raw position string from the feed ("D", "G", "C", "PG"…). */
  position?: string | null;
  /** League-measured elite scores per position; defaults are a fallback. */
  calibration?: Calibration;
}

/** How much each window counts toward fair value. Recent form matters, but
 *  career body-of-work stops one cold night from tanking a franchise player. */
const WINDOW_WEIGHTS = { recent: 0.3, season: 0.45, career: 0.25 } as const;

/** Dollar scale: a replacement-level regular sits near the floor, a generational
 *  season approaches the ceiling. Deliberately wide so the board has texture. */
const PRICE_FLOOR = 4;
const PRICE_CEILING = 480;

/**
 * Positions that are scored against their own peers rather than each other.
 *
 * A sport is not one job. A defenceman with 50 points is elite; a first-line
 * centre with 50 is disappointing. Scoring them on one scale — which an earlier
 * version did — permanently underprices every defenceman in the league and
 * makes half the board unbuyable. NBA positions differ less, since everyone
 * scores, but a centre's production is still shaped differently from a guard's.
 */
export type PositionGroup =
  | "nba-guard"
  | "nba-forward"
  | "nba-center"
  | "nhl-forward"
  | "nhl-defense"
  | "nhl-goalie"
  | "mlb-batter"
  | "mlb-pitcher";

export function positionGroup(
  sport: Sport,
  position: string | null | undefined,
  isGoalie = false
): PositionGroup {
  const p = (position ?? "").toUpperCase();
  if (sport === "nba") {
    if (p.includes("C")) return "nba-center";
    if (p.includes("G")) return "nba-guard";
    return "nba-forward";
  }
  if (sport === "mlb") {
    // A pitcher and a batter share a sport and almost no statistics, the same
    // way a goalie and a skater do. The feed tells us which by returning a
    // pitching stat block instead of a batting one.
    return isGoalie || p.startsWith("P") || p === "SP" || p === "RP"
      ? "mlb-pitcher"
      : "mlb-batter";
  }
  if (isGoalie || p === "G") return "nhl-goalie";
  if (p.startsWith("D")) return "nhl-defense";
  return "nhl-forward";
}

/**
 * Raw, unbounded production for a position. Comparable *within* a group only —
 * `productionScore` turns it into a cross-position number using league
 * calibration, because the raw scales legitimately differ between jobs.
 */
export function rawProductionScore(
  group: PositionGroup,
  line: StatLine | null | undefined
): number | null {
  if (!line || !line.gamesPlayed || line.gamesPlayed <= 0) return null;
  const per = (v: number | undefined) => (v ?? 0) / line.gamesPlayed;

  if (group === "mlb-pitcher") {
    // Pitchers are scored on run prevention, and the two headline numbers run
    // *backwards* — a lower ERA and WHIP are better — so both are inverted
    // before they contribute. League average sits near a 4.00 ERA and a 1.30
    // WHIP; elite is nearer 2.50 and 1.00.
    const era = line.earnedRunAverage;
    const whip = line.whip;
    const innings = line.inningsPitched ?? 0;

    const eraScore = era == null || era <= 0 ? 0 : clamp((5.5 - era) / 3.0, 0, 1) * 42;
    const whipScore = whip == null || whip <= 0 ? 0 : clamp((1.6 - whip) / 0.6, 0, 1) * 26;
    // Strikeouts per nine, the rate that survives a bad defence behind you.
    const k9 = innings > 0 ? ((line.pitcherStrikeouts ?? 0) / innings) * 9 : 0;
    const kScore = clamp(k9 / 12, 0, 1.15) * 18;
    // Volume matters: a brilliant 30 innings is worth less than a brilliant 200.
    // Relievers are capped lower by design, with saves crediting the role.
    const workload = clamp(innings / 180, 0, 1) * 14 + clamp((line.saves ?? 0) / 35, 0, 1) * 8;

    return Math.max(0, eraScore + whipScore + kScore + workload);
  }

  if (group === "mlb-batter") {
    // OPS is the single best rate stat the free feed gives us: .700 is roughly
    // average, .900 is an All-Star, 1.000+ is an MVP season. Power and running
    // add on top, and playing time keeps a hot 20-game stretch from outranking
    // a full season.
    const ops = line.onBasePlusSlugging ?? 0;
    const opsScore = clamp((ops - 0.55) / 0.45, 0, 1.15) * 52;

    const hrRate = per(line.homeRuns) * 162;
    const hrScore = clamp(hrRate / 45, 0, 1.2) * 20;
    const rbiScore = clamp((per(line.runsBattedIn) * 162) / 110, 0, 1.1) * 12;
    const sbScore = clamp((per(line.stolenBases) * 162) / 35, 0, 1) * 6;
    const workload = clamp(line.gamesPlayed / 150, 0, 1) * 14;

    return Math.max(0, opsScore + hrScore + rbiScore + sbScore + workload);
  }

  if (group === "nhl-goalie") {
    // Goalies live and die by save percentage. .900 is replacement, .930 elite.
    const svp = line.savePct ?? 0;
    const normalized = svp > 1 ? svp / 100 : svp;
    const base = ((normalized - 0.88) / 0.06) * 80;
    const workload = Math.min(line.gamesPlayed / 55, 1) * 20;
    return clamp(base + workload, 0, 200);
  }

  if (group === "nhl-defense") {
    // Defencemen are paid in minutes and on-ice results, not just points.
    // Scoring still counts, weighted up because blue-line point totals run
    // roughly half a forward's, and ice time is the clearest signal of how
    // much a coach trusts them.
    const pointsPerGame = per(line.goals) * 1.0 + per(line.hockeyAssists) * 0.85;
    return Math.max(
      0,
      pointsPerGame * 62 +
        (line.plusMinus ?? 0) / Math.max(line.gamesPlayed, 1) * 14 +
        Math.min(per(line.timeOnIcePerGame) / 24, 1.25) * 22 +
        per(line.shots) * 1.2
    );
  }

  if (group === "nhl-forward") {
    const pointsPerGame = per(line.goals) * 1.0 + per(line.hockeyAssists) * 0.85;
    return Math.max(
      0,
      pointsPerGame * 48 +
        per(line.shots) * 1.5 +
        (line.plusMinus ?? 0) / Math.max(line.gamesPlayed, 1) * 8 +
        Math.min(per(line.timeOnIcePerGame) / 20, 1.2) * 8
    );
  }

  // NBA — box-score contribution per game, in the Hollinger "game score" family
  // but using only fields the free feeds reliably supply. Deliberately a volume
  // measure: a star who carries an offence outranks a role player who is merely
  // efficient inside a narrow one.
  const boxScore =
    per(line.points) * 1.0 +
    per(line.rebounds) * 0.7 +
    per(line.assists) * 1.0 +
    per(line.steals) * 1.4 +
    per(line.blocks) * 1.4 -
    per(line.turnovers) * 1.0;

  // Efficiency is a modest adjustment on top of volume, never a substitute.
  const fg = line.fieldGoalPct;
  const efficiency =
    fg == null || !Number.isFinite(fg) ? 1 : clamp(1 + (fg - 46) / 200, 0.92, 1.12);

  return Math.max(0, boxScore * efficiency);
}

/**
 * Raw score that represents an elite season for each position, used to put
 * every group on one 0-100 scale.
 *
 * These are fallbacks. The ingest measures the real distribution across the
 * whole league and overrides them, so the board self-calibrates as production
 * changes year to year rather than drifting against hardcoded guesses.
 */
export interface GroupCalibration {
  /** Raw score of a typical qualifying player at this position. */
  median: number;
  /** Raw score of an elite player at this position. */
  elite: number;
}

export type StatWindow = "recent" | "season" | "career";

const FALLBACK_GROUPS: Record<PositionGroup, GroupCalibration> = {
  "nba-guard": { median: 14, elite: 45 },
  "nba-forward": { median: 14, elite: 43 },
  "nba-center": { median: 14, elite: 40 },
  "nhl-forward": { median: 22, elite: 77 },
  "nhl-defense": { median: 17, elite: 65 },
  "nhl-goalie": { median: 30, elite: 64 },
  "mlb-batter": { median: 45, elite: 88 },
  "mlb-pitcher": { median: 40, elite: 85 },
};

/**
 * Calibration is per window as well as per position.
 *
 * A career line and a single-season line are different distributions — a
 * career accumulates games at a player's prime rate, and the position formulas
 * weight cumulative terms differently across the two. Measuring on season lines
 * and applying to career lines put the median defenceman's career score at
 * 62 against a forward's 34, which flowed straight through to price and filled
 * the top of the board with blue-liners even after the season window itself
 * was correctly equalized.
 */
export type Calibration = Record<StatWindow, Record<PositionGroup, GroupCalibration>>;

export const DEFAULT_CALIBRATION: Calibration = {
  recent: { ...FALLBACK_GROUPS },
  season: { ...FALLBACK_GROUPS },
  career: { ...FALLBACK_GROUPS },
};

/** An elite season scores this; the scale keeps headroom above it. */
const ELITE_SCORE = 88;
/** A typical qualifying player scores this. */
const MEDIAN_SCORE = 30;

/**
 * Map a position's raw score onto the shared 0-100 scale.
 *
 * Two anchors, not one. Scaling by a single elite mark assumes every position's
 * raw scores are spread the same way, and they are not: the defenceman formula
 * pays for ice time, which every defenceman gets, so that distribution sits
 * higher in the middle than the forward one. Calibrating only the top therefore
 * left the median defenceman priced above the median forward and filled the top
 * of the board with blue-liners.
 *
 * Anchoring the median *and* the elite mark makes a typical player at any
 * position score the same, and an elite player at any position score the same,
 * whatever shape the underlying formula has. That leaves the formulas
 * responsible only for ranking within a position, which is what they are
 * actually good at.
 */
export function productionScore(
  sport: Sport,
  line: StatLine | null | undefined,
  position?: string | null,
  calibration: Calibration = DEFAULT_CALIBRATION,
  window: StatWindow = "season"
): number | null {
  const group = positionGroup(sport, position, line?.isGoalie);
  const raw = rawProductionScore(group, line);
  if (raw == null) return null;

  const cal =
    calibration[window]?.[group] ?? DEFAULT_CALIBRATION[window][group] ?? FALLBACK_GROUPS[group];
  const spread = cal.elite - cal.median;
  if (!(spread > 0)) return clamp((raw / (cal.elite || 1)) * ELITE_SCORE, 0, 100);

  const scaled = MEDIAN_SCORE + ((raw - cal.median) * (ELITE_SCORE - MEDIAN_SCORE)) / spread;
  return clamp(scaled, 0, 100);
}

/**
 * Age curve. Young producers carry a growth premium (you are buying the
 * career ahead of them); veterans past peak get discounted. This is what makes
 * a 21-year-old and a 34-year-old with identical stat lines price differently.
 */
export function ageMultiplier(sport: Sport, age: number | null | undefined): number {
  if (age == null || !Number.isFinite(age)) return 1;
  const peak = sport === "nba" ? 27 : 26;
  if (age <= peak) {
    // Up to +22% for a teenager already producing.
    const yearsOfRunway = Math.min(peak - age, 9);
    return 1 + yearsOfRunway * 0.025;
  }
  // Decline is gentler at first, then steepens past ~33.
  //
  // The floor is 0.55, not 0.35. A 0.35 floor discounted a still-productive
  // 41-year-old by 65% — enough that LeBron priced below the 140th-best player
  // in the league on age alone. Age should tilt the board, not decide it;
  // production now carries the ranking.
  const yearsPast = age - peak;
  const decay = yearsPast <= 6 ? yearsPast * 0.03 : 0.18 + (yearsPast - 6) * 0.045;
  return clamp(1 - decay, 0.55, 1);
}

/**
 * Score of a replacement-level player — roughly a fringe roster spot.
 * Small samples are pulled toward this, not toward zero, because a player who
 * has appeared once is far more likely to be ordinary than to be either an MVP
 * or worthless.
 */
const REPLACEMENT_SCORE = 20;

/**
 * Sample-size constants (in games). A window is worth
 *   gp / (gp + k)
 * of its face value, with the remainder taken from replacement level.
 *
 * Without this, one great night prices a call-up above Jokic: a 1-game, 12-point
 * NBA debut produces a monster per-game line over a sample far too small to
 * mean anything. At k=10 a single game is trusted 9%, while a completed 70-game
 * season is trusted 88% — the guard still fires on tiny samples without taxing
 * a full season's work, which an earlier k=20 discounted by a fifth even when
 * the player had played every night. The recent window is short by construction
 * and already carries the smallest weight, so it regresses hardest.
 */
const RELIABILITY_K = { recent: 4, season: 10, career: 15 } as const;

/** Empirical-Bayes shrinkage of a raw score toward replacement level. */
export function shrinkToReplacement(score: number, gamesPlayed: number, k: number): number {
  const gp = Math.max(gamesPlayed, 0);
  const reliability = gp / (gp + k);
  return reliability * score + (1 - reliability) * REPLACEMENT_SCORE;
}

/** Blend the three stat windows into a single fair-value dollar figure. */
export function fairValue(input: FairValueInput): number {
  const scores: Array<{ score: number; weight: number }> = [];
  const push = (
    line: StatLine | null | undefined,
    weight: number,
    k: number,
    window: StatWindow
  ) => {
    const s = productionScore(input.sport, line, input.position, input.calibration, window);
    if (s != null && line) {
      scores.push({ score: shrinkToReplacement(s, line.gamesPlayed, k), weight });
    }
  };
  push(input.recent, WINDOW_WEIGHTS.recent, RELIABILITY_K.recent, "recent");
  push(input.season, WINDOW_WEIGHTS.season, RELIABILITY_K.season, "season");
  push(input.career, WINDOW_WEIGHTS.career, RELIABILITY_K.career, "career");

  if (scores.length === 0) return PRICE_FLOOR;

  const totalWeight = scores.reduce((a, b) => a + b.weight, 0);
  const blended = scores.reduce((a, b) => a + b.score * b.weight, 0) / totalWeight;

  // Convex mapping: the gap between good and great is worth more than the gap
  // between bad and mediocre, which is how real markets price scarcity.
  const normalized = clamp(blended, 0, 100) / 100;
  const curved = Math.pow(normalized, 2.1);
  const base = PRICE_FLOOR + curved * (PRICE_CEILING - PRICE_FLOOR);

  const value = base * ageMultiplier(input.sport, input.ageYears);
  return round2(clamp(value, PRICE_FLOOR, PRICE_CEILING * 1.15));
}

// ---------------------------------------------------------------------------
// The market: bonding curve
// ---------------------------------------------------------------------------

/**
 * Liquidity depth in shares. Bigger = harder to move the price.
 * Scaled off fair value so a $300 superstar is not trivially cornered by one
 * user with a big balance, while a $8 rookie can still move on real interest.
 *
 * IMPORTANT: this is computed ONCE, from the player's opening fair value, and
 * then stored on the player row. It must not be recomputed as fair value drifts.
 * If depth moved with fair value, a hot streak would reshape the bonding curve
 * underneath existing holders and silently revalue the premium they paid for —
 * a price change caused by nobody trading. Fixing depth at listing keeps the
 * market premium a clean multiplier on fundamentals.
 */
export function liquidityDepth(openingFairValue: number): number {
  return Math.max(600, Math.round(openingFairValue * 45));
}

/** Spot market price given fair value and net shares outstanding. */
export function marketPrice(fair: number, sharesOutstanding: number, depth?: number): number {
  const L = depth ?? liquidityDepth(fair);
  return round2(fair * Math.exp(sharesOutstanding / L));
}

export interface QuoteResult {
  /** Total cash moved, before fees. Positive for buys, positive proceeds for sells. */
  gross: number;
  fee: number;
  /** What the user actually pays (buy) or receives (sell). */
  net: number;
  /** Effective per-share price including slippage. */
  avgPrice: number;
  priceBefore: number;
  priceAfter: number;
  sharesAfter: number;
}

/**
 * Most of one athlete a single account may hold, as a share of liquidity depth.
 *
 * Must match v_max_share in execute_trade(). A share of depth rather than a
 * share count or a dollar amount, because depth is what determines price
 * impact: at 20% one holder can move a price by at most about 22%, whatever
 * the athlete costs. Without it, $100,000 turns a $5 listing into a $171 one.
 */
export const MAX_POSITION_SHARE = 0.2;

/** Largest position one account may hold in a given listing. */
export function positionLimit(liquidityDepth: number): number {
  return Math.floor(liquidityDepth * MAX_POSITION_SHARE);
}

/**
 * Trading fee, as a fraction of the gross trade value. Currently zero.
 *
 * A fee is NOT what keeps the curve honest — that is a common assumption and it
 * is wrong here. Buying n shares costs the area under the curve from S to S+n,
 * and selling them back returns the area from S to S+n: the same integral, so
 * an instant round trip is exactly break-even at any size with no fee at all.
 * The fee was only friction, discouraging churn and giving volume a cost.
 *
 * Keeping the constant (and the fee columns in the database) means switching it
 * back on later is a one-line change in two places — here, and v_fee_rate in
 * execute_trade(). The two must always match, or the browser quotes a number
 * the database will not honour.
 */
export const TRADE_FEE_RATE = 0;

/**
 * Exact area under the bonding curve from S to S+n.
 *   ∫ V·e^(s/L) ds = V·L·(e^((S+n)/L) − e^(S/L))
 */
function curveArea(fair: number, from: number, to: number, L: number): number {
  return fair * L * (Math.exp(to / L) - Math.exp(from / L));
}

export function quoteBuy(
  fair: number,
  sharesOutstanding: number,
  shares: number,
  depth?: number
): QuoteResult {
  if (shares <= 0) throw new Error("Buy quantity must be positive");
  const L = depth ?? liquidityDepth(fair);
  const after = sharesOutstanding + shares;
  const gross = curveArea(fair, sharesOutstanding, after, L);
  // Rounding rule — must match execute_trade() in SQL exactly, or the browser
  // quotes a number the database will not honour. Gross and fee are each
  // rounded to the cent from the exact curve area; net is their exact sum.
  const grossR = round2(gross);
  const feeR = round2(gross * TRADE_FEE_RATE);
  return {
    gross: grossR,
    fee: feeR,
    net: round2(grossR + feeR),
    avgPrice: round4(grossR / shares),
    priceBefore: marketPrice(fair, sharesOutstanding, L),
    priceAfter: marketPrice(fair, after, L),
    sharesAfter: after,
  };
}

export function quoteSell(
  fair: number,
  sharesOutstanding: number,
  shares: number,
  depth?: number
): QuoteResult {
  if (shares <= 0) throw new Error("Sell quantity must be positive");
  const L = depth ?? liquidityDepth(fair);
  const after = sharesOutstanding - shares;
  // Area under the curve on the way back down.
  const gross = curveArea(fair, after, sharesOutstanding, L);
  // Same rounding rule as quoteBuy — see the note there.
  const grossR = round2(gross);
  const feeR = round2(gross * TRADE_FEE_RATE);
  return {
    gross: grossR,
    fee: feeR,
    net: round2(grossR - feeR),
    avgPrice: round4(grossR / shares),
    priceBefore: marketPrice(fair, sharesOutstanding, L),
    priceAfter: marketPrice(fair, after, L),
    sharesAfter: after,
  };
}

// ---------------------------------------------------------------------------

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** Share prices carry 4dp so they match holdings.avg_cost numeric(12,4) in SQL. */
export function round4(v: number): number {
  return Math.round((v + Number.EPSILON) * 10000) / 10000;
}

export function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}
