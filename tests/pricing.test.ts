import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fairValue,
  marketPrice,
  productionScore,
  ageMultiplier,
  quoteBuy,
  quoteSell,
  liquidityDepth,
  shrinkToReplacement,
  TRADE_FEE_RATE,
  positionLimit,
  positionValue,
  type StatLine,
} from "../lib/pricing/engine.ts";
import { calibrateLeague } from "../lib/pricing/calibrate.ts";

const mvpNba: StatLine = {
  gamesPlayed: 70,
  points: 2100,
  rebounds: 560,
  assists: 630,
  steals: 90,
  blocks: 60,
  turnovers: 210,
};

const benchNba: StatLine = {
  gamesPlayed: 60,
  points: 240,
  rebounds: 120,
  assists: 60,
  steals: 18,
  blocks: 12,
  turnovers: 55,
};

const eliteNhl: StatLine = {
  gamesPlayed: 78,
  goals: 55,
  hockeyAssists: 90,
  plusMinus: 30,
  shots: 290,
  timeOnIcePerGame: 22 * 78,
};

test("opening price equals fair value before anyone trades", () => {
  const fair = fairValue({ sport: "nba", season: mvpNba, ageYears: 27 });
  assert.equal(marketPrice(fair, 0), fair);
});

test("production score separates stars from bench players", () => {
  const star = productionScore("nba", mvpNba)!;
  const bench = productionScore("nba", benchNba)!;
  assert.ok(star > bench, `expected ${star} > ${bench}`);
  assert.ok(star > 60, `star score ${star} should be high`);
  assert.ok(bench < 35, `bench score ${bench} should be low`);
});

test("production score is null for a player who has not played", () => {
  assert.equal(productionScore("nba", { gamesPlayed: 0 }), null);
  assert.equal(productionScore("nba", null), null);
});

test("elite NHL skater prices well above the floor", () => {
  const fair = fairValue({ sport: "nhl", season: eliteNhl, ageYears: 26 });
  assert.ok(fair > 100, `elite skater should be expensive, got ${fair}`);
});

test("goalies are scored on save percentage, tolerant of both formats", () => {
  const asDecimal = productionScore("nhl", { gamesPlayed: 55, savePct: 0.93, isGoalie: true })!;
  const asPercent = productionScore("nhl", { gamesPlayed: 55, savePct: 93, isGoalie: true })!;
  assert.equal(asDecimal, asPercent);
  const weak = productionScore("nhl", { gamesPlayed: 55, savePct: 0.89, isGoalie: true })!;
  assert.ok(asDecimal > weak);
});

test("younger players carry a growth premium over identical older ones", () => {
  const young = fairValue({ sport: "nba", season: mvpNba, ageYears: 21 });
  const peak = fairValue({ sport: "nba", season: mvpNba, ageYears: 27 });
  const old = fairValue({ sport: "nba", season: mvpNba, ageYears: 36 });
  assert.ok(young > peak, `young ${young} should beat peak ${peak}`);
  assert.ok(peak > old, `peak ${peak} should beat old ${old}`);
});

test("age multiplier stays in sane bounds and handles missing age", () => {
  assert.equal(ageMultiplier("nba", null), 1);
  assert.equal(ageMultiplier("nba", undefined), 1);
  assert.ok(ageMultiplier("nba", 45) >= 0.35);
  assert.ok(ageMultiplier("nba", 18) <= 1.35);
});

/** Season totals from a per-game line, which is how the feeds report. */
function nbaLine(
  gp: number,
  pts: number,
  reb: number,
  ast: number,
  stl: number,
  blk: number,
  tov: number,
  fgPct = 47
): StatLine {
  return {
    gamesPlayed: gp,
    points: pts * gp,
    rebounds: reb * gp,
    assists: ast * gp,
    steals: stl * gp,
    blocks: blk * gp,
    turnovers: tov * gp,
    fieldGoalPct: fgPct,
  };
}

test("one hot game cannot price a call-up like a superstar", () => {
  // Regression: a 1-game NBA debut with a 12-point night once priced a two-way
  // player above Jokic on the live board.
  const debut = nbaLine(1, 12, 4, 2, 1, 1, 1, 60);
  const oneGreatGame = fairValue({
    sport: "nba",
    season: debut,
    career: debut,
    ageYears: 25,
  });
  const provenStar = fairValue({
    sport: "nba",
    season: nbaLine(65, 27.7, 12.9, 10.7, 1.4, 0.8, 3.2, 56.9),
    career: nbaLine(700, 25.0, 11.0, 9.0, 1.3, 0.8, 3.2, 55.0),
    ageYears: 31,
  });
  assert.ok(
    oneGreatGame < provenStar / 3,
    `1-game sample priced at ${oneGreatGame} vs proven star ${provenStar}`
  );
});

test("the same rate over more games is worth more", () => {
  const rate = (gp: number) =>
    fairValue({ sport: "nba", season: nbaLine(gp, 22, 6, 5, 1.2, 0.6, 2.4), ageYears: 27 });
  assert.ok(rate(5) < rate(20));
  assert.ok(rate(20) < rate(60));
  assert.ok(rate(60) < rate(82));
});

test("volume beats efficiency: a star outranks an efficient role player", () => {
  // The bug this guards: when production collapsed to PER, a high-percentage
  // low-usage big (19.5 pts / 2.0 ast on 65% shooting) priced above the
  // league's best guards. Carrying an offence has to be worth more than
  // finishing efficiently inside a narrow one.
  const creator = fairValue({
    sport: "nba",
    season: nbaLine(65, 28.2, 8.2, 7.7, 1.6, 0.5, 3.6, 47.5),
    ageYears: 27.5,
  });
  const efficientBig = fairValue({
    sport: "nba",
    season: nbaLine(70, 19.5, 10.5, 2.0, 0.8, 0.8, 2.0, 65.0),
    ageYears: 22.7,
  });
  assert.ok(
    creator > efficientBig,
    `creator ${creator} should outrank efficient role player ${efficientBig}`
  );
});

test("age tilts the board without deciding it", () => {
  // A still-productive 41-year-old was priced below the 140th-best player in
  // the league purely on age, which is the age curve overriding production.
  const veteranStar = fairValue({
    sport: "nba",
    season: nbaLine(60, 20.9, 6.1, 7.2, 1.2, 0.6, 3.0, 51.5),
    ageYears: 41.6,
  });
  const youngBench = fairValue({
    sport: "nba",
    season: nbaLine(60, 7, 3, 1.5, 0.4, 0.3, 1.0, 44),
    ageYears: 23,
  });
  assert.ok(
    veteranStar > youngBench * 2,
    `41-year-old star ${veteranStar} should still clearly beat a young bench player ${youngBench}`
  );
  assert.ok(ageMultiplier("nba", 41.6) >= 0.55, "age discount must not exceed 45%");
});

test("the two leagues share one price scale", () => {
  // NBA and NHL sit on the same board, so their best players must land in a
  // comparable band or one league's stars look permanently cheap.
  const bestNba = fairValue({
    sport: "nba",
    season: nbaLine(65, 27.7, 12.9, 10.7, 1.4, 0.8, 3.2, 56.9),
    ageYears: 31.5,
  });
  const bestNhl = fairValue({
    sport: "nhl",
    season: {
      gamesPlayed: 82,
      goals: 48,
      hockeyAssists: 90,
      plusMinus: 17,
      shots: 306,
      timeOnIcePerGame: 22.98 * 82,
    },
    ageYears: 29.6,
  });
  const ratio = bestNba / bestNhl;
  assert.ok(
    ratio > 0.6 && ratio < 1.7,
    `league scales diverged: NBA best ${bestNba} vs NHL best ${bestNhl}`
  );
});

test("shrinkage converges to the real score as games accumulate", () => {
  assert.ok(Math.abs(shrinkToReplacement(90, 2000, 20) - 90) < 1);
  // A zero-game sample is pure replacement level.
  assert.equal(shrinkToReplacement(90, 0, 20), 20);
});

test("a player with no stats at all falls back to the price floor", () => {
  const fair = fairValue({ sport: "nba" });
  assert.ok(fair > 0 && fair < 10, `expected floor-ish price, got ${fair}`);
});

test("buying pushes the price up, selling pushes it down", () => {
  const fair = 100;
  const buy = quoteBuy(fair, 0, 500);
  assert.ok(buy.priceAfter > buy.priceBefore);

  const sell = quoteSell(fair, 500, 500);
  assert.ok(sell.priceAfter < sell.priceBefore);
});

test("slippage is real: average fill is worse than the pre-trade spot price", () => {
  const fair = 100;
  const buy = quoteBuy(fair, 0, 1000);
  assert.ok(
    buy.avgPrice > buy.priceBefore,
    `avg fill ${buy.avgPrice} should exceed spot ${buy.priceBefore}`
  );
  assert.ok(buy.avgPrice < buy.priceAfter);
});

test("an instant round trip never profits — no free money", () => {
  // The property that matters is that you cannot come out *ahead*, which the
  // curve guarantees on its own: buying n shares costs the area from S to S+n
  // and selling them back returns the same integral. With a fee it is a small
  // loss; without one it is exactly break-even. It is never a gain, at any size.
  const fair = 100;
  for (const shares of [1, 50, 800, 5000]) {
    const buy = quoteBuy(fair, 0, shares);
    const sell = quoteSell(fair, buy.sharesAfter, shares);
    assert.ok(
      sell.net <= buy.net + 0.01,
      `round trip profited at ${shares} shares: paid ${buy.net}, received ${sell.net}`
    );
  }
});

test("the curve conserves value; only the fee leaks", () => {
  const fair = 100;
  const shares = 800;
  const buy = quoteBuy(fair, 0, shares);
  const sell = quoteSell(fair, buy.sharesAfter, shares);
  // Gross out equals gross back — this is what makes the market arbitrage-free,
  // not the fee. Removing the fee does not open a hole.
  assert.ok(Math.abs(buy.gross - sell.gross) < 0.01);
  const expectedLoss = buy.gross * TRADE_FEE_RATE * 2;
  assert.ok(Math.abs(buy.net - sell.net - expectedLoss) < 0.02);
});

test("selling back to zero returns the market to its opening price", () => {
  const fair = 100;
  const buy = quoteBuy(fair, 0, 1200);
  const sell = quoteSell(fair, buy.sharesAfter, 1200);
  assert.equal(sell.sharesAfter, 0);
  assert.ok(Math.abs(sell.priceAfter - fair) < 0.01);
});

test("deeper markets move less for the same order size", () => {
  const fair = 100;
  const shallow = quoteBuy(fair, 0, 500, 1000);
  const deep = quoteBuy(fair, 0, 500, 50000);
  const shallowMove = shallow.priceAfter / shallow.priceBefore;
  const deepMove = deep.priceAfter / deep.priceBefore;
  assert.ok(shallowMove > deepMove);
});

test("liquidity depth scales with fair value but never collapses", () => {
  assert.ok(liquidityDepth(300) > liquidityDepth(20));
  assert.ok(liquidityDepth(0.5) >= 600);
});

test("fair value changes flow straight through to market price", () => {
  // A player gets hot: fair value rises. Holders should gain even with no trading.
  // Depth is fixed at listing, so the premium is a clean multiplier.
  const depth = liquidityDepth(100);
  const before = marketPrice(100, 500, depth);
  const after = marketPrice(130, 500, depth);
  assert.ok(after > before);
  // Within a cent of an exact 1.3x — the only error is penny rounding.
  assert.ok(
    Math.abs(after - before * 1.3) < 0.01,
    `expected ${before * 1.3}, got ${after}`
  );
});

test("a hot streak does not reshape the curve under existing holders", () => {
  // Regression: depth must come from the stored opening value, not live fair
  // value. Otherwise the buyer's premium silently changes with no trades.
  const depth = liquidityDepth(100); // fixed at listing
  const premiumBefore = marketPrice(100, 900, depth) / 100;
  const premiumAfter = marketPrice(160, 900, depth) / 160;
  // Identical premium multiplier; only sub-cent rounding may differ.
  assert.ok(
    Math.abs(premiumBefore - premiumAfter) < 1e-3,
    `premium drifted: ${premiumBefore} vs ${premiumAfter}`
  );

  // And the failure mode this guards against, stated directly: if depth were
  // recomputed from live fair value the premium would visibly shrink.
  const recomputed = marketPrice(160, 900, liquidityDepth(160)) / 160;
  assert.ok(
    Math.abs(recomputed - premiumBefore) > 1e-3,
    "test is not exercising the bug it claims to guard"
  );
});

test("non-positive trade sizes are rejected", () => {
  assert.throws(() => quoteBuy(100, 0, 0));
  assert.throws(() => quoteSell(100, 100, -5));
});

// ---------------------------------------------------------------------------
// Rounding contract
//
// These lock the exact rounding composition that execute_trade() uses in SQL.
// The browser quotes from TypeScript and the database pays from SQL, so any
// divergence means the order ticket promises a number the trade will not
// honour. A live round trip disagreed by one cent on sells before this was
// pinned down, and no unit test noticed because the round-trip assertion used a
// two-cent tolerance.
//
// The rule, in both languages: gross and fee are each rounded to the cent from
// the *exact* curve area; net is their exact sum or difference.
// ---------------------------------------------------------------------------

/** Recomputes the rule independently rather than calling the code under test. */
function expectedParts(fair: number, from: number, to: number, L: number) {
  const exact = fair * L * (Math.exp(to / L) - Math.exp(from / L));
  const gross = Math.round((exact + Number.EPSILON) * 100) / 100;
  const fee = Math.round((exact * TRADE_FEE_RATE + Number.EPSILON) * 100) / 100;
  return { gross, fee };
}

test("buy rounds gross and fee independently, then sums exactly", () => {
  const fair = 126.61;
  const L = liquidityDepth(fair);
  for (const shares of [1, 3, 7, 10, 33, 100, 250]) {
    const q = quoteBuy(fair, 0, shares, L);
    const { gross, fee } = expectedParts(fair, 0, shares, L);

    assert.equal(q.gross, gross, `gross for ${shares} shares`);
    assert.equal(q.fee, fee, `fee for ${shares} shares`);
    assert.equal(q.net, Math.round((gross + fee + Number.EPSILON) * 100) / 100);
  }
});

test("sell rounds identically to buy — fee off the exact area, not rounded gross", () => {
  const fair = 126.61;
  const L = liquidityDepth(fair);
  for (const shares of [1, 3, 7, 10, 33, 100, 250]) {
    const held = 400;
    const q = quoteSell(fair, held, shares, L);
    const { gross, fee } = expectedParts(fair, held - shares, held, L);

    assert.equal(q.gross, gross, `gross for ${shares} shares`);
    assert.equal(q.fee, fee, `fee for ${shares} shares`);
    assert.equal(q.net, Math.round((gross - fee + Number.EPSILON) * 100) / 100);

    // The specific mistake that shipped: taking the fee off already-rounded
    // gross. Assert we are NOT doing that whenever the two actually differ.
    const feeFromRounded = Math.round((gross * TRADE_FEE_RATE + Number.EPSILON) * 100) / 100;
    if (feeFromRounded !== fee) {
      assert.notEqual(q.fee, feeFromRounded, "fee must come off the exact curve area");
    }
  }
});

test("money is always whole cents and average fill is 4dp", () => {
  const fair = 88.37;
  const L = liquidityDepth(fair);
  for (const shares of [1, 9, 41, 137]) {
    for (const q of [quoteBuy(fair, 120, shares, L), quoteSell(fair, 500, shares, L)]) {
      for (const [label, v] of [
        ["gross", q.gross],
        ["fee", q.fee],
        ["net", q.net],
      ] as const) {
        // Compare with a tolerance: v*100 carries float representation error
        // (1273.55 * 100 === 127354.99999999999), so exact equality would fail
        // on values that are perfectly good cents.
        assert.ok(
          Math.abs(Math.round(v * 100) - v * 100) < 1e-6,
          `${label} ${v} is not whole cents`
        );
      }
      assert.ok(
        Math.abs(Math.round(q.avgPrice * 10000) - q.avgPrice * 10000) < 1e-6,
        `avgPrice ${q.avgPrice} should be 4dp to match holdings.avg_cost numeric(12,4)`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Cross-position parity
//
// A sport is not one job. These guard the property that took three attempts to
// get right: a typical player and an elite player must score the same at any
// position, whatever shape that position's raw formula has.
// ---------------------------------------------------------------------------

test("calibration equalizes median and elite across positions", () => {
  // Two positions with deliberately different raw scales and spreads.
  const forwards = Array.from({ length: 40 }, (_, i) => 10 + i * 2); // 10..88
  const defence = Array.from({ length: 40 }, (_, i) => 5 + i); // 5..44

  const cal = calibrateLeague([
    ...forwards.map((v) => fakeSubject("nhl-forward", v)),
    ...defence.map((v) => fakeSubject("nhl-defense", v)),
  ]);

  const fMed = cal.season["nhl-forward"].median;
  const dMed = cal.season["nhl-defense"].median;
  const fElite = cal.season["nhl-forward"].elite;
  const dElite = cal.season["nhl-defense"].elite;

  // Raw scales genuinely differ...
  assert.ok(fMed > dMed, "test setup should give the two groups different scales");
  // ...but both map to the same place on the shared scale.
  assert.ok(Math.abs(scoreFor(fMed, cal.season["nhl-forward"]) - 30) < 0.001);
  assert.ok(Math.abs(scoreFor(dMed, cal.season["nhl-defense"]) - 30) < 0.001);
  assert.ok(Math.abs(scoreFor(fElite, cal.season["nhl-forward"]) - 88) < 0.001);
  assert.ok(Math.abs(scoreFor(dElite, cal.season["nhl-defense"]) - 88) < 0.001);
});

/** Mirrors the affine map inside productionScore. */
function scoreFor(raw: number, cal: { median: number; elite: number }): number {
  return 30 + ((raw - cal.median) * (88 - 30)) / (cal.elite - cal.median);
}

/** A subject whose raw score for its group comes out to `target`. */
function fakeSubject(group: "nhl-forward" | "nhl-defense", target: number) {
  // Both NHL skater formulas are linear in points-per-game, so solving for
  // assists alone gives an exact raw score without touching the other terms.
  const gp = 82;
  const weight = group === "nhl-defense" ? 62 : 48;
  const assists = (target / weight) * gp / 0.85;
  return {
    sport: "nhl" as const,
    position: group === "nhl-defense" ? "D" : "C",
    isGoalie: false,
    recent: null,
    season: {
      gamesPlayed: gp,
      goals: 0,
      hockeyAssists: assists,
      plusMinus: 0,
      shots: 0,
      timeOnIcePerGame: 0,
    },
    career: null,
  };
}

test("each stat window is calibrated against its own distribution", () => {
  // Season and career lines have different distributions. Calibrating on one
  // and applying to the other put the median defenceman's career score at 62
  // against a forward's 34, which filled the top of the board with blue-liners
  // even after the season window itself was correctly equalized.
  const subjects = Array.from({ length: 30 }, (_, i) => {
    const s = fakeSubject("nhl-forward", 10 + i * 2);
    return { ...s, career: { ...s.season!, gamesPlayed: 500, hockeyAssists: s.season!.hockeyAssists! * 6 } };
  });
  const cal = calibrateLeague(subjects);
  assert.notEqual(
    cal.season["nhl-forward"].median,
    cal.career["nhl-forward"].median,
    "season and career must not share one calibration"
  );
});

test("position limits bound how far one trader can move a price", () => {
  // The exploit this closes: a cheap listing has shallow depth, so a full
  // $100,000 bankroll re-prices it many times over. A $5 athlete with 600 depth
  // absorbed that as 2,122 shares and went to $171 — one account, 34x.
  const fair = 5;
  const depth = 600;
  const cap = positionLimit(depth);

  assert.equal(cap, 120, "cap should be 20% of depth");

  // At the cap, price impact stays modest whatever the athlete costs.
  const atCap = quoteBuy(fair, 0, cap, depth);
  const impact = (atCap.priceAfter - fair) / fair;
  assert.ok(impact < 0.25, `one holder moved the price ${(impact * 100).toFixed(0)}%`);

  // The same proportional cap on an expensive, deep listing behaves the same,
  // which is the point of scaling by depth rather than by shares or dollars.
  const deep = quoteBuy(400, 0, positionLimit(17_658), 17_658);
  const deepImpact = (deep.priceAfter - 400) / 400;
  assert.ok(Math.abs(deepImpact - impact) < 0.01, "impact should not depend on price");
});

/**
 * A position is worth what closing it pays, not shares x spot.
 *
 * The spot mark counted your own price impact as profit: buy 120 shares and the
 * panel showed a gain before anything had happened, on a round trip that
 * returns exactly what it cost. These pin the invariant CLAUDE.md has always
 * claimed — an instant round trip is break-even — to the number the UI shows.
 */
test("a fresh position is worth what it cost, not more", () => {
  const fair = 205.24;
  const depth = 7133;
  for (const shares of [10, 50, 120, 500]) {
    const buy = quoteBuy(fair, 0, shares, depth);
    const marked = positionValue(fair, shares, shares, depth);
    const atSpot = shares * marketPrice(fair, shares, depth);

    assert.ok(
      Math.abs(marked - buy.net) <= 0.02,
      `${shares} shares: marked ${marked} should equal the ${buy.net} paid`
    );
    // And the old mark really was higher, which is the bug this replaces.
    assert.ok(atSpot > marked, `${shares} shares: spot mark ${atSpot} should exceed ${marked}`);
  }
});

test("a short is marked at what covering costs, carried negative", () => {
  const fair = 100;
  const depth = 4500;
  const open = quoteSell(fair, 0, 60, depth);
  const marked = positionValue(fair, -60, -60, depth);
  assert.ok(marked < 0, "a short position is a liability");
  assert.ok(
    Math.abs(Math.abs(marked) - open.net) <= 0.02,
    `covering should cost the ${open.net} received, got ${Math.abs(marked)}`
  );
});
