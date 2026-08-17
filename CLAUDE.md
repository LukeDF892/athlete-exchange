# Athlete Exchange — working notes

A play-money market where NBA, NHL and MLB athletes trade like stocks. Prices
open at what an athlete's real production is worth, then move on supply and
demand. Teams also trade, as value-weighted index funds.

**Live:** https://athlete-exchange-live.vercel.app
**Supabase project ref:** `vdyaspnarorctstwzmpo`
**Vercel project:** `athlete-exchange` (scope `lukeflewwelling-3409s-projects`)

---

## The one idea everything hangs off

```
price(S) = fairValue × e^(S / L)
```

`S` = net shares outstanding, `L` = liquidity depth. At launch `S = 0`, so
**market price equals fair value** — performance rings the opening bell and the
crowd takes it from there. That was the founding problem: where does a starting
price come from with no order book?

Because the curve integrates in closed form, buying `n` shares costs exactly the
area under it, so there is always a counterparty and no order matching is
needed. **The curve mints shares on buy and burns them on sell — supply is
unlimited.** There is no float. That is a deliberate trade for working with three
users; a real fixed float or order book is a future decision, not an oversight.

**An instant round trip is exactly break-even, with or without a fee.** The
integral out equals the integral back. The fee (currently `TRADE_FEE_RATE = 0`)
was only friction, never the thing preventing arbitrage. Do not reintroduce a
fee believing it is load-bearing for that.

## Pricing, in four stages

1. **Raw production score**, per position group. A sport is not one job:
   defencemen, goalies, pitchers and batters each get their own formula in
   `rawProductionScore()`.
2. **Normalise per position** against the league's *measured* median (→30) and
   elite mark (→88). Both anchors are read from the live league at ingest.
3. **Blend windows** — recent 30%, season 45%, career 25% — each regressed
   toward replacement level by `gp/(gp+k)`.
4. **To dollars**: `($4 + (score/100)^2.1 × $476) × ageMultiplier`, then an
   injury multiplier.

All three leagues now fill the `recent` window. NBA and MLB read ESPN's
common-v3 gamelog endpoint (`lib/providers/gamelog.ts`), which costs one extra
request per athlete and also supplies the per-game log the player page shows —
so it is fetched once and carried through `RawPlayer.gameLog`, never twice.
**Rate stats in that window are recomputed, never averaged**: a 1-for-1 night
and an 8-for-19 night do not average to the shooting that happened, the feed's
OPS column is season-to-date rather than per game, and `6.2` innings means six
and two thirds. Full three-league ingest: ~105-120s, against a 300s cron cap.

### Hard-won lessons — do not undo these

- **Two anchors, not one.** Calibrating only the elite mark left the median
  defenceman priced above the median forward and filled the top of the board
  with blue-liners. Median *and* elite must both be anchored.
- **Calibrate each stat window separately.** Measuring on season lines and
  applying to career lines put the median defenceman's career score at 62
  against a forward's 34.
- **Elite is a percentile, not a top-N count.** Top-5-of-806 (NHL) is a harsher
  bar than top-5-of-474 (NBA), which let league size silently set prices.
- **Volume beats efficiency.** An earlier version collapsed to PER × age and
  ranked an efficient low-usage big above the league's best guards.
- **Age tilts, never decides.** A 0.35 floor priced a productive 41-year-old
  LeBron below the 140th-best player. Floor is 0.55.
- **Premium is measured against zero, not the index.** Subtracting the board
  average printed red for an athlete trading *above* their performance value.

## Repo map

| Path | What lives there |
| --- | --- |
| `lib/pricing/engine.ts` | Curve, production scores, age curve, quotes |
| `lib/pricing/calibrate.ts` | Measures median/elite per position per window |
| `lib/providers/` | `espn.ts` (NBA), `nhl.ts`, `mlb.ts`, `injuries.ts`, `gamelog.ts`, `draft.ts` |
| `lib/market/digest.ts` | Daily movers, split performance vs market |
| `lib/market/admin.ts` | Operator reads; retirement is the one write path |
| `lib/notify/` | Daily email — inert unless `RESEND_API_KEY` + `DIGEST_FROM` |
| `lib/bots/` | Bot identities, strategies, and the daily trading run |
| `lib/market/source.ts` | Single place deciding DB vs snapshot |
| `lib/market/teams.ts` | Team index construction |
| `lib/market/portfolio.ts` | Positions, trades, watchlist, leaderboard |
| `scripts/ingest.ts` | Two-pass: fetch everything, then calibrate, then price |
| `supabase/migrations/` | Numbered, idempotent, safe to re-run |

## Non-obvious facts

- **The pricing maths exists twice** — TypeScript for quotes, SQL for
  execution. They must round identically: gross and fee each rounded to the
  cent from the *exact* curve area, net is their exact sum. A one-cent sell
  divergence shipped once. `npm run verify:trading` guards this against the
  live database and is the only test that can reach the SQL copy.
- **Scripts run under `tsx`, outside Next**, so they need `@next/env`'s
  `loadEnvConfig` to see `.env.local`, and `--experimental-websocket` because
  Node 20 has no global `WebSocket` and supabase-js builds a realtime client
  eagerly.
- **`data/snapshot.json` is gitignored but must ship to Vercel** — it is what
  signed-out visitors read. `.vercelignore` exists solely to override that.
- **Market data is public as of migration 0013.** `players`, `price_ticks`,
  `news` and `news_players` are readable by `anon`, so signed-out visitors get
  the live board, working change columns and a real digest. The snapshot is now
  only a fallback for running without a database. Personal tables (profiles,
  holdings, trades, watchlist, portfolio_snapshots) stay gated.
- **The `leaderboard` view needed an explicit `revoke`.** It runs
  `security_invoker = false` so RLS never applies, and Supabase grants
  public-schema views to `anon` by default — every username and net worth was
  readable without an account. `revoke select ... from anon` (bottom of 0013)
  is applied; anon now gets 42501. Any future view with `security_invoker =
  false` needs the same treatment, because RLS will not do it for you.
- **A league returning zero players is not a success.** A rate-limited NFL run
  resolved with an empty roster, was not counted as failed, and silently erased
  all 1,712 football listings from the snapshot. `runIngest` now treats an empty
  league as missing and carries the previous one forward. The database was
  unaffected, because the push is an upsert.
- **Short chart ranges come from the game log.** Each `GameLogEntry` carries the
  value of the trailing window ending that day, priced at ingest with the same
  `fairValue()` the season points use — so 1W/1M are the same measurement at a
  finer grain. Note `productionScore` clamps at 100, so a superstar on an
  exceptional run flatlines at the top of the scale; that is the market's scale,
  not a bug, and raising the clamp would reprice every listing.
- **Client components must not import from modules that touch
  `lib/supabase/server`** — it drags `next/headers` into the browser bundle and
  breaks the build. Pure constants live in `lib/market/types.ts`.
- **Injury matching is by name**, because ESPN's injury feed has no athlete
  ids. `InjuryIndex` resolves team+name first, then name, then first-initial +
  surname, and **refuses to answer when a tier is ambiguous** — two athletes
  sharing a normalised name would otherwise give one of them the other's torn
  ACL. A miss costs a discount; a wrong match costs a wrong price. Currently
  matches ~460 of 464.
- **`NOT VALID` on a CHECK constraint is not a grandfather clause.** It skips
  the backfill scan, but every later UPDATE to the row is still checked —
  including updates that never touch the constrained column. 0012 added a
  username shape check that way, and because `execute_trade()` writes
  `profiles.cash_balance`, the two accounts with a space in their username
  (two real accounts) silently could not trade at all. 0014 widens
  the pattern to the names people actually have and validates it properly.
  Before constraining a `profiles` column, ask what else writes to that row.
- **Bots are ordinary accounts, on purpose.** They sign in with a password and
  call `execute_trade()` like anyone else, so the position cap, cash check and
  rounding all apply — a bot writing to `holdings` with the service key could do
  things no human can, and the prices would be fiction. Credentials are derived
  (`HMAC(BOT_SECRET, "bot-N")`), so rotating `BOT_SECRET` orphans every bot
  until `npm run bots:seed` reruns. Usernames are `bot_<strategy>_<n>` and the
  leaderboard labels them.
- **Bot price impact is capped at about +22% per listing per account**, because
  the position limit is 20% of depth and `e^0.2 ≈ 1.221`. Cheap, shallow
  listings hit that cap on a single run; value bots sell back once the premium
  passes 12%, which is what stops momentum running away.
- **Hobby allows 100 cron jobs per project, each capped at one run per day** —
  not two jobs, which is what an earlier note here claimed. So spreading bot
  trading across the day is a matter of *several* daily jobs at different hours,
  not one frequent job. There are eight `/api/cron/bots` entries plus
  `/api/cron/refresh` at 09:00 UTC. Hobby scheduling is per-hour accurate
  (±59 min), which suits this — trades do not land at predictable clock times.
- **Bots wake in slots, not all at once.** `SLOT_HOURS` in `lib/bots/identity.ts`
  lists the eight hours; `botsForSlot()` wakes about three bots each time and
  every bot trades in two slots. Firing all twelve together put a whole day of
  movement into one instant, so the price chart showed a single vertical step.
  The route derives its slot from the clock (`?slot=N` and `?all=1` are for
  testing only), so a cron that fires 40 minutes late still runs its own slot.
- **A server-prop control needs optimistic state.** The board's 1D/1W/1M buttons
  read `changeWindow` from the server, and re-rendering takes 1.5-2s because the
  server reads price history for every listing — so a click left the button
  unlit and the control felt broken ("you have to click other locations"). Fixed
  with a local `pickedWindow` + `useTransition` that wins until the prop catches
  up. Any future server-driven toggle here needs the same treatment.
- **The daily email sends nothing until three switches are on**: `RESEND_API_KEY`,
  `DIGEST_FROM` (a verified sender), and a per-user opt-in stored in
  `user_metadata.email_digest`. Absent means no, and a quiet day sends nothing
  at all rather than mailing "nothing happened".
- **ESPN publishes no MLB draft** — `/seasons/{year}/draft/rounds` returns an
  empty document for baseball in every year tried. NHL comes from
  api-web.nhle.com, NBA from ESPN's rounds endpoint (one extra request per pick,
  hence the two-round cap). MLB draftees have no source.
- **The production cron takes ~145s** against its 300s ceiling — noticeably
  slower than the ~106s local run. Verify with:
  `curl -H "Authorization: Bearer $CRON_SECRET" <site>/api/cron/refresh`
- **ESPN rate-limits at around two full ingests back to back** (HTTP 403 on the
  *first* request, which looks like an outage). The ingest uses
  `Promise.allSettled` per league and carries the previous snapshot's listings
  forward for any league that failed — including its team indexes. Dropping
  teams from that carry-forward silently deleted 60 listings from the public
  board, and `npm test` caught it.
- **The database push never deletes** — it upserts, and reads
  `shares_outstanding` / `liquidity_depth` / `opening_fair_value` back off the
  existing row. A partial ingest is therefore safe; the snapshot file is the
  fragile half, because it is a full overwrite and is what signed-out visitors
  read.
- **Market board payload**: send `MarketRow`, never full `Player`. Full records
  for 1,280 athletes was a 5.7 MB homepage. Rendering is capped at 100 rows.
- **RLS is the boundary, not the app.** Migration 0008's self-update policy
  pinned `is_admin` but not `cash_balance`, so any signed-in user could have set
  their own balance via PostgREST directly. 0012 pins both; the only column a
  user may write on their own profile is `username`. When adding a column to
  `profiles`, decide explicitly whether that policy should let it through.

## This machine

- **Disk runs at 95-100% full.** `npm install` and builds fail with `ENOSPC`,
  and npx can fail in disguise ("This is not the tsc command you are looking
  for" actually meant no disk). `npm cache clean --force` frees 2-3 GB.
- **Typechecks take 8-10 minutes.** Use `./node_modules/.bin/tsc --noEmit`
  rather than `npx tsc`. Run it to completion *before* deploying — using
  Vercel's remote build as a typechecker emails the user on every failure.
- **The clipboard is shared.** Migrations are applied by pasting into the
  Supabase SQL editor via the Chrome extension; the user copying anything
  mid-flow clobbers it. Always screenshot and verify the editor contents
  before clicking Run.

## Commands

```bash
npm run dev                  # localhost:3000
npm run ingest               # rebuild data/snapshot.json from live feeds
npm run ingest -- --push     # also upsert into Supabase
npm test                     # pricing engine, no database needed
npm run verify:trading       # end-to-end trade check against the real database
npm run verify:rls           # proves a user cannot set their own cash or admin flag
npm run bots:seed            # create/repair the 12 bot accounts (needs BOT_SECRET)
npm run reset:market -- --yes  # DESTRUCTIVE: back to opening day, see below
./node_modules/.bin/tsc --noEmit
vercel deploy --prod         # then re-point the alias, see below
vercel alias set <deployment-url> athlete-exchange-live.vercel.app
```

Aliases attach to a specific deployment, so **every deploy needs the alias
re-pointed** or the live URL keeps serving the old build.
