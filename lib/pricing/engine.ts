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

export type Sport = "nba" | "nhl" | "mlb" | "nfl";

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
  // Football. Kept as season totals like everything else, so `per()` works.
  passingYards?: number;
  passingTouchdowns?: number;
  passingInterceptions?: number;
  completionPct?: number;
  rushingYards?: number;
  rushingTouchdowns?: number;
  receptions?: number;
  receivingYards?: number;
  receivingTouchdowns?: number;
  tackles?: number;
  sacks?: number;
  defensiveInterceptions?: number;
  forcedFumbles?: number;
  passesDefended?: number;
  fieldGoalsMade?: number;
  fieldGoalPctKicking?: number;
  kickingPoints?: number;
  puntAverage?: number;
  puntsInside20?: number;
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
  | "mlb-pitcher"
  | "nfl-qb"
  | "nfl-rb"
  | "nfl-receiver"
  | "nfl-front7"
  | "nfl-secondary"
  | "nfl-kicker"
  | "nfl-punter";

export function positionGroup(
  sport: Sport,
  position: string | null | undefined,
  isGoalie = false
): PositionGroup {
  const p = (position ?? "").toUpperCase();
  if (sport === "nfl") return nflGroup(p);
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
/**
 * Football positions, from the roster's own abbreviation.
 *
 * The roster endpoint is the source of truth here, unlike baseball where the
 * stat block had to settle it. That matters because ESPN's stat categories are
 * actively misleading for linemen: a Pro Bowl centre comes back with a
 * `passing` category first and zeroes in it, so trusting category order would
 * price him as a quarterback who never throws.
 *
 * Offensive linemen and long snappers are not grouped here at all — see
 * `isUnpriceablePosition`.
 */
function nflGroup(p: string): PositionGroup {
  if (p === "QB") return "nfl-qb";
  if (p === "RB" || p === "FB" || p === "HB") return "nfl-rb";
  if (p === "WR" || p === "TE") return "nfl-receiver";
  if (p === "PK" || p === "K") return "nfl-kicker";
  if (p === "P") return "nfl-punter";
  if (p === "CB" || p === "S" || p === "SAF" || p === "FS" || p === "SS" || p === "DB") {
    return "nfl-secondary";
  }
  // DE, DT, NT, LB, EDGE, MLB, OLB and anything else defensive.
  return "nfl-front7";
}

/**
 * Positions this market cannot honestly price.
 *
 * Offensive linemen have no public box-score production — no yards, no
 * tackles, nothing an open feed records. Scoring them on the categories ESPN
 * returns would give every one of them zero and park roughly five hundred
 * players on the $4 floor: not a valuation, just noise that makes the board
 * worse. Long snappers are the same story.
 *
 * So they are not listed. It is the same rule already applied to a player with
 * no completed season — if there is no production to price, there is no
 * listing. Fantasy football draws the line in exactly the same place, so it
 * should not surprise anyone who follows the sport.
 */
export function isUnpriceablePosition(sport: Sport, position: string | null | undefined): boolean {
  if (sport !== "nfl") return false;
  const p = (position ?? "").toUpperCase();
  return ["OT", "OG", "G", "C", "OL", "T", "LS"].includes(p);
}

export function rawProductionScore(
  group: PositionGroup,
  line: StatLine | null | undefined
): number | null {
  if (!line || !line.gamesPlayed || line.gamesPlayed <= 0) return null;
  const per = (v: number | undefined) => (v ?? 0) / line.gamesPlayed;

  // ---------------------------------------------------------------------
  // Football
  //
  // Scored per game, like every other sport here, but football's seventeen-game
  // season makes each game a far larger share of the evidence than a game of
  // baseball or basketball — which is why the NFL gets its own shrinkage
  // constants further down rather than sharing the others'.
  // ---------------------------------------------------------------------
  if (group === "nfl-qb") {
    // Volume first, efficiency as a modifier — the same lesson the NBA scoring
    // learned. A game manager on a run-heavy team should not outrank a
    // quarterback carrying an offence just because he avoids mistakes.
    const ypg = per(line.passingYards);
    const yardScore = clamp(ypg / 300, 0, 1.15) * 34;
    const tdScore = clamp(per(line.passingTouchdowns) / 2.2, 0, 1.2) * 24;
    // Interceptions are the one genuinely negative event at the position.
    const intPenalty = clamp(per(line.passingInterceptions) / 1.2, 0, 1.5) * 12;
    const acc = line.completionPct ?? 0;
    const accScore = clamp((acc - 55) / 15, 0, 1) * 14;
    // Mobile quarterbacks are worth real points; this is what separates the
    // modern position from the pocket version of it.
    const rushScore =
      clamp(per(line.rushingYards) / 45, 0, 1) * 10 +
      clamp(per(line.rushingTouchdowns) / 0.5, 0, 1) * 6;
    return Math.max(0, yardScore + tdScore + accScore + rushScore - intPenalty);
  }

  if (group === "nfl-rb") {
    const rushYards = clamp(per(line.rushingYards) / 100, 0, 1.2) * 32;
    const rushTd = clamp(per(line.rushingTouchdowns) / 0.8, 0, 1.2) * 20;
    // Receiving backs are systematically undervalued by rushing yards alone,
    // and in the current game they are often the more valuable player.
    const recv =
      clamp(per(line.receptions) / 4, 0, 1) * 12 +
      clamp(per(line.receivingYards) / 35, 0, 1) * 10 +
      clamp(per(line.receivingTouchdowns) / 0.4, 0, 1) * 6;
    const workload = clamp(line.gamesPlayed / 15, 0, 1) * 8;
    return Math.max(0, rushYards + rushTd + recv + workload);
  }

  if (group === "nfl-receiver") {
    const yards = clamp(per(line.receivingYards) / 90, 0, 1.2) * 34;
    const catches = clamp(per(line.receptions) / 6, 0, 1.1) * 20;
    const tds = clamp(per(line.receivingTouchdowns) / 0.7, 0, 1.2) * 22;
    // Tight ends and slot receivers accumulate differently from outside
    // receivers, but they share a group because their box score is the same
    // shape; calibration against their own group settles the rest.
    const workload = clamp(line.gamesPlayed / 15, 0, 1) * 8;
    return Math.max(0, yards + catches + tds + workload);
  }

  if (group === "nfl-front7") {
    // Sacks are the rare defensive event that is both individual and
    // game-changing, so they carry the most weight per unit.
    const sackScore = clamp(per(line.sacks) / 0.7, 0, 1.25) * 34;
    const tackleScore = clamp(per(line.tackles) / 6, 0, 1.1) * 24;
    const turnovers =
      clamp(per(line.forcedFumbles) / 0.15, 0, 1) * 12 +
      clamp(per(line.defensiveInterceptions) / 0.15, 0, 1) * 8;
    const workload = clamp(line.gamesPlayed / 15, 0, 1) * 8;
    return Math.max(0, sackScore + tackleScore + turnovers + workload);
  }

  if (group === "nfl-secondary") {
    // Defensive backs are measured on takeaways rather than sacks. Tackles
    // matter less here than in the front seven — a cornerback making many
    // tackles is often a cornerback being thrown at.
    const intScore = clamp(per(line.defensiveInterceptions) / 0.25, 0, 1.2) * 30;
    const pdScore = clamp(per(line.passesDefended) / 1.1, 0, 1.15) * 22;
    const tackleScore = clamp(per(line.tackles) / 5.5, 0, 1) * 18;
    const extras =
      clamp(per(line.forcedFumbles) / 0.12, 0, 1) * 8 + clamp(per(line.sacks) / 0.3, 0, 1) * 6;
    const workload = clamp(line.gamesPlayed / 15, 0, 1) * 8;
    return Math.max(0, intScore + pdScore + tackleScore + extras + workload);
  }

  if (group === "nfl-kicker") {
    const kickPoints = clamp(per(line.kickingPoints) / 8, 0, 1.15) * 40;
    const fgAccuracy = clamp(((line.fieldGoalPctKicking ?? 0) - 70) / 25, 0, 1) * 30;
    const fgVolume = clamp(per(line.fieldGoalsMade) / 1.8, 0, 1) * 18;
    const workload = clamp(line.gamesPlayed / 15, 0, 1) * 6;
    return Math.max(0, kickPoints + fgAccuracy + fgVolume + workload);
  }

  if (group === "nfl-punter") {
    // Net average and pinning the opponent deep are the whole job.
    const avg = clamp(((line.puntAverage ?? 0) - 38) / 12, 0, 1) * 48;
    const inside20 = clamp(per(line.puntsInside20) / 2, 0, 1) * 34;
    const workload = clamp(line.gamesPlayed / 15, 0, 1) * 8;
    return Math.max(0, avg + inside20 + workload);
  }

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
  "nfl-qb": { median: 30, elite: 85 },
  "nfl-rb": { median: 22, elite: 70 },
  "nfl-receiver": { median: 20, elite: 72 },
  "nfl-front7": { median: 20, elite: 68 },
  "nfl-secondary": { median: 22, elite: 66 },
  // Kickers and punters were one group to begin with, and it repeated the
  // defenceman mistake exactly: two unrelated jobs sharing one median, which
  // sat between them and left every kicker above it. The median kicker came out
  // at $115 — more than triple the median receiver.
  "nfl-kicker": { median: 45, elite: 80 },
  "nfl-punter": { median: 35, elite: 70 },
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

/**
 * Football needs its own constants, because a season is seventeen games.
 *
 * The values above are tuned for sports that play 82 or 162 times. Applying
 * them to the NFL would regress a *complete, healthy season* — every game a
 * player was available for — as though it were a third of the evidence it is:
 * at k=10, seventeen games is trusted 63%, so the best season a footballer can
 * physically produce would be permanently discounted toward replacement level.
 *
 * These are scaled to the same reliability the other sports get from a full
 * season: seventeen games at k=4 is 81%, which is about what 70 NBA games at
 * k=10 comes to.
 */
const NFL_RELIABILITY_K = { recent: 2, season: 4, career: 8 } as const;

interface ReliabilityK {
  recent: number;
  season: number;
  career: number;
}

function reliabilityK(sport: Sport): ReliabilityK {
  return sport === "nfl" ? NFL_RELIABILITY_K : RELIABILITY_K;
}

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
  const k = reliabilityK(input.sport);
  push(input.recent, WINDOW_WEIGHTS.recent, k.recent, "recent");
  push(input.season, WINDOW_WEIGHTS.season, k.season, "season");
  push(input.career, WINDOW_WEIGHTS.career, k.career, "career");

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

/**
 * What a position is actually worth: the cash you would have if you closed it.
 *
 * Not `shares x marketPrice`. On a bonding curve the spot price is the price of
 * the *next* share, not of the ones you hold — selling walks back down the
 * curve, so a position is worth the area under it, which is always less than
 * the spot mark. Marking at spot therefore books your own price impact as
 * profit the instant you buy: 120 shares of a $9,236-depth listing showed
 * +0.84% before anything at all had happened, and larger positions showed +10%
 * on a round trip that returns exactly what it cost. Worse, it could show a
 * gain on a position that would realise a loss.
 *
 * A short is the mirror: its value is what covering would cost, carried
 * negative so net worth stays cash plus the sum of positions.
 *
 * Falls back to the spot mark if the curve cannot answer — one holder can be
 * long more than the market's net outstanding when someone else is short, and
 * an unanswerable quote must not take a portfolio page down with it.
 */
export function positionValue(
  fair: number,
  sharesOutstanding: number,
  shares: number,
  depth?: number
): number {
  if (shares === 0) return 0;
  const L = depth ?? liquidityDepth(fair);
  try {
    return shares > 0
      ? quoteSell(fair, sharesOutstanding, shares, L).net
      : -quoteBuy(fair, sharesOutstanding, -shares, L).net;
  } catch {
    return round2(shares * marketPrice(fair, sharesOutstanding, L));
  }
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
