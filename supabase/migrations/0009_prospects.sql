-- Patch 0009: drafted prospects as listings.
--
-- 0007 constrained players.kind to ('athlete','team'). Prospects are a third
-- kind — someone drafted but not yet playing professionally — so every prospect
-- row was rejected on insert until this widens the check.
--
-- draft holds where they were taken, which is what sets their opening price:
-- there is no professional production to measure, so the pooled judgement of
-- thirty scouting departments is the best signal available.
--
-- Safe to re-run.

alter table public.players drop constraint if exists players_kind_check;
alter table public.players
  add constraint players_kind_check check (kind in ('athlete', 'team', 'prospect'));

alter table public.players
  add column if not exists draft jsonb;

comment on column public.players.draft is
  'For prospects: {year,round,overallPick,amateurClub,amateurLeague}. Null for everyone else.';
