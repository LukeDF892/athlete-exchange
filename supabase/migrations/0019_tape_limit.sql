-- Let a listing's own tape show that listing's own trades.
--
-- 0016 built `trade_tape` with `limit 200` inside the view. That reads as a
-- sensible guard until you notice where the limit lands: the view is filtered
-- *after* it is evaluated, so `where player_id = ...` can only ever search
-- within the most recent 200 trades market-wide. With thirty bots trading every
-- ten minutes that window is a few hours, and a listing traded this morning
-- showed "Nobody has traded this listing yet" underneath a price that had
-- visibly moved. Measured before this migration: 1,700 trades in the table, 200
-- reachable through the view, and one listing with 47 trades of which 8 were
-- visible.
--
-- The limit also never belonged to the view. Both callers already pass their
-- own (`getTradeTape` 12, `getPlayerTape` 20), PostgREST caps any response at
-- 1,000 rows regardless, and the ordering the callers apply is what decides
-- which rows they get. So the cap comes out and the callers keep deciding.
--
-- Everything else is unchanged and deliberate: still security_invoker = false
-- so it reads across all trades while `trades` stays self-access only, still
-- publishing what was traded and how much of it but never the cash.

drop view if exists public.trade_tape;

create view public.trade_tape
with (security_invoker = false) as
  select
    t.id,
    t.created_at,
    t.side,
    t.shares,
    p.username,
    pl.id           as player_id,
    pl.full_name    as player_name,
    pl.sport,
    pl.team_abbrev
  from public.trades t
  join public.profiles p on p.id = t.user_id
  join public.players  pl on pl.id = t.player_id
  order by t.created_at desc;

grant select on public.trade_tape to anon, authenticated;
