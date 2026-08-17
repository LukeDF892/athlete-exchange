import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { draftPickValue } from "../lib/providers/draft.ts";
import { InjuryIndex } from "../lib/providers/injuries.ts";
import { recentFormFromDoc } from "../lib/providers/gamelog.ts";
import { buildTeams } from "../lib/market/teams.ts";
import { decide, makeRng, sharesForBudget } from "../lib/bots/strategies.ts";
import { botRoster, botsForSlot, currentSlot, SLOT_HOURS } from "../lib/bots/identity.ts";
import { positionLimit, quoteBuy } from "../lib/pricing/engine.ts";
import type { Player } from "../lib/market/types.ts";

/**
 * Regression tests over the ingest output.
 *
 * Every one of these exists because a real bug shipped past the type checker
 * and the pricing tests, and was found by a human looking at the site. The
 * pattern was always the same: a data source silently returned less than
 * expected, nothing threw, and the board was quietly wrong.
 *
 *   * The MLB roster fetch took the first 60 of ~250 per club in arbitrary
 *     order, so Ohtani, Judge and Soto were absent for days.
 *   * PostgREST caps responses at 1,000 rows without saying so, truncating the
 *     board to its most expensive listings.
 *   * A per-league id cap silently cut the league to its first six teams.
 *
 * None of these could fail loudly. Asserting that specific famous athletes are
 * present is unglamorous, but it is the check that would have caught all three
 * in seconds rather than a full ingest cycle each.
 */

const SNAPSHOT = path.join(process.cwd(), "data", "snapshot.json");
const hasSnapshot = existsSync(SNAPSHOT);

interface Snapshot {
  generatedAt: string;
  players: Player[];
  news: Array<{ id: string; playerIds: string[] }>;
}

function load(): Snapshot {
  return JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snapshot;
}

/** Skipped rather than failed when nobody has run an ingest yet. */
const withSnapshot = { skip: hasSnapshot ? false : "run `npm run ingest` first" };

test("every league is represented", withSnapshot, () => {
  const { players } = load();
  for (const sport of ["nba", "nhl", "mlb"] as const) {
    const count = players.filter((p) => p.sport === sport && p.kind === "athlete").length;
    assert.ok(count > 300, `${sport} has only ${count} athletes — a feed likely truncated`);
  }
});

test("famous athletes are listed", withSnapshot, () => {
  const { players } = load();
  const names = players.map((p) => p.fullName.toLowerCase());
  const present = (needle: string) => names.some((n) => n.includes(needle.toLowerCase()));

  // One per league, chosen because each was missing at some point for a
  // different reason. Losing any of them means a source silently changed.
  const required = [
    "lebron james",
    "nikola jokic",
    "connor mcdavid",
    "cale makar",
    "shohei ohtani",
    "aaron judge",
  ];

  const missing = required.filter((n) => !present(n));
  assert.deepEqual(missing, [], `missing from the board: ${missing.join(", ")}`);
});

test("injured stars are discounted, not delisted", withSnapshot, () => {
  const { players } = load();
  const injured = players.filter((p) => p.injury != null);
  assert.ok(injured.length > 0, "no injuries priced in — the injury feed may have moved");

  for (const p of injured.slice(0, 50)) {
    // An injury marks the price down from the healthy value, never up.
    assert.ok(
      p.fairValue <= p.healthyFairValue + 0.01,
      `${p.fullName} priced above healthy value while injured`
    );
    assert.ok(p.injury!.multiplier > 0 && p.injury!.multiplier <= 1);
  }
});

test("listing ids are unique", withSnapshot, () => {
  const { players } = load();
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const p of players) {
    if (seen.has(p.id)) dupes.push(p.id);
    seen.add(p.id);
  }
  assert.deepEqual(dupes, [], `duplicate listing ids: ${dupes.slice(0, 5).join(", ")}`);
});

test("every listing is priced and tradeable", withSnapshot, () => {
  const { players } = load();
  for (const p of players) {
    assert.ok(p.fairValue > 0, `${p.fullName} has no fair value`);
    assert.ok(p.marketPrice > 0, `${p.fullName} has no market price`);
    assert.ok(p.liquidityDepth > 0, `${p.fullName} has no liquidity depth`);
    // Nothing has traded at ingest, so the market must open at fair value.
    if (p.sharesOutstanding === 0) {
      assert.ok(
        Math.abs(p.marketPrice - p.fairValue) < 0.02,
        `${p.fullName} opens at ${p.marketPrice} but is worth ${p.fairValue}`
      );
    }
  }
});

test("teams and prospects are present and well formed", withSnapshot, () => {
  const { players } = load();

  const teams = players.filter((p) => p.kind === "team");
  assert.ok(teams.length > 50, `only ${teams.length} team indexes — expected one per club`);
  for (const t of teams.slice(0, 10)) {
    assert.ok((t.components?.length ?? 0) > 0, `${t.fullName} tracks no athletes`);
    // A team is an index, so it should be harder to move than a single player.
    assert.ok(t.liquidityDepth > 1000);
  }

  const prospects = players.filter((p) => p.kind === "prospect");
  if (prospects.length > 0) {
    for (const p of prospects.slice(0, 10)) {
      assert.ok(p.draft != null, `${p.fullName} is a prospect with no draft record`);
      assert.equal(p.careerValue.length, 0, "a prospect has no professional seasons");
    }
  }
});

test("news links point at listings that exist", withSnapshot, () => {
  const { players, news } = load();
  const ids = new Set(players.map((p) => p.id));
  for (const n of news) {
    for (const pid of n.playerIds) {
      assert.ok(ids.has(pid), `story ${n.id} links to unknown listing ${pid}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Pure units that need no ingest
// ---------------------------------------------------------------------------

test("draft value decays with pick number and never inverts", () => {
  let previous = Infinity;
  for (const pick of [1, 2, 5, 10, 32, 64, 128, 224]) {
    const value = draftPickValue(pick);
    assert.ok(value < previous, `pick ${pick} is worth more than an earlier pick`);
    assert.ok(value > 0);
    previous = value;
  }
  // A first overall pick is promising, not proven — it must not outprice a star.
  assert.ok(draftPickValue(1) < 200);
});

test("a team index is weighted toward its best players", () => {
  const base = (id: string, fairValue: number): Player => ({
    id,
    externalId: id,
    kind: "athlete",
    sport: "nba",
    fullName: id,
    firstName: id,
    lastName: "",
    position: "G",
    jersey: null,
    teamAbbrev: "AAA",
    teamName: "Test Team",
    headshotUrl: null,
    ageYears: 25,
    isGoalie: false,
    fairValue,
    openingFairValue: fairValue,
    liquidityDepth: 1000,
    sharesOutstanding: 0,
    marketPrice: fairValue,
    prevClose: null,
    statTables: [],
    gameLog: [],
    careerValue: [],
    injury: null,
    healthyFairValue: fairValue,
  });

  // One star, five replacements.
  const roster = [base("star", 400), ...[1, 2, 3, 4, 5].map((i) => base(`sub${i}`, 20))];
  const [team] = buildTeams(roster);

  const plainMean = roster.reduce((a, p) => a + p.fairValue, 0) / roster.length;
  assert.ok(
    team.fairValue > plainMean,
    `value-weighted index ${team.fairValue} should exceed the plain mean ${plainMean}`
  );
  // ...but a basket is still not worth more than its single best asset.
  assert.ok(team.fairValue < 400);
});

test("an undebuted prospect loses value the longer they go without playing", () => {
  const fresh = draftPickValue(1, 0);
  const oneYear = draftPickValue(1, 1);
  const fiveYears = draftPickValue(1, 5);

  assert.ok(oneYear < fresh, "a year without debuting should cost something");
  assert.ok(fiveYears < oneYear, "and more years should cost more");
  // Floored, because plenty of good players take three years to arrive.
  assert.ok(fiveYears > fresh * 0.35, "decay must not approach zero");
  // Order by draft slot survives decay — a stale first overall is still worth
  // more than a fresh fortieth pick.
  assert.ok(draftPickValue(1, 3) > draftPickValue(40, 0));
});

test("an injury on a shared name is dropped rather than applied to the wrong athlete", () => {
  const index = new InjuryIndex();
  const injury = {
    status: "Out",
    type: "Knee",
    detail: null,
    returnDate: null,
    daysOut: 90,
    multiplier: 0.75,
    summary: "Out · Knee",
  };
  index.add({ injury, teamAbbrev: "BOS" }, "Chris Johnson");
  index.add({ injury: { ...injury, status: "Day-To-Day" }, teamAbbrev: "LAL" }, "Chris Johnson");

  // Two athletes normalise to the same name, so the name alone proves nothing.
  assert.equal(index.lookup("Chris Johnson"), undefined);
  // The team settles it.
  assert.equal(index.lookup("Chris Johnson", "BOS")?.status, "Out");
  assert.equal(index.lookup("Chris Johnson", "LAL")?.status, "Day-To-Day");
  assert.deepEqual(index.ambiguous(), ["chris johnson"]);
});

test("injury matching survives a first-name spelling difference", () => {
  const index = new InjuryIndex();
  index.add(
    {
      teamAbbrev: "SEA",
      injury: {
        status: "Out",
        type: "Ankle",
        detail: null,
        returnDate: null,
        daysOut: 20,
        multiplier: 0.85,
        summary: "Out · Ankle",
      },
    },
    "Alexander Wennberg"
  );

  // Feeds disagree about given names; the surname and initial do not.
  assert.equal(index.lookup("Alex Wennberg", "SEA")?.status, "Out");
  assert.equal(index.lookup("Alex Wennberg")?.status, "Out");
  // A different person entirely still misses.
  assert.equal(index.lookup("Alex Ovechkin"), undefined);
});

/**
 * A gamelog doc in ESPN's shape. Two games, newest first, so the fixture also
 * pins the ordering assumption the recent window depends on.
 */
const NBA_LOG = {
  names: [
    "minutes",
    "fieldGoalsMade-fieldGoalsAttempted",
    "fieldGoalPct",
    "totalRebounds",
    "assists",
    "blocks",
    "steals",
    "turnovers",
    "points",
  ],
  seasonTypes: [
    {
      categories: [
        {
          events: [
            { eventId: "2", stats: ["30", "1-1", "100.0", "5", "5", "0", "1", "2", "3"] },
            { eventId: "1", stats: ["40", "8-19", "42.1", "10", "8", "1", "2", "3", "20"] },
          ],
        },
      ],
    },
  ],
  events: {
    "1": { gameDate: "2026-01-01T00:00:00.000+00:00", atVs: "vs", opponent: { abbreviation: "BOS" } },
    "2": { gameDate: "2026-01-03T00:00:00.000+00:00", atVs: "@", opponent: { abbreviation: "NYK" } },
  },
};

test("NBA recent form sums counting stats and recomputes shooting", () => {
  const { recent, games } = recentFormFromDoc("nba", NBA_LOG);
  assert.ok(recent);
  assert.equal(recent.gamesPlayed, 2);
  assert.equal(recent.points, 23);
  assert.equal(recent.rebounds, 15);
  assert.equal(recent.assists, 13);

  // 9 of 20, not the average of 100% and 42.1% — a 1-for-1 night must not
  // count as much as a 8-for-19 one.
  assert.ok(Math.abs(recent.fieldGoalPct! - 45) < 0.001, `got ${recent.fieldGoalPct}`);

  // Newest first, and home/away decoded from "vs"/"@".
  assert.equal(games[0].opponent, "NYK");
  assert.equal(games[0].homeAway, "away");
  assert.equal(games[1].homeAway, "home");
  assert.equal(games[1].summary, "20 pts · 10 reb · 8 ast");
});

test("MLB recent OPS is rebuilt from the window, not read off the season line", () => {
  const doc = {
    names: [
      "atBats",
      "runs",
      "hits",
      "doubles",
      "triples",
      "homeRuns",
      "RBIs",
      "walks",
      "hitByPitch",
      "strikeouts",
      "stolenBases",
      "caughtStealing",
      "avg",
      "onBasePct",
      "slugAvg",
      "OPS",
    ],
    seasonTypes: [
      {
        categories: [
          {
            events: [
              // 1-for-4 with a home run, plus a walk.
              {
                eventId: "1",
                stats: [
                  "4", "1", "1", "0", "0", "1", "2", "1", "0", "1", "0", "0",
                  // Season-to-date columns — deliberately absurd, so reading
                  // them instead of recomputing would be obvious.
                  ".999", ".999", ".999", "1.998",
                ],
              },
            ],
          },
        ],
      },
    ],
    events: { "1": { gameDate: "2026-05-01T00:00:00.000+00:00" } },
  };

  const { recent } = recentFormFromDoc("mlb", doc);
  assert.ok(recent);
  // OBP = (1 hit + 1 walk) / 5 PA = .400; SLG = 4 bases / 4 AB = 1.000.
  assert.ok(Math.abs(recent.onBasePlusSlugging! - 1.4) < 1e-9, `got ${recent.onBasePlusSlugging}`);
  assert.equal(recent.homeRuns, 1);
  assert.equal(recent.runsBattedIn, 2);
});

test("MLB pitcher innings read as thirds, not decimals", () => {
  const doc = {
    names: [
      "innings", "hits", "runs", "earnedRuns", "homeRuns", "walks", "strikeouts",
      "groundBalls", "flyBalls", "pitches", "battersFaced", "avgGameScore",
      "wins-losses", "saves-blownSaves-holds", "ERA",
    ],
    seasonTypes: [
      {
        categories: [
          {
            events: [
              // 6.2 innings is six and two thirds, so two of these is 13.1 IP.
              { eventId: "1", stats: ["6.2", "4", "2", "2", "0", "1", "8", "0", "0", "95", "25", "60", "1-0", "0-0-0", "2.70"] },
              { eventId: "2", stats: ["6.2", "5", "3", "3", "1", "2", "6", "0", "0", "98", "27", "55", "0-1", "0-0-0", "4.05"] },
            ],
          },
        ],
      },
    ],
    events: {
      "1": { gameDate: "2026-05-01T00:00:00.000+00:00" },
      "2": { gameDate: "2026-04-25T00:00:00.000+00:00" },
    },
  };

  const { recent } = recentFormFromDoc("mlb", doc, { isPitcher: true });
  assert.ok(recent);
  // 20 outs + 20 outs = 40 outs = 13⅓ innings. Naive decimal maths gives 13.4.
  assert.ok(Math.abs(recent.inningsPitched! - 40 / 3) < 1e-9, `got ${recent.inningsPitched}`);
  // 5 earned runs over 13⅓ innings.
  assert.ok(Math.abs(recent.earnedRunAverage! - (5 * 9) / (40 / 3)) < 1e-9);
  assert.equal(recent.pitcherStrikeouts, 14);
});

// ---------------------------------------------------------------------------
// Bot strategies
// ---------------------------------------------------------------------------

/** A listing shaped enough for a trading decision. */
function listing(over: Partial<Player> & { id: string; fairValue: number }): Player {
  const fv = over.fairValue;
  return {
    externalId: over.id,
    kind: "athlete",
    sport: "nba",
    fullName: over.id,
    firstName: over.id,
    lastName: "",
    position: "G",
    jersey: null,
    teamAbbrev: "AAA",
    teamName: "Test",
    headshotUrl: null,
    ageYears: 25,
    isGoalie: false,
    openingFairValue: fv,
    liquidityDepth: 1000,
    sharesOutstanding: 0,
    marketPrice: fv,
    prevClose: null,
    statTables: [],
    gameLog: [],
    careerValue: [],
    injury: null,
    healthyFairValue: fv,
    ...over,
  } as Player;
}

test("a bot never sizes a trade beyond its budget or its position cap", () => {
  const p = listing({ id: "a", fairValue: 100 });

  // Budget is the binding constraint.
  const small = sharesForBudget(p, 1000, 10_000);
  assert.ok(small > 0 && small < 20, `expected a handful of shares, got ${small}`);
  assert.ok(
    quoteBuy(p.fairValue, p.sharesOutstanding, small, p.liquidityDepth).net <= 1000,
    "sized a trade that costs more than the budget"
  );
  assert.ok(
    quoteBuy(p.fairValue, p.sharesOutstanding, small + 1, p.liquidityDepth).net > 1000,
    "left affordable shares on the table"
  );

  // Cap is the binding constraint.
  assert.equal(sharesForBudget(p, 1_000_000, 25), 25);
  // Nothing affordable at all.
  assert.equal(sharesForBudget(p, 1, 100), 0);
});

test("a value bot sells what has run above performance value", () => {
  const rich = listing({ id: "rich", fairValue: 100, marketPrice: 130, sharesOutstanding: 250 });
  const fair = listing({ id: "fair", fairValue: 100, marketPrice: 101, sharesOutstanding: 10 });

  const orders = decide(
    "value",
    {
      players: [rich, fair],
      change: {},
      held: new Map([
        ["rich", 100],
        ["fair", 100],
      ]),
      cash: 0, // no cash, so only sells are possible
    },
    makeRng(1)
  );

  const sells = orders.filter((o) => o.side === "sell");
  assert.ok(
    sells.some((o) => o.playerId === "rich"),
    "a 30% premium should be sold into"
  );
  assert.ok(
    !sells.some((o) => o.playerId === "fair"),
    "a listing trading at fair value should be left alone"
  );
  // Partial exits, so prices move rather than step.
  const richSell = sells.find((o) => o.playerId === "rich")!;
  assert.ok(richSell.shares > 0 && richSell.shares <= 100);
});

test("a momentum bot sells what has broken down", () => {
  const falling = listing({ id: "falling", fairValue: 100, marketPrice: 88 });
  const steady = listing({ id: "steady", fairValue: 100, marketPrice: 100 });

  const orders = decide(
    "momentum",
    {
      players: [falling, steady],
      change: { falling: -12, steady: 0.5 },
      held: new Map([
        ["falling", 60],
        ["steady", 60],
      ]),
      cash: 0,
    },
    makeRng(2)
  );

  const sells = orders.filter((o) => o.side === "sell");
  assert.ok(sells.some((o) => o.playerId === "falling"), "a 12% drop should trigger an exit");
  assert.ok(!sells.some((o) => o.playerId === "steady"), "a flat listing should be held");
});

test("a bot will not buy past the position limit it already sits at", () => {
  const p = listing({ id: "maxed", fairValue: 50 });
  // positionLimit is 20% of depth, so 200 of a 1,000-depth listing.
  const atCap = positionLimit(p.liquidityDepth);

  const orders = decide(
    "noise",
    {
      players: [p],
      change: {},
      held: new Map([["maxed", atCap]]),
      cash: 100_000,
    },
    makeRng(3)
  );

  assert.ok(
    !orders.some((o) => o.side === "buy"),
    "bought into a position that is already at the cap"
  );
});

test("every order says whether it closes a position or opens one", () => {
  const rich = listing({ id: "rich", fairValue: 100, marketPrice: 140, prevClose: 138, sharesOutstanding: 300 });
  const orders = decide(
    "value",
    { players: [rich], change: {}, held: new Map([["rich", 50]]), cash: 50_000 },
    makeRng(9)
  );
  for (const o of orders) {
    assert.ok(o.intent === "close" || o.intent === "open", `order has no intent: ${o.reason}`);
    // A sell against a held position must be a close, never an accidental short.
    if (o.side === "sell" && o.playerId === "rich" && o.intent === "close") {
      assert.ok(o.shares <= 50, "would sell more than held");
    }
  }
});

test("a value bot shorts what has stayed far above performance value", () => {
  // Expensive at the open as well as now, so it is not just a fresh spike.
  const overpriced = listing({ id: "hot", fairValue: 100, marketPrice: 160, prevClose: 158, sharesOutstanding: 400 });
  const orders = decide(
    "value",
    { players: [overpriced], change: {}, held: new Map(), cash: 100_000 },
    makeRng(4)
  );
  const short = orders.find((o) => o.side === "sell" && o.intent === "open");
  assert.ok(short, "expected a short on a listing 60% above performance value");
  assert.ok(short!.shares > 0);
});

test("a price that only just spiked is not faded", () => {
  // Now 60% above fair value, but it opened at fair value — this is somebody's
  // buy from moments ago, not a listing the market has held up.
  const justMoved = listing({ id: "spike", fairValue: 100, marketPrice: 160, prevClose: 100, sharesOutstanding: 400 });
  const orders = decide(
    "value",
    { players: [justMoved], change: {}, held: new Map([["spike", 40]]), cash: 0 },
    makeRng(5)
  );
  assert.equal(
    orders.filter((o) => o.side === "sell").length,
    0,
    "sold into a move that had only just happened"
  );
});

test("bot trading is spread across the day, not fired all at once", () => {
  const roster = botRoster();

  // No slot should wake the whole roster — that is the behaviour this
  // scheduling exists to stop, because it put a day of movement into one
  // vertical step on the chart.
  const perSlot = SLOT_HOURS.map((_, i) => botsForSlot(i));
  for (const [i, bots] of perSlot.entries()) {
    assert.ok(bots.length > 0, `slot ${i} wakes nobody`);
    assert.ok(
      bots.length < roster.length,
      `slot ${i} wakes all ${roster.length} bots at once`
    );
  }

  // Every bot trades at some point in the day, and more than once.
  for (const bot of roster) {
    const slots = perSlot.filter((s) => s.some((b) => b.index === bot.index)).length;
    assert.ok(slots >= 2, `${bot.username} only trades in ${slots} slot(s)`);
  }

  // Slots are in ascending order, so "the slot the clock is in" is well defined.
  const ascending = [...SLOT_HOURS].every((h, i, a) => i === 0 || h > a[i - 1]);
  assert.ok(ascending, "slot hours must be sorted");
});

test("the current slot resolves to the most recent one that has begun", () => {
  const at = (hour: number) => new Date(Date.UTC(2026, 7, 16, hour, 30));

  // Trading now starts at midnight UTC, so every hour of the day sits at or
  // after a slot — there is no longer a "before the first one" to be absent for.
  assert.equal(currentSlot(at(SLOT_HOURS[0])), 0);
  assert.equal(currentSlot(at(SLOT_HOURS[SLOT_HOURS.length - 1])), SLOT_HOURS.length - 1);

  // The overnight gap holds the last slot before it rather than wrapping to the
  // end of yesterday, so a late or manual run cannot replay the previous night.
  const lastBeforeGap = SLOT_HOURS.filter((h) => h < 10).length - 1;
  assert.equal(currentSlot(at(6)), lastBeforeGap);
  assert.equal(currentSlot(at(9)), lastBeforeGap);

  // A cron firing up to 59 minutes late still resolves to its own slot, which
  // is what Hobby's per-hour scheduling precision requires.
  const slotHour = SLOT_HOURS[5];
  assert.equal(currentSlot(new Date(Date.UTC(2026, 7, 16, slotHour, 0))), 5);
  assert.equal(currentSlot(new Date(Date.UTC(2026, 7, 16, slotHour, 59))), 5);
});
