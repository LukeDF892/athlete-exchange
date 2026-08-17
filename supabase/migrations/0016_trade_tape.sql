-- A public tape of what everyone is trading.
--
-- The market had a leaderboard but no sense of activity: you could see who was
-- ahead and never see anyone act. With twelve bots and a handful of friends,
-- that made a busy market feel empty.
--
-- What this exposes is deliberately narrower than the `trades` table. A trade
-- row carries `net` — the cash that changed hands — and publishing that lets
-- anyone reconstruct how much money another trader is moving around, which is
-- a step beyond the "username and net worth" that /terms promises. So the view
-- publishes **what** was traded and **how much of it**, never the money:
-- username, side, share count, and which listing.
--
-- security_invoker = false so it can read across all trades while the base
-- table stays self-access only — the same pattern as `leaderboard`. And like
-- leaderboard, that means RLS does not apply, so access is granted explicitly
-- below rather than assumed.

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
  order by t.created_at desc
  limit 200;

-- Readable by anyone, signed in or not. Unlike the leaderboard, nothing here
-- is personal: it is the market's own activity, which is exactly what a public
-- exchange publishes.
grant select on public.trade_tape to anon, authenticated;
