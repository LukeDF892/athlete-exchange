# Athlete Exchange

A stock market for athletes. Every NBA and NHL player is listed at a price derived
from their real career production; from there the market takes over.

```bash
npm install
npm run ingest     # pulls live rosters, stats and news — takes ~20s
npm run dev
```

Open http://localhost:3000. The market, player pages, stats and news all work
immediately with no database and no API keys.

---

## How pricing works

Two numbers drive every athlete.

**Performance value** (the fundamentals line) comes only from what a player does
on the ice or court. Three stat windows — last five games, this season, and
career — are scored, regressed for sample size, blended, and run through an age
curve. It moves when a player plays, never when someone trades.

**Market price** rides a bonding curve anchored to that value:

```
price(S) = performanceValue × e^(S / L)
```

where `S` is net shares outstanding and `L` is liquidity depth. At launch `S = 0`,
so **market price opens exactly at performance value** — that is the answer to
"where does the starting price come from?" Performance sets the opening bell and
the crowd takes it from there.

Because the curve integrates in closed form, buying `n` shares costs exactly the
area underneath it. That has three consequences worth knowing:

- There is **always a counterparty**. The market works with three users or three
  thousand — no order book to go illiquid.
- **Slippage is real.** Large orders fill at a worse average price than the quoted
  spot price, exactly as they would on a real exchange.
- **You cannot round-trip for free.** Buying and immediately selling returns you to
  the same price and costs you the 0.5% fee, twice.

Two design decisions that are easy to get wrong, and are deliberate here:

- **Liquidity depth is frozen at listing.** If depth were recomputed from live
  performance value, a hot streak would reshape the curve underneath existing
  holders and silently revalue the premium they paid for — a price change caused
  by nobody trading.
- **Small samples regress to replacement level.** A one-game debut with 12 points
  produces an MVP-grade efficiency rating. Without regression, that call-up prices
  above Jokić. `shrinkToReplacement` pulls thin samples toward a fringe-roster
  baseline, so a rate has to be *sustained* to be worth anything.

All of this is unit-tested in `tests/pricing.test.ts` (21 tests, `npm test`),
including the "no free profit" invariant.

## Where the data comes from

| League | Source | Notes |
| --- | --- | --- |
| NHL | `api-web.nhle.com` (official) | No key, no quota. Season, career and last-5 games in one call. |
| NBA | `sports.core.api.espn.com` | Unofficial but open, and carries PER/VORP/usage. |
| News | ESPN, CBS, Yahoo RSS | Deduplicated, tagged to players by full-name match. |

The NBA has no open official feed — `stats.nba.com` and `cdn.nba.com` both refuse
datacenter IPs, and balldontlie now requires a key. **Everything sits behind the
`SportsProvider` interface in `lib/providers/types.ts`**, so moving to a paid feed
later means writing one class, not rewriting the app.

Two known limits of the free tier, both handled rather than hidden:

- NBA has no cheap per-game log, so short-term form falls back to the season line.
  `fairValue` renormalizes its weights when a window is missing, so this degrades
  cleanly instead of skewing prices.
- NBA "career" is a trailing multi-season aggregate, not lifetime totals. It is
  labeled **Recent career** in the UI rather than being passed off as career stats.

## Adding accounts, trading and multi-device sync

The market is fully browsable without a database. Accounts and live trading need
one, because every trader needs an identity and every trade needs somewhere to live.

1. Create a free project at [supabase.com](https://supabase.com).
2. In the SQL editor, run the migrations in `supabase/migrations/` in order
   (`0001_init.sql`, then `0002_fix_sell_rounding.sql`). Paste the file contents
   into a new query — the editor runs SQL, not shell commands.
3. `cp .env.local.example .env.local` and fill in the URL plus the publishable
   and secret keys from **Project Settings → API Keys**. (The legacy `anon` /
   `service_role` JWTs work too — they are the same two permissions under the
   older naming.)
4. **Authentication → Sign In / Providers → Email → turn off "Confirm email".**
   Otherwise signup appears to succeed but sign-in fails while you wait on a
   confirmation email that the free tier rate-limits to a few per hour.
5. `npm run ingest -- --push` to load the market into Postgres.
6. `npm run dev` — the portfolio and trade buttons come alive.
7. `npm run verify:trading` to prove the whole path works against your database.

### Node 20

`npm run ingest` and `npm run verify:trading` pass `--experimental-websocket`,
because supabase-js builds a realtime client on construction and Node 20 has no
global `WebSocket`. On Node 22+ the flag is harmless. Both scripts load
`.env.local` through `@next/env`, since they run outside the Next runtime.

### The security model

The browser is never trusted with a price. Clients can read the market and their
own rows, and nothing else. Every trade goes through `execute_trade()`, a
`SECURITY DEFINER` function that recomputes the bonding-curve cost from
server-held state inside one transaction. A user cannot forge a price, spend cash
they do not have, sell shares they do not own, or race themselves into a negative
balance. Row-level security is on for every table.

Player and price rows are written only by the service-role key, which lives in
`SUPABASE_SERVICE_ROLE_KEY` and must never reach the browser.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run ingest` | Rebuild `data/snapshot.json` from live feeds |
| `npm run ingest -- --push` | Also upsert into Supabase |
| `npm test` | Pricing engine tests (no database needed) |
| `npm run verify:trading` | End-to-end trade check against the real database |
| `npm run typecheck` | `tsc --noEmit` |

`verify:trading` creates a disposable user, buys, sells, asserts the guard rails
and RLS isolation hold, then deletes the user — leaving the market as it found
it. It exists because the unit tests cover the pricing maths in TypeScript but
cannot reach the copy of that maths living in `execute_trade()`. The two must
round identically, or the order ticket quotes a number the trade will not
honour; that divergence has happened once already.

Re-running ingest never clobbers the market: `shares_outstanding`,
`opening_fair_value` and `liquidity_depth` are preserved for players that already
exist, so refreshed stats move prices without wiping out anyone's positions.

## Adding another sport

1. Implement `SportsProvider` for the league.
2. Add the sport to the `Sport` union and to the `sport` check constraint in SQL.
3. Add a scoring branch in `productionScore`.

The UI, pricing, trading and news layers are all sport-agnostic already.
