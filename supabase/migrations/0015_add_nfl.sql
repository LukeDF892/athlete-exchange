-- Let football onto the board.
--
-- `players.sport` carries a check constraint listing the leagues by name, so a
-- new league is a schema change rather than just an ingest change. Adding the
-- NFL without this fails every football row at push time and leaves the board
-- silently three-quarters full.
--
-- Widened rather than dropped: the constraint is what stops a typo in a
-- provider ("nlf") quietly creating a fourth league nobody can filter to.

alter table public.players
  drop constraint if exists players_sport_check;

alter table public.players
  add constraint players_sport_check
  check (sport in ('nba', 'nhl', 'mlb', 'nfl'));

-- `news` carries its own copy of the same constraint, which the first attempt
-- missed: players pushed cleanly and then the news insert failed on an NFL
-- story. Any future league needs both widened, not just players.
alter table public.news
  drop constraint if exists news_sport_check;

alter table public.news
  add constraint news_sport_check
  check (sport is null or sport in ('nba', 'nhl', 'mlb', 'nfl'));
