/**
 * Builds the exchange from live feeds.
 *
 * Callable from two places, which is why it lives in lib rather than scripts:
 *   * `npm run ingest` for a local rebuild
 *   * the scheduled route at /api/cron/refresh, which is what makes fair value
 *     a moving number instead of one frozen at whenever it was last run by hand
 *
 * On Vercel the filesystem is read-only, so the snapshot file is written only
 * when running locally. The database push is the part that matters in
 * production; the snapshot exists so the app runs before any database does.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// This script runs under plain tsx, not the Next.js runtime, so nothing has
// loaded .env.local yet. Use Next's own loader so --push sees exactly the same
// variables (and the same precedence) the app does.
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { fairValue, liquidityDepth, marketPrice, type Calibration, type Sport } from "@/lib/pricing/engine";
import { calibrateLeague } from "@/lib/pricing/calibrate";
import { fetchInjuries, normalizeName, type InjuryStatus } from "@/lib/providers/injuries";
import { mapPool } from "@/lib/providers/http";
import { NhlProvider } from "@/lib/providers/nhl";
import { nbaProvider } from "@/lib/providers/espn";
import { mlbProvider } from "@/lib/providers/mlb";
import { nflProvider } from "@/lib/providers/nfl";
import type { RawPlayer, SportsProvider } from "@/lib/providers/types";
import { fetchAllNews, matchPlayers } from "@/lib/news/rss";
import type { NewsItem, Player } from "@/lib/market/types";
import { buildCareerValue } from "@/lib/market/career";
import { buildTeams } from "@/lib/market/teams";
import { fetchNhlDraft, fetchNbaDraft, listableProspects, type DraftProspect } from "@/lib/providers/draft";

/**
 * Upper bound on players fetched per league — high enough to cover every
 * roster (~570 NBA, ~800 NHL) rather than to curate the board. Set
 * INGEST_LIMIT lower for a fast development run.
 */
// MLB carries the largest pool: 40-man rosters plus the injured list run to
// ~3,700 ids before the "has played a major-league season" filter thins them.
const PER_SPORT_LIMIT = Number(process.env.INGEST_LIMIT ?? 9000);
const CONCURRENCY = 8;

function slugId(externalId: string): string {
  return externalId.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

function toPlayer(
  raw: RawPlayer,
  calibration: Calibration,
  injury: InjuryStatus | undefined
): Player {
  const healthy = fairValue({
    sport: raw.sport,
    recent: raw.recent,
    season: raw.season,
    career: raw.career,
    ageYears: raw.ageYears,
    position: raw.position,
    calibration,
  });
  // An injury discounts the price but must not reshape the curve underneath
  // existing holders, so liquidity depth is taken from the healthy value.
  const fv = injury ? round2(healthy * injury.multiplier) : healthy;
  const depth = liquidityDepth(healthy);
  return {
    id: slugId(raw.externalId),
    externalId: raw.externalId,
    kind: "athlete",
    sport: raw.sport,
    fullName: raw.fullName,
    firstName: raw.firstName,
    lastName: raw.lastName,
    position: raw.position,
    jersey: raw.jersey,
    teamAbbrev: raw.teamAbbrev,
    teamName: raw.teamName,
    headshotUrl: raw.headshotUrl,
    ageYears: raw.ageYears,
    isGoalie: raw.isGoalie,
    fairValue: fv,
    openingFairValue: fv,
    liquidityDepth: depth,
    // Nobody has traded yet, so the market opens exactly at fair value.
    sharesOutstanding: 0,
    marketPrice: marketPrice(fv, 0, depth),
    prevClose: null,
    statTables: raw.statTables,
    // Already fetched alongside the recent-form window where a provider has one.
    gameLog: raw.gameLog ?? [],
    careerValue: buildCareerValue(raw, calibration),
    healthyFairValue: healthy,
    injury: injury
      ? {
          status: injury.status,
          summary: injury.summary,
          returnDate: injury.returnDate,
          daysOut: injury.daysOut,
          multiplier: injury.multiplier,
        }
      : null,
  };
}

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}


/**
 * A drafted prospect as a tradeable listing.
 *
 * Priced from draft position rather than production, because there is no
 * professional production yet. Deliberately shallower liquidity than a proven
 * athlete: less is known, so opinion should move the price more.
 */
function prospectToPlayer(p: DraftProspect): Player {
  const depth = Math.max(400, Math.round(liquidityDepth(p.fairValue) * 0.6));
  return {
    id: slugId(p.externalId),
    externalId: p.externalId,
    kind: "prospect",
    sport: p.sport,
    fullName: p.fullName,
    firstName: p.firstName,
    lastName: p.lastName,
    position: p.position,
    jersey: null,
    teamAbbrev: p.teamAbbrev,
    teamName: p.teamName,
    headshotUrl: null,
    ageYears: null,
    isGoalie: p.position === "G",
    fairValue: p.fairValue,
    openingFairValue: p.fairValue,
    liquidityDepth: depth,
    sharesOutstanding: 0,
    marketPrice: marketPrice(p.fairValue, 0, depth),
    prevClose: null,
    statTables: [
      {
        window: "season",
        label: `${p.draftYear} draft`,
        rows: [
          { label: "Pick", value: `#${p.overallPick}` },
          { label: "Round", value: String(p.round) },
          { label: "Team", value: p.teamAbbrev ?? "—" },
          { label: "From", value: p.amateurClub ?? "—" },
          { label: "League", value: p.amateurLeague ?? "—" },
        ],
      },
    ],
    gameLog: [],
    // No professional seasons yet, so no career arc to draw.
    careerValue: [],
    injury: null,
    healthyFairValue: p.fairValue,
    draft: {
      year: p.draftYear,
      round: p.round,
      overallPick: p.overallPick,
      amateurClub: p.amateurClub,
      amateurLeague: p.amateurLeague,
    },
  };
}

/**
 * Every player on a roster gets listed.
 *
 * There used to be a cut to the top N by price, which quietly dropped real
 * stars: a 41-year-old LeBron priced below the 140th-best player on the age
 * curve alone and simply vanished from the board. A market missing its most
 * recognisable names is worse than a long one, and the UI already filters and
 * searches, so the roster is the only sensible cut.
 */
async function fetchSport(provider: SportsProvider, limit: number): Promise<RawPlayer[]> {
  const label = provider.sport.toUpperCase();
  process.stdout.write(`[${label}] listing players… `);
  const ids = await provider.listPlayerIds(limit);
  console.log(`${ids.length} on rosters`);

  const results = await mapPool(ids, CONCURRENCY, (id) => provider.fetchPlayer(id));

  const raws: RawPlayer[] = [];
  let failed = 0;
  let noStats = 0;
  for (const r of results) {
    if (!r.ok) {
      failed++;
      continue;
    }
    // A null result means the feed has no completed season for them — a
    // two-way signing or a rookie who has not debuted. Nothing to price.
    if (r.value) raws.push(r.value);
    else noStats++;
  }

  console.log(
    `[${label}] fetched ${raws.length} players (${failed} feed errors, ${noStats} without a played season)`
  );
  return raws;
}

async function attachGameLogs(provider: SportsProvider, players: Player[]): Promise<void> {
  if (!provider.fetchGameLog) return;
  const mine = players.filter((p) => p.sport === provider.sport);
  const results = await mapPool(mine, CONCURRENCY, (p) => provider.fetchGameLog!(p.externalId, 5));
  results.forEach((r, i) => {
    if (r.ok && r.value.length > 0) mine[i].gameLog = r.value;
  });
}

/**
 * Listings for leagues that failed this run, read back off the last snapshot.
 *
 * Returns nothing when there is no previous snapshot to read, which is the
 * first-run case — better an incomplete board than a crash on a cold start.
 */
async function carryForward(sports: Sport[]): Promise<Player[]> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(path.join(process.cwd(), "data", "snapshot.json"), "utf8");
    const prev = JSON.parse(raw) as { players?: Player[] };
    const wanted = new Set(sports);
    // Teams included. buildTeams() only produces indexes for leagues that
    // actually priced this run, so a failed league has no freshly built team to
    // collide with — and dropping them here silently deleted every NBA and MLB
    // team index from the public board the first time a feed 403'd.
    return (prev.players ?? []).filter((p) => wanted.has(p.sport));
  } catch {
    return [];
  }
}

export interface IngestOptions {
  /** Upsert into Supabase as well as building the snapshot. */
  push?: boolean;
  /**
   * Restrict the run to these leagues.
   *
   * A four-league ingest takes about 340 seconds, which is over the 300-second
   * ceiling a scheduled function gets — so the daily refresh runs one league
   * per cron rather than all four at once. Leagues left out are carried forward
   * exactly as a failed league is, and the database push is an upsert, so a
   * partial run never removes anything.
   */
  sports?: Sport[];
}

export interface IngestResult {
  players: number;
  teams: number;
  prospects: number;
  news: number;
  pushed: boolean;
}

export async function runIngest(options: IngestOptions = {}): Promise<IngestResult> {

  const push = options.push ?? false;
  const started = Date.now();

  const wanted = options.sports;
  const runs = (s: Sport) => !wanted || wanted.includes(s);

  const nhl = new NhlProvider();
  /**
   * One league failing must not take the other two with it.
   *
   * This used to be a plain Promise.all, which meant a single 403 on ESPN's
   * MLB season endpoint — the first request of three thousand — aborted the
   * entire run and left every price in all three leagues stale for the day.
   * Rate limiting is routine on these unofficial feeds, so the daily refresh
   * has to survive it.
   */
  const skip = async (): Promise<RawPlayer[]> => [];
  const settled = await Promise.allSettled([
    runs("nhl") ? fetchSport(nhl, PER_SPORT_LIMIT) : skip(),
    runs("nba") ? fetchSport(nbaProvider, PER_SPORT_LIMIT) : skip(),
    runs("mlb") ? fetchSport(mlbProvider, PER_SPORT_LIMIT) : skip(),
    runs("nfl") ? fetchSport(nflProvider, PER_SPORT_LIMIT) : skip(),
  ]);
  const [nhlRaw, nbaRaw, mlbRaw, nflRaw] = settled.map((r) =>
    r.status === "fulfilled" ? r.value : []
  );
  const failedSports: Sport[] = [];
  (["nhl", "nba", "mlb", "nfl"] as const).forEach((s, i) => {
    const r = settled[i];
    if (r.status === "rejected") {
      failedSports.push(s);
      console.warn(`[${s.toUpperCase()}] feed failed, keeping existing prices: ${
        r.reason instanceof Error ? r.reason.message : String(r.reason)
      }`);
    }
  });
  const raws = [...nbaRaw, ...nhlRaw, ...mlbRaw, ...nflRaw];
  if (raws.length === 0) {
    // Nothing was fetched at all, so there is nothing to calibrate against and
    // any output would be worse than yesterday's.
    throw new Error("every league feed failed — refusing to overwrite the board");
  }

  // Pass two: measure what elite production looks like at each position from
  // the league we just fetched, then price everybody against their own peers.
  // This has to happen after the fetch and before any pricing, which is why
  // ingest is two passes rather than one.
  const calibration = calibrateLeague(
    raws.map((r) => ({
      sport: r.sport,
      position: r.position,
      isGoalie: r.isGoalie,
      recent: r.recent,
      season: r.season,
      career: r.career,
    }))
  );
  console.log(
    "[calibration] median→elite raw score by position — " +
      Object.entries(calibration.season)
        .map(([g, v]) => `${g.replace(/^(nba|nhl)-/, "")} ${v.median.toFixed(0)}→${v.elite.toFixed(0)}`)
        .join(", ")
  );

  // Injuries, fetched once per league and matched by name — the feed gives no
  // athlete ids, so a miss means no discount rather than a wrong one.
  const injuryMaps = await Promise.all(
    (["nba", "nhl", "mlb", "nfl"] as const).map(async (s) => [s, await fetchInjuries(s)] as const)
  );
  const injuries = new Map(injuryMaps);
  let matched = 0;
  const totalInjuries = injuryMaps.reduce((a, [, m]) => a + m.size, 0);

  const players = raws.map((r) => {
    // Team first: it is what separates two athletes who share a name, and the
    // index declines to guess when it cannot tell them apart.
    const injury = injuries.get(r.sport)?.lookup(r.fullName, r.teamAbbrev);
    if (injury) matched++;
    return toPlayer(r, calibration, injury);
  });
  console.log(
    `[injuries] ${matched} of ${totalInjuries} reported injuries matched to listed athletes`
  );
  const ambiguous = injuryMaps.flatMap(([s, m]) => m.ambiguous().map((n) => `${s}:${n}`));
  if (ambiguous.length > 0) {
    // Named rather than counted: a shared name is worth seeing, because the
    // athlete who lost their discount to it is a real price that is now wrong
    // in the safe direction.
    console.log(`[injuries] ${ambiguous.length} ambiguous name(s): ${ambiguous.join(", ")}`);
  }
  // Drafted prospects who have not debuted. The roster pipeline cannot see
  // them, so they are added separately — but only when nobody with that name
  // is already listed, so a prospect vanishes the moment they play a real game
  // and get priced on production instead.
  const listedNames = new Set(players.map((p) => normalizeName(p.fullName)));
  const draftYear = new Date().getFullYear();
  // Both leagues that publish a draft. MLB has no source — ESPN returns an
  // empty document for baseball in every year tried.
  const [nhlDraft, nbaDraft] = await Promise.all([
    fetchNhlDraft(draftYear),
    fetchNbaDraft(draftYear),
  ]);
  const prospects = listableProspects([...nhlDraft, ...nbaDraft])
    .filter((p) => !listedNames.has(normalizeName(p.fullName)))
    .map(prospectToPlayer);
  if (prospects.length > 0) {
    players.push(...prospects);
    const bySport = (s: Sport) => prospects.filter((p) => p.sport === s).length;
    console.log(
      `[draft] listed ${prospects.length} ${draftYear} prospects ` +
        `(${bySport("nhl")} NHL, ${bySport("nba")} NBA; top: ${prospects[0].fullName} ${prospects[0].fairValue})`
    );
  } else {
    console.log(`[draft] no listable ${draftYear} prospects found`);
  }

  // Teams are built from priced athletes, so this must run after pricing.
  const teams = buildTeams(players);
  console.log(`[teams] built ${teams.length} team index listings`);
  players.push(...teams);
  players.sort((a, b) => b.fairValue - a.fairValue);
  process.stdout.write("[game logs] fetching… ");
  await attachGameLogs(nhl, players);
  console.log("done");

  process.stdout.write("[news] fetching feeds… ");
  let news: NewsItem[] = [];
  try {
    const raw = await fetchAllNews();
    const index = players.map((p) => ({ id: p.id, fullName: p.fullName, sport: p.sport }));
    news = raw.slice(0, 120).map((item, i) => ({
      id: `news-${i}`,
      title: item.title,
      summary: item.summary,
      url: item.url,
      source: item.source,
      imageUrl: item.imageUrl,
      publishedAt: item.publishedAt,
      sport: item.sport,
      playerIds: matchPlayers(item, index),
    }));
    console.log(`${news.length} stories, ${news.filter((n) => n.playerIds.length > 0).length} tagged to players`);
  } catch (err) {
    console.warn("news fetch failed (continuing):", (err as Error).message);
  }

  // A league whose feed failed is absent from `players`. The database is an
  // upsert so it simply keeps yesterday's rows, but the snapshot file is a full
  // overwrite and is what signed-out visitors read — rewriting it now would
  // erase that league from the public board. So carry the previous listings
  // forward, stale but present, which is strictly better than missing.
  const skipped = (["nhl", "nba", "mlb", "nfl"] as const).filter((s) => !runs(s));
  const missing = [...new Set([...failedSports, ...skipped])];
  if (missing.length > 0) {
    // Deduped against what this run already produced. The draft step is not
    // scoped by league, so a single-league run rebuilds every prospect while
    // the carry-forward also restores them — which put 123 duplicate ids into
    // the snapshot the first time a scoped run happened.
    const present = new Set(players.map((p) => p.id));
    const carried = (await carryForward(missing)).filter((p) => !present.has(p.id));
    if (carried.length > 0) {
      players.push(...carried);
      players.sort((a, b) => b.fairValue - a.fairValue);
      console.log(
        `[snapshot] carried ${carried.length} listings forward for ${missing.join(", ")}`
      );
    }
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    players,
    news,
  };

  // Vercel's filesystem is read-only outside /tmp, and the snapshot is only
  // needed for local development and the deployed bundle — not for a refresh.
  if (!process.env.VERCEL) {
    const outDir = path.join(process.cwd(), "data");
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "snapshot.json"), JSON.stringify(snapshot, null, 2));
  }

  const bySport = (s: Sport) => players.filter((p) => p.sport === s).length;
  console.log(
    `\nWrote data/snapshot.json — ${players.length} players (${bySport("nba")} NBA, ${bySport(
      "nhl"
    )} NHL, ${bySport("mlb")} MLB, ${bySport("nfl")} NFL), ${news.length} stories in ${(
      (Date.now() - started) / 1000
    ).toFixed(1)}s`
  );
  console.log("Top of the board:");
  for (const p of [...players].sort((a, b) => b.marketPrice - a.marketPrice).slice(0, 8)) {
    console.log(
      `  ${p.sport.toUpperCase()}  ${p.fullName.padEnd(24)} $${p.marketPrice.toFixed(2)}`
    );
  }

  if (push) {
    // Prospects need the kind constraint widened (migration 0009). Until that
    // runs, one rejected prospect row fails the whole batch and the database
    // keeps yesterday's board while signed-out visitors see today's — which
    // looks like a display bug and is really a failed write. Drop them from the
    // push rather than losing the other 3,600 listings over 62.
    const canPushProspects = process.env.PROSPECTS_SUPPORTED !== "false";
    const pushable = canPushProspects
      ? snapshot
      : {
          ...snapshot,
          players: snapshot.players.filter((p) => p.kind !== "prospect"),
        };
    if (!canPushProspects) {
      const held = snapshot.players.length - pushable.players.length;
      console.log(`[supabase] holding back ${held} prospects until migration 0009 runs`);
    }
    const { pushSnapshot } = await import("@/scripts/push-supabase");
    await pushSnapshot(pushable);
  } else {
    console.log("\n(no --push: Supabase not written. Run with --push once keys are set.)");
  }

  return {
    players: players.length,
    teams: players.filter((p) => p.kind === "team").length,
    prospects: players.filter((p) => p.kind === "prospect").length,
    news: news.length,
    pushed: push,
  };
}
