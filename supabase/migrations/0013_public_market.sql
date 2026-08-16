-- Make the market itself public, and keep everything personal private.
--
-- Until now every read of `players` required a signed-in user, so a visitor who
-- had not made an account saw `data/snapshot.json` — a file baked into the
-- deployed bundle. That produced a genuinely confusing split: two people
-- looking at the same URL saw different boards, one live and one frozen at
-- whenever the last deploy happened. It also made the change columns, the
-- digest and every price chart silently empty for the public, because those
-- read `price_ticks`.
--
-- There was never a reason for the secrecy. These are made-up prices for public
-- athletes derived from published statistics; nothing about a listing is
-- sensitive, and the snapshot already published all of it to anyone who loaded
-- the homepage. The gate was an artefact of RLS being on by default, not a
-- decision.
--
-- So: the four market tables become readable by `anon` as well as
-- `authenticated`. Writes are untouched — every write still goes through the
-- service role or a SECURITY DEFINER function, and no write policy exists for
-- either role.
--
-- Deliberately NOT made public:
--   * profiles / leaderboard — usernames and net worth are visible to signed-in
--     traders only, which is what /terms promises
--   * holdings, trades, watchlist, portfolio_snapshots — one person's positions
--     and history are theirs
--
-- `to anon, authenticated` rather than `to public`: `public` would include any
-- future role, and being explicit is what makes this reviewable later.

drop policy if exists "players readable by authenticated" on public.players;
drop policy if exists "players are public" on public.players;
create policy "players are public"
  on public.players for select to anon, authenticated using (true);

drop policy if exists "ticks readable by authenticated" on public.price_ticks;
drop policy if exists "ticks are public" on public.price_ticks;
create policy "ticks are public"
  on public.price_ticks for select to anon, authenticated using (true);

drop policy if exists "news readable by authenticated" on public.news;
drop policy if exists "news is public" on public.news;
create policy "news is public"
  on public.news for select to anon, authenticated using (true);

drop policy if exists "news links readable by authenticated" on public.news_players;
drop policy if exists "news links are public" on public.news_players;
create policy "news links are public"
  on public.news_players for select to anon, authenticated using (true);

-- Close a leak that predates this migration.
--
-- The `leaderboard` view runs with security_invoker = false so it can rank
-- across all profiles while the profiles table stays self-access only. That is
-- deliberate — but it also means RLS never runs for it, and Supabase grants
-- SELECT on public-schema views to `anon` by default. The upshot was that
-- anyone at all could read every trader's username and net worth without an
-- account.
--
-- /terms tells people their username and net worth are visible to "other
-- users", which they agree to when they sign up. A stranger who has agreed to
-- nothing is outside that promise, so `anon` loses access and the leaderboard
-- becomes what the terms already said it was.
revoke select on public.leaderboard from anon;
