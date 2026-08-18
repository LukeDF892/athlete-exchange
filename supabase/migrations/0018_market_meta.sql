-- Somewhere to keep facts about the market as a whole, rather than about one
-- listing.
--
-- The immediate need is calibration. Pricing one athlete requires having
-- measured all of them: `fairValue()` scores production against the league's
-- own median and elite marks per position per window, and those marks are
-- computed at ingest from every player fetched. That was fine while pricing
-- only ever happened during a full ingest, and became the blocker the moment a
-- live game needed to reprice forty players without re-measuring five and a
-- half thousand.
--
-- So the ingest writes its calibration here and the live refresh reads it back.
-- Both paths then price against exactly the same yardstick, which matters more
-- than it sounds: two different calibrations would make the same player worth
-- two different amounts depending on which job touched them last, and the price
-- would jitter between them every ten minutes.
--
-- jsonb rather than columns because the shape belongs to the pricing engine
-- (window x position group x {median, elite}) and will change when a league or
-- a position group is added. A migration per position group would be absurd.

create table if not exists public.market_meta (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

-- Nobody but the service role has any business here. RLS with no policy denies
-- both roles by default, and the explicit revoke covers the grant Supabase
-- hands out on new tables in the public schema — the same trap that left the
-- leaderboard readable in 0013.
alter table public.market_meta enable row level security;
revoke all on public.market_meta from anon, authenticated;
