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

All four leagues fill the `recent` window, and all four now also supply the
per-game series the short chart ranges are drawn from. NBA, MLB and NFL read
ESPN's common-v3 gamelog endpoint (`lib/providers/gamelog.ts`), which costs one
extra request per athlete and also supplies the per-game log the player page
shows — so it is fetched once and carried through `RawPlayer.gameLog`, never
twice. The NHL needs no extra request at all: its landing payload already
carries `last5Games`, which is both the window and the log.
**Rate stats in that window are recomputed, never averaged**: a 1-for-1 night
and an 8-for-19 night do not average to the shooting that happened, the feed's
OPS column is season-to-date rather than per game, and `6.2` innings means six
and two thirds. Full four-league ingest: ~340s in principle, 18 minutes on this
machine — so the daily refresh runs one league per cron.

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
- **Every provider carries its own game log; there is no second pass.** The
  ingest used to re-fetch the NHL log *after* pricing (`attachGameLogs`), which
  overwrote each row with an unvalued copy — the real reason no NHL listing ever
  had chart values, on top of the missing series. `RawPlayer.gameLog` and
  `recentSeries` now come out of the same payload for all four leagues, and
  `withGameValues()` joins them by date, so a provider that sets one must set
  the other from the *same* array or the join silently finds nothing.
- **The NHL series is a three-game window, not five.** `recent` is priced on all
  five games the landing feed gives, but the *series* walks a three-game window
  forward, because five would leave every point after the first measured over
  four games, then three, then two — and `shrinkToReplacement` regresses a small
  sample, so that draws a rising line for every player whether or not anyone is
  playing well. Equal windows are what make the shape mean anything. Five games
  yields three points; McDavid's two oldest rows have a null value by design.
- **The short ranges are wall-clock, so they vanish out of season.** The chart
  offers 1W/1M only when two valued games fall inside the last 7 or 30 *days*.
  In August that is MLB and nothing else: NHL rows carry values now, but they
  are April games, so an NHL chart still shows only 3Y/5Y/10Y/ALL until October.
  Values present and buttons absent is the correct state, not a regression.
- **Client components must not import from modules that touch
  `lib/supabase/server`** — it drags `next/headers` into the browser bundle and
  breaks the build. Pure constants live in `lib/market/types.ts`; the tape's row
  type and its mapper live in `lib/market/tape-row.ts` for the same reason, so
  the browser and the server read a `trade_tape` row through one function.
- **Realtime obeys RLS, so a live tape cannot listen to `trades`.** The obvious
  wiring — subscribe to INSERTs on `trades` — fails in the most misleading way
  available: "trades are self-readable" applies to the websocket too, so a
  browser is told about its own trades and nothing else. The tape would look
  alive for the trades you just made and dead for every bot. `useLiveTape`
  therefore separates the *signal* from the *data*: `players` is public
  (migration 0013) and every trade updates the row it traded, so a price change
  says "something happened", and the tape is then re-read from `trade_tape`,
  which is granted to `anon`. Refetches are debounced 800ms because an ingest
  updates every listing on the board and that is one refresh, not 5,344.
- **One subscription per player page, shared by context.** `LivePlayerProvider`
  wraps the page and the header price, the position panel and the trade ticket
  all read `useLiveQuote()`. Adding a fourth consumer costs nothing; opening a
  second channel per component would cost a socket subscription each and, if two
  ever shared a topic name, would conflict rather than duplicate.
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

- **Check mobile by measuring, not by looking.** The board rendered fine in a
  narrow screenshot while the document scrolled sideways 336px at 390px wide:
  the nav (five tabs plus Sign in) and the market filter row both overflowed,
  and because the header is sticky it dragged the whole page with it. Measure
  `documentElement.scrollWidth - clientWidth`; it should be 0.
- **`trade_tape` publishes less than `trades` does.** Share counts and listings
  are market information, the cash each trade moved is not — so `net` is absent
  from the view entirely rather than merely unselected. It is another
  `security_invoker = false` view, so its grant is explicit.

- **Shorting needed no new pricing maths.** `price(S) = fairValue × e^(S/L)` is
  defined for negative `S`, and `curve_area()` is the same integral in either
  direction — so a short round trip is break-even for exactly the reason a long
  one is. What it needed was bookkeeping: negative holdings, per-position
  `collateral`, and `margin_call()`.
- **Two constraints blocked negative supply**, and only one was obvious:
  `holdings_shares_check` *and* `players_shares_outstanding_check`. Missing the
  second meant shorts were rejected mid-transaction, which in a test run left an
  orphaned long and a price 100 shares above where any holder existed. When
  changing sign conventions, grep for every `>= 0` check, not just the one you
  are thinking about.
- **Shorting costs buying power, never creates it.** Proceeds are credited to
  cash but 1.5× them is locked, so `available_cash()` = cash − Σ collateral is
  the number every buy is checked against. `npm run verify:shorting` asserts
  this alongside the break-even round trip and the no-crossing-zero rule.
- **An order may not cross zero.** Short 50 and buy 80 is rejected rather than
  covering and going long in one step — one trade, one meaning, and it halves
  the paths through the most safety-critical function in the app.
- **Bots stay long-only on purpose.** `runBots` reads holdings with
  `.gt("shares", 0)`; a negative position would make `decide()` try to "sell"
  it, which opens a bigger short rather than closing anything.

- **The trend sparkline was drawn from `careerValue`** — a season-by-season arc
  going back to a rookie year — while sitting beside a 1D/1W/1M selector, so it
  never changed when the window did. `getPriceTrends(window)` now reads actual
  price ticks for the selected period and thins them to twelve points; "career"
  is the one window that legitimately wants the season arc. A listing with no
  ticks in the window gets no sparkline rather than a career shape standing in
  for one.
- **Thirty bots, value-weighted (9 momentum / 14 value / 7 noise).** Twelve woke
  only three per slot. The mix is not an even split on purpose: value bots are
  the ones that sell into a premium, and momentum and noise both accumulate, so
  scaling them equally would have worsened the 158-buys-to-12-sells drift.

- **`side` alone is ambiguous once shorting exists**, so `trades.action` records
  buy/sell/short/cover. Without it a short open is indistinguishable from taking
  profit on a long, and the activity list reported the *borrowed proceeds* of a
  freshly opened short as realized profit — `realized = net - shares * avgCost`
  with `avgCost` of 0. Only closing a position realizes anything. Rows predating
  shorting have a null action and fall back to `side`, which is correct because
  every one of them was a long.
- **`bots:seed` must never write `cash_balance`.** It used to set it to 100,000
  on every run "to top up after a reset", which handed free money to any bot
  holding positions: cash restored to full while the holdings stayed, putting
  twelve bots at ~$180,000 against a $100,000 start. Balances belong to
  `reset:market`.

- **Bots trade continuously, not in bursts.** Two earlier attempts shrank the
  burst without changing its shape, because the loop was "for each bot, sign in
  and fire all its orders" — that empties a slot in seconds however many slots
  exist. `runBots` now gathers every bot's intentions first, interleaves them so
  consecutive orders come from different traders, and executes one at a time
  across a 240s window. Measured: 11 orders over 222s, a steady 22s apart.
  `SLOT_TIMES` is 90 firing points every ten minutes (11:00-01:50 UTC), each
  naming its own slot in the cron query string — Hobby fires a job anywhere
  inside its hour, so inferring the batch from the clock lets jitter pick the
  wrong one. 94 crons against Hobby's 100 is why the day ends at 02:00.
  Covering a losing short is exempt from the spreading: a stop that waits four
  minutes is not a stop.
- **`/games` uses the scoreboard endpoint, not the per-team schedule.** Building
  "what is on tonight" from per-team feeds is ~130 requests for one page; the
  scoreboard returns a league's whole day in one. Team pages read injuries off
  the player row so what is shown is the injury the price was discounted for.

## Where things stand

Everything below is deployed and committed. Both of the previously known-broken
items are fixed and were watched working on the deployed build:

1. **Per-game chart values.** The NHL provider now builds `recentSeries` from
   its landing feed and carries the log alongside it, and all four leagues were
   re-ingested and pushed (5,344 listings). 777 of 905 NHL listings carry values
   where before none did; MLB 1,411, NFL 1,515, NBA 473. Verified on screen:
   Junior Caminero's chart offers 1W and draws value-by-game. NHL charts still
   show only season ranges, correctly — see the wall-clock note above.
2. **Live updates.** The player page price, its trade tape, the market-wide
   tape and the trade ticket's quote all follow the websocket now, through one
   subscription per page (`LivePlayerProvider`). Watched on the production build
   during bot slot 84: Ben Meyers went $12.37 → $11.63 with the premium line and
   the ticket's spot price following it and the tape gaining the trade, no
   reload. The market tape recorded 57 live updates over a 3½-hour session.

Still not watched on screen: **the position panel** (`YourPosition`). It reads
the same `LiveQuote` context as the header price that was verified, but showing
it needs a signed-in account holding shares, and signing in is the user's to do.
To close that: open a listing you hold during a slot (11:00-01:50 UTC, every ten
minutes) and watch "Market value".

Also outstanding, needing the user rather than code: `gh` is not installed so
the repo has no remote; email needs a Resend key (`RESEND_API_KEY` +
`DIGEST_FROM`); and five sibling projects in this folder are still unversioned.

One thing found while verifying and left alone: **the player page overflows
sideways on a phone** — 152px at a 375px viewport, from the Upcoming games
fixture row, not from anything live. The previous production build does exactly
the same, so it arrived with `/games`, not with this work. The homepage measures
0, so the rule in the mobile note still holds where it was applied.

## This machine

- **Disk runs at 95-100% full.** `npm install` and builds fail with `ENOSPC`,
  and npx can fail in disguise ("This is not the tsc command you are looking
  for" actually meant no disk). `npm cache clean --force` frees 2-3 GB.
- **Typechecks take 8-10 minutes.** Use `./node_modules/.bin/tsc --noEmit`
  rather than `npx tsc`. Run it to completion *before* deploying — using
  Vercel's remote build as a typechecker emails the user on every failure.
- **The Supabase SQL editor has a confirmation dialog that swallows queries.**
  Anything with `drop`, `alter` or `revoke` in it pops "Potential issue
  detected" and *waits*. Clicking Run and walking away leaves the SQL unrun
  while everything downstream reports success — twice this session a migration
  looked applied and was not, and the symptom appeared minutes later as a
  missing table. Always screenshot after clicking Run, and verify the change by
  querying for it rather than by reading the banner.
- **Adding a route needs `npx next typegen`.** `PageProps<"/games/[sport]">`
  fails to typecheck until the generated route types are rebuilt, and the error
  ("does not satisfy the constraint 'AppRoutes'") reads like a bad path rather
  than a stale build.
- **The shell's working directory drifts to the parent folder.** It happens
  without a `cd`, and the parent is Core Control — so `npm test` fails to find
  `data/snapshot.json` and reports the snapshot tests as broken, and
  `vercel env ls` reports the wrong project. Two "failures" this session were
  only this. Prefix commands with `cd` to the project when anything looks
  inexplicably wrong.
- **The clipboard is shared.** Migrations are applied by pasting into the
  Supabase SQL editor via the Chrome extension; the user copying anything
  mid-flow clobbers it. Always screenshot and verify the editor contents
  before clicking Run.
- **`npm run dev` is not a usable way to look at this app here.** Two attempts:
  "Ready in 5.7min", then no page served in the ten minutes after that. `eslint`
  died in the same session with `ETIMEDOUT` reading a file out of
  `node_modules`, which is a disk fault dressed as a lint error, so the disk
  note above is doing more damage than it looks. **Verify on a Vercel preview
  instead** — `vercel deploy` builds in ~30s, talks to the same Supabase
  project, and is not deployment-protected, so the browser can drive it. That is
  not the same as using the remote build as a typechecker: typecheck locally
  first, then deploy a preview to *look* at it.
- **A four-league ingest takes ~18 minutes on this machine**, against the ~340s
  the code comments assume. Budget for that; it is disk, not the feeds (zero
  feed errors across all four leagues in that run).

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
vercel deploy                # preview build, for looking at a change (see above)
vercel deploy --prod         # then re-point both aliases, see below
vercel alias set <deployment-url> athlete-exchange-live.vercel.app
vercel alias set <deployment-url> athlete-exchange-six.vercel.app
```

Aliases attach to a specific deployment, so **every deploy needs the aliases
re-pointed** or the live URL keeps serving the old build. There are **two** to
move: `athlete-exchange-live` and `athlete-exchange-six`. A production deploy
re-points `-six` and the project's own
`athlete-exchange-lukeflewwelling-3409s-projects` alias by itself, but never
`-live`, which is the one people use. Confirm with `vercel alias ls`.

A bot slot can be run on demand for testing:
`curl -H "Authorization: Bearer $CRON_SECRET" "<site>/api/cron/bots?slot=N"` —
slot indexes run 0-89 over `SLOT_TIMES`, and a run spreads ~10 orders across
~240s, so watching one is a four-minute job, not an instant one.
