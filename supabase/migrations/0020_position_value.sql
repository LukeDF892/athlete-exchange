-- Value a position at what closing it would pay, everywhere.
--
-- `shares * market_price` was the mark in three places: the position panel, the
-- portfolio page, and here in SQL for the leaderboard and the recorded net
-- worth history. On a bonding curve it is the wrong number in all of them.
-- Spot is the price of the *next* share; selling walks back down the curve, so
-- a holding is worth the area under it — always less than the spot mark, and
-- short by exactly the price impact of the buy that created it.
--
-- The visible effect was a position showing a profit the instant it was opened,
-- with no trade, no game and no time passing. Measured on live rows: a fresh
-- 120-share buy read +0.84% on a round trip that returns precisely what it
-- cost, one position read +10.29% against a true 0.00%, and another read +7.06%
-- when selling it would have realised -2.97%. CLAUDE.md has always said an
-- instant round trip is break-even; the mark was the thing disagreeing.
--
-- Net worth changes when this ships, downward, most for whoever holds the
-- largest positions. That is the point — it was overstated before — but the
-- portfolio chart will show a step where the method changed, because the
-- snapshots behind it were recorded the old way and are left alone. Rewriting
-- history to match a new method would be worse: those rows are what the app
-- actually told people at the time.

-- ---------------------------------------------------------------------------
-- The mark, mirroring positionValue() in lib/pricing/engine.ts
-- ---------------------------------------------------------------------------
--
-- The pricing maths exists twice by necessity — TypeScript quotes, SQL
-- executes — so this is deliberately the same shape as the TS function and
-- built on the same curve_area() that execute_trade() pays out with. A long is
-- the proceeds of selling it; a short is what covering costs, carried negative
-- so net worth stays cash plus the sum of positions.
create or replace function public.position_value(
  fair numeric, s_out numeric, depth numeric, shares numeric
) returns numeric
language sql immutable
as $$
  select case
    when shares = 0 or fair is null or depth is null or depth <= 0 then 0
    when shares > 0 then round(public.curve_area(fair, s_out - shares, s_out, depth), 2)
    else -round(public.curve_area(fair, s_out, s_out - shares, depth), 2)
  end;
$$;

-- ---------------------------------------------------------------------------
-- Leaderboard
-- ---------------------------------------------------------------------------
-- Unchanged in every other respect: still security_invoker = false so it ranks
-- across all profiles while `profiles` stays self-access only, and still
-- revoked from anon (0013) because a stranger has agreed to no terms.
create or replace view public.leaderboard
with (security_invoker = false) as
  select
    p.id,
    p.username,
    p.cash_balance + coalesce(h.market_value, 0) as net_worth,
    coalesce(h.market_value, 0) as holdings_value,
    coalesce(h.position_count, 0) as position_count
  from public.profiles p
  left join (
    select h.user_id,
           sum(public.position_value(
             pl.fair_value, pl.shares_outstanding, pl.liquidity_depth, h.shares
           )) as market_value,
           count(*) as position_count
    from public.holdings h
    join public.players pl on pl.id = h.player_id
    group by h.user_id
  ) h on h.user_id = p.id;

grant select on public.leaderboard to authenticated;
revoke select on public.leaderboard from anon;

-- ---------------------------------------------------------------------------
-- Recorded net worth
-- ---------------------------------------------------------------------------
create or replace function public.snapshot_portfolios()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  insert into public.portfolio_snapshots (user_id, ts, cash, holdings_value, net_worth)
  select
    p.id,
    now(),
    p.cash_balance,
    coalesce(h.market_value, 0),
    p.cash_balance + coalesce(h.market_value, 0)
  from public.profiles p
  left join (
    select h.user_id,
           sum(public.position_value(
             pl.fair_value, pl.shares_outstanding, pl.liquidity_depth, h.shares
           )) as market_value
    from public.holdings h
    join public.players pl on pl.id = h.player_id
    group by h.user_id
  ) h on h.user_id = p.id
  on conflict (user_id, ts) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.snapshot_portfolios() from public;
revoke all on function public.snapshot_portfolios() from authenticated;
