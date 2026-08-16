-- Patch 0011: retirement — announcement, countdown, then cash settlement.
--
-- The design you picked, and the reasoning behind the settlement price:
--
-- Letting a retiring athlete decay to zero would be a race to the exit. The
-- moment retirement looks likely everyone sells, and because the bonding curve
-- pays earlier sellers more, the last holder is left with the least. That
-- punishes exactly the people who bought someone they believed in and held.
--
-- The curve does bound the damage — as shares sell back toward zero the price
-- converges on fair value, not on nothing — but the ordering still rewards
-- whoever panics first. So settlement pays the BETTER of:
--
--   * the average market price across the countdown window, and
--   * fair value at settlement
--
-- Averaging removes the advantage of dumping early, and the fair-value floor
-- means a coordinated sell-off cannot rob the holders who stayed. Neither
-- number is invented: both are things the market actually did.
--
-- Safe to re-run.

alter table public.players
  add column if not exists status text not null default 'active'
    check (status in ('active', 'retiring', 'settled'));

alter table public.players
  add column if not exists retirement_announced_at timestamptz;
alter table public.players
  add column if not exists settles_at timestamptz;
alter table public.players
  add column if not exists settlement_price numeric(12,2);

comment on column public.players.status is
  'active = trading normally; retiring = countdown running; settled = bought back, no longer tradeable.';
comment on column public.players.settles_at is
  'When the countdown ends and holdings are converted to cash.';

create index if not exists players_status_idx on public.players(status);

-- ---------------------------------------------------------------------------
-- Announce
-- ---------------------------------------------------------------------------

/**
 * Start the countdown on an athlete.
 *
 * Announcing does not stop trading — that is the point of a wind-down. People
 * can still buy and sell during the window, and the average price over it is
 * what the settlement pays.
 */
create or replace function public.announce_retirement(
  p_player_id uuid,
  p_days      integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_player public.players%rowtype;
begin
  if not public.is_admin() then
    raise exception 'only an operator may announce a retirement' using errcode = '42501';
  end if;

  select * into v_player from public.players where id = p_player_id for update;
  if not found then
    raise exception 'player not found';
  end if;
  if v_player.status <> 'active' then
    raise exception '% is already %', v_player.full_name, v_player.status;
  end if;

  update public.players
     set status = 'retiring',
         retirement_announced_at = now(),
         settles_at = now() + make_interval(days => greatest(p_days, 1)),
         updated_at = now()
   where id = p_player_id;

  return jsonb_build_object(
    'player', v_player.full_name,
    'settlesAt', now() + make_interval(days => greatest(p_days, 1))
  );
end;
$fn$;

revoke all on function public.announce_retirement(uuid, integer) from public;
grant execute on function public.announce_retirement(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Settle
-- ---------------------------------------------------------------------------

/**
 * Buy back every share at the settlement price and close the listing.
 *
 * Runs as one transaction: either every holder is paid and the listing closes,
 * or nothing happens. A half-settled athlete would leave some people holding
 * shares in something that no longer trades.
 */
create or replace function public.settle_retirement(p_player_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_player  public.players%rowtype;
  v_twap    numeric;
  v_price   numeric;
  v_holders integer := 0;
  v_shares  numeric := 0;
  v_paid    numeric := 0;
  r         record;
begin
  if not public.is_admin() then
    raise exception 'only an operator may settle a retirement' using errcode = '42501';
  end if;

  select * into v_player from public.players where id = p_player_id for update;
  if not found then
    raise exception 'player not found';
  end if;
  if v_player.status <> 'retiring' then
    raise exception '% is %, not retiring', v_player.full_name, v_player.status;
  end if;

  -- Average traded price across the countdown, which is what removes the
  -- advantage of selling first.
  select avg(market_price) into v_twap
    from public.price_ticks
   where player_id = p_player_id
     and ts >= v_player.retirement_announced_at;

  -- The better of the average and fair value, so a sell-off cannot rob holders.
  v_price := round(greatest(coalesce(v_twap, v_player.fair_value), v_player.fair_value), 2);

  for r in
    select user_id, shares from public.holdings
     where player_id = p_player_id and shares > 0
     for update
  loop
    update public.profiles
       set cash_balance = cash_balance + round(r.shares * v_price, 2)
     where id = r.user_id;

    insert into public.trades
      (user_id, player_id, side, shares, avg_price, gross, fee, net, created_at)
    values
      (r.user_id, p_player_id, 'sell', r.shares, v_price,
       round(r.shares * v_price, 2), 0, round(r.shares * v_price, 2), now());

    v_holders := v_holders + 1;
    v_shares := v_shares + r.shares;
    v_paid := v_paid + round(r.shares * v_price, 2);
  end loop;

  delete from public.holdings where player_id = p_player_id;

  update public.players
     set status = 'settled',
         settlement_price = v_price,
         shares_outstanding = 0,
         market_price = v_price,
         updated_at = now()
   where id = p_player_id;

  return jsonb_build_object(
    'player', v_player.full_name,
    'settlementPrice', v_price,
    'holders', v_holders,
    'shares', v_shares,
    'paidOut', v_paid
  );
end;
$fn$;

revoke all on function public.settle_retirement(uuid) from public;
grant execute on function public.settle_retirement(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Block trading in a settled listing
-- ---------------------------------------------------------------------------
-- execute_trade gains one guard. Everything else about it is unchanged.

create or replace function public.execute_trade(
  p_player_id uuid,
  p_side      text,
  p_shares    numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user      uuid := auth.uid();
  v_player    public.players%rowtype;
  v_fee_rate  constant numeric := 0;
  v_max_share constant numeric := 0.20;
  v_cash      numeric;
  v_held      numeric := 0;
  v_avg_cost  numeric := 0;
  v_after     numeric;
  v_gross     numeric;
  v_fee       numeric;
  v_net       numeric;
  v_avg_price numeric;
  v_new_price numeric;
  v_cap       numeric;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if p_side not in ('buy', 'sell') then
    raise exception 'side must be buy or sell';
  end if;

  if p_shares is null or p_shares <= 0 or p_shares <> floor(p_shares) then
    raise exception 'shares must be a positive whole number';
  end if;

  select * into v_player from public.players where id = p_player_id for update;
  if not found then
    raise exception 'player not found';
  end if;

  -- Settled listings have already been bought back; there is nothing to trade.
  -- A retiring one still trades, which is the whole point of a countdown.
  if v_player.status = 'settled' then
    raise exception '% has retired and settled at %', v_player.full_name, v_player.settlement_price
      using errcode = 'P0001';
  end if;

  select cash_balance into v_cash from public.profiles where id = v_user for update;
  if v_cash is null then
    raise exception 'no profile for this user';
  end if;

  select shares, avg_cost into v_held, v_avg_cost
    from public.holdings where user_id = v_user and player_id = p_player_id for update;
  v_held := coalesce(v_held, 0);
  v_avg_cost := coalesce(v_avg_cost, 0);

  if p_side = 'buy' then
    v_cap := floor(v_player.liquidity_depth * v_max_share);
    if v_held + p_shares > v_cap then
      raise exception 'position limit: you may hold at most % shares of %, and already hold %',
        v_cap, v_player.full_name, v_held
        using errcode = 'P0001';
    end if;

    v_after := v_player.shares_outstanding + p_shares;
    v_gross := public.curve_area(
      v_player.fair_value, v_player.shares_outstanding, v_after, v_player.liquidity_depth
    );
    v_fee := round(v_gross * v_fee_rate, 2);
    v_gross := round(v_gross, 2);
    v_net := v_gross + v_fee;

    if v_net > v_cash then
      raise exception 'insufficient funds: need %, have %', v_net, v_cash
        using errcode = 'P0001';
    end if;

    update public.profiles set cash_balance = cash_balance - v_net where id = v_user;

    insert into public.holdings (user_id, player_id, shares, avg_cost, updated_at)
    values (v_user, p_player_id, p_shares, v_gross / p_shares, now())
    on conflict (user_id, player_id) do update
      set shares = public.holdings.shares + excluded.shares,
          avg_cost = ((public.holdings.shares * public.holdings.avg_cost) + v_gross)
                     / (public.holdings.shares + excluded.shares),
          updated_at = now();
  else
    if p_shares > v_held then
      raise exception 'you only hold % shares', v_held using errcode = 'P0001';
    end if;
    v_after := v_player.shares_outstanding - p_shares;
    if v_after < 0 then
      raise exception 'trade would drive shares outstanding negative';
    end if;

    v_gross := public.curve_area(
      v_player.fair_value, v_after, v_player.shares_outstanding, v_player.liquidity_depth
    );
    v_fee := round(v_gross * v_fee_rate, 2);
    v_gross := round(v_gross, 2);
    v_net := v_gross - v_fee;

    update public.profiles set cash_balance = cash_balance + v_net where id = v_user;

    if v_held - p_shares <= 0 then
      delete from public.holdings where user_id = v_user and player_id = p_player_id;
    else
      update public.holdings
        set shares = shares - p_shares, updated_at = now()
        where user_id = v_user and player_id = p_player_id;
    end if;
  end if;

  v_avg_price := round(v_gross / p_shares, 4);
  v_new_price := round(v_player.fair_value * exp(v_after / v_player.liquidity_depth), 2);

  update public.players
     set shares_outstanding = v_after,
         market_price = v_new_price,
         updated_at = now()
   where id = p_player_id;

  insert into public.trades (user_id, player_id, side, shares, avg_price, gross, fee, net, created_at)
  values (v_user, p_player_id, p_side, p_shares, v_avg_price, v_gross, v_fee, v_net, now());

  insert into public.price_ticks (player_id, ts, market_price, fair_value, shares_outstanding)
  values (p_player_id, now(), v_new_price, v_player.fair_value, v_after);

  return jsonb_build_object(
    'side', p_side,
    'shares', p_shares,
    'avgPrice', v_avg_price,
    'gross', v_gross,
    'fee', v_fee,
    'net', v_net,
    'priceAfter', v_new_price
  );
end;
$fn$;

revoke all on function public.execute_trade(uuid, text, numeric) from public;
grant execute on function public.execute_trade(uuid, text, numeric) to authenticated;
