-- Patch 0007: teams as tradeable listings.
--
-- A team trades exactly like an athlete — same bonding curve, same holdings,
-- same execute_trade() — so it lives in the same table rather than a parallel
-- one. Two columns carry the difference: what kind of listing it is, and, for a
-- team, which athletes the index tracks.
--
-- external_id is already unique, and team ids are namespaced "team:nba:LAL",
-- so nothing can collide with a real athlete.
--
-- Safe to re-run.

alter table public.players
  add column if not exists kind text not null default 'athlete'
    check (kind in ('athlete', 'team'));

alter table public.players
  add column if not exists components jsonb not null default '[]'::jsonb;

comment on column public.players.kind is
  'athlete = a real person; team = a value-weighted index of that roster.';
comment on column public.players.components is
  'For team listings: [{playerId,fullName,position,fairValue,weightPct,injured}] heaviest first.';

-- Injury state, so a price drop can explain itself in the UI rather than
-- looking like an unexplained markdown.
alter table public.players
  add column if not exists injury jsonb;
alter table public.players
  add column if not exists healthy_fair_value numeric(12,2);

comment on column public.players.injury is
  'Current injury {status,summary,returnDate,daysOut,multiplier}, or null if available.';
comment on column public.players.healthy_fair_value is
  'Fair value before the injury discount, so the markdown is showable.';

create index if not exists players_kind_idx on public.players(kind);
