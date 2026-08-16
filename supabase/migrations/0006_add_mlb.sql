-- Patch 0006: allow MLB.
--
-- players.sport and news.sport are both constrained to ('nba','nhl'), so every
-- baseball row would be rejected on insert. Widening the check is all that is
-- needed — nothing else in the schema is sport-specific, because production
-- stats live in jsonb and pricing happens before anything is written.
--
-- Safe to re-run.

alter table public.players drop constraint if exists players_sport_check;
alter table public.players
  add constraint players_sport_check check (sport in ('nba', 'nhl', 'mlb'));

alter table public.news drop constraint if exists news_sport_check;
alter table public.news
  add constraint news_sport_check check (sport in ('nba', 'nhl', 'mlb'));
