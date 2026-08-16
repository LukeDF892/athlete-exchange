-- Patch 0003: store each athlete's season-by-season career value.
--
-- A newly listed athlete has no trading history, but they always have a
-- career. This column holds what every season they played would have been
-- worth on this exchange, so the player page has something real to show from
-- day one instead of a flat line.
--
-- Safe to re-run.

alter table public.players
  add column if not exists career_value jsonb not null default '[]'::jsonb;

comment on column public.players.career_value is
  'Array of {year,label,teamAbbrev,value,gamesPlayed,summary}, oldest season first.';
