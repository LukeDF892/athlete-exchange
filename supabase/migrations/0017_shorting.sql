-- Selling short.
--
-- The pricing curve needed no changes at all. `price(S) = fairValue × e^(S/L)`
-- is well defined for negative `S` — it approaches zero without reaching it —
-- and `curve_area()` between any two points is the same integral whichever
-- direction you travel. So opening a short is selling from S down to S-n, and
-- covering is buying from S-n back to S, for exactly the same money. A short
-- round trip is break-even for the same reason a long one is.
--
-- What genuinely changes is the bookkeeping, and one number in particular:
-- a short position loses money as the price *rises*, and on an exponential
-- curve that loss grows without a natural ceiling. In real markets that is
-- solved with margin, and it has to be solved here too, because play money has
-- no mechanism for "you owe me". So:
--
--   * opening a short credits the proceeds to cash **and locks 1.5× them** as
--     collateral, which is why shorting costs buying power rather than
--     creating it
--   * covering releases collateral in proportion to the shares bought back
--   * `margin_call()` force-covers any position whose cover cost has grown past
--     its collateral, and the daily cron runs it
--
-- A deliberate simplification: an order may not cross zero. If you are short 50
-- and buy 80, it is rejected rather than covering and going long in one step.
-- That keeps a single trade to a single meaning, and the alternative doubles
-- the number of paths through the most safety-critical function in the app for
-- almost no user benefit.

-- Negative holdings are the whole point, so the non-negative check must go.
alter table public.holdings drop constraint if exists holdings_shares_check;

-- Cash locked against a short. Carried per position so covering part of one
-- releases the right fraction rather than an estimate.
alter table public.holdings
  add column if not exists collateral numeric(16,2) not null default 0;

comment on column public.holdings.collateral is
  'Cash locked against a short position. Zero for longs.';

/**
 * Buying power: cash that is not already backing a short.
 */
create or replace function public.available_cash(p_user uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select cash_balance from public.profiles where id = p_user), 0)
       - coalesce((select sum(collateral) from public.holdings where user_id = p_user), 0);
$$;

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
  v_user       uuid := auth.uid();
  v_player     public.players%rowtype;
  v_fee_rate   constant numeric := 0;
  v_max_share  constant numeric := 0.20;
  -- 150%: enough that a position must move half again against you before the
  -- margin call, without making shorting so expensive nobody tries it.
  v_margin     constant numeric := 1.5;
  v_cash       numeric;
  v_locked     numeric;
  v_held       numeric := 0;
  v_avg_cost   numeric := 0;
  v_collateral numeric := 0;
  v_after      numeric;
  v_gross      numeric;
  v_fee        numeric;
  v_net        numeric;
  v_avg_price  numeric;
  v_new_price  numeric;
  v_cap        numeric;
  v_release    numeric;
  v_action     text;
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

  if v_player.status = 'settled' then
    raise exception '% has retired and settled at %', v_player.full_name, v_player.settlement_price
      using errcode = 'P0001';
  end if;

  select cash_balance into v_cash from public.profiles where id = v_user for update;
  if v_cash is null then
    raise exception 'no profile for this user';
  end if;

  select shares, avg_cost, collateral into v_held, v_avg_cost, v_collateral
    from public.holdings where user_id = v_user and player_id = p_player_id for update;
  v_held := coalesce(v_held, 0);
  v_avg_cost := coalesce(v_avg_cost, 0);
  v_collateral := coalesce(v_collateral, 0);

  select coalesce(sum(collateral), 0) into v_locked
    from public.holdings where user_id = v_user;

  v_cap := floor(v_player.liquidity_depth * v_max_share);

  -- -------------------------------------------------------------------------
  if p_side = 'buy' then
    if v_held < 0 then
      ------------------------------------------------------------------ cover
      if p_shares > abs(v_held) then
        raise exception 'you are short % shares; cover that many or fewer', abs(v_held)
          using errcode = 'P0001';
      end if;
      v_action := 'cover';

      v_after := v_player.shares_outstanding + p_shares;
      v_gross := public.curve_area(
        v_player.fair_value, v_player.shares_outstanding, v_after, v_player.liquidity_depth
      );
      v_fee := round(v_gross * v_fee_rate, 2);
      v_gross := round(v_gross, 2);
      v_net := v_gross + v_fee;

      -- Collateral released in proportion to what is being bought back.
      v_release := round(v_collateral * (p_shares / abs(v_held)), 2);

      if v_net > v_cash - v_locked + v_release then
        raise exception 'insufficient funds to cover: need %, have %',
          v_net, v_cash - v_locked + v_release using errcode = 'P0001';
      end if;

      update public.profiles set cash_balance = cash_balance - v_net where id = v_user;

      if v_held + p_shares = 0 then
        delete from public.holdings where user_id = v_user and player_id = p_player_id;
      else
        update public.holdings
           set shares = shares + p_shares,
               collateral = greatest(0, collateral - v_release),
               updated_at = now()
         where user_id = v_user and player_id = p_player_id;
      end if;
    else
      ------------------------------------------------------------------- long
      v_action := 'buy';
      if v_held + p_shares > v_cap then
        raise exception 'position limit: you may hold at most % shares of %, and already hold %',
          v_cap, v_player.full_name, v_held using errcode = 'P0001';
      end if;

      v_after := v_player.shares_outstanding + p_shares;
      v_gross := public.curve_area(
        v_player.fair_value, v_player.shares_outstanding, v_after, v_player.liquidity_depth
      );
      v_fee := round(v_gross * v_fee_rate, 2);
      v_gross := round(v_gross, 2);
      v_net := v_gross + v_fee;

      if v_net > v_cash - v_locked then
        raise exception 'insufficient funds: need %, have %', v_net, v_cash - v_locked
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
    end if;
  -- -------------------------------------------------------------------------
  else
    if v_held > 0 then
      ------------------------------------------------------------- sell long
      if p_shares > v_held then
        raise exception 'you only hold % shares; sell that many or fewer, or close and short',
          v_held using errcode = 'P0001';
      end if;
      v_action := 'sell';

      v_after := v_player.shares_outstanding - p_shares;
      v_gross := round(public.curve_area(
        v_player.fair_value, v_after, v_player.shares_outstanding, v_player.liquidity_depth
      ), 2);
      v_fee := round(v_gross * v_fee_rate, 2);
      v_net := v_gross - v_fee;

      update public.profiles set cash_balance = cash_balance + v_net where id = v_user;

      if v_held - p_shares = 0 then
        delete from public.holdings where user_id = v_user and player_id = p_player_id;
      else
        update public.holdings
           set shares = shares - p_shares, updated_at = now()
         where user_id = v_user and player_id = p_player_id;
      end if;
    else
      ------------------------------------------------------------ open short
      v_action := 'short';
      if abs(v_held) + p_shares > v_cap then
        raise exception 'position limit: you may be short at most % shares of %, and already are % short',
          v_cap, v_player.full_name, abs(v_held) using errcode = 'P0001';
      end if;

      v_after := v_player.shares_outstanding - p_shares;
      v_gross := round(public.curve_area(
        v_player.fair_value, v_after, v_player.shares_outstanding, v_player.liquidity_depth
      ), 2);
      v_fee := round(v_gross * v_fee_rate, 2);
      v_net := v_gross - v_fee;

      -- Proceeds land in cash, but 1.5x them is locked, so a short costs half
      -- its own size in buying power rather than handing you free money.
      if round(v_net * v_margin, 2) - v_net > v_cash - v_locked then
        raise exception 'not enough collateral to short: need % free, have %',
          round(v_net * v_margin, 2) - v_net, v_cash - v_locked using errcode = 'P0001';
      end if;

      update public.profiles set cash_balance = cash_balance + v_net where id = v_user;

      insert into public.holdings (user_id, player_id, shares, avg_cost, collateral, updated_at)
      values (v_user, p_player_id, -p_shares, v_gross / p_shares, round(v_net * v_margin, 2), now())
      on conflict (user_id, player_id) do update
        set shares = public.holdings.shares - p_shares,
            avg_cost = ((abs(public.holdings.shares) * public.holdings.avg_cost) + v_gross)
                       / (abs(public.holdings.shares) + p_shares),
            collateral = public.holdings.collateral + round(v_net * v_margin, 2),
            updated_at = now();
    end if;
  end if;

  v_avg_price := round(v_gross / p_shares, 4);
  v_new_price := round(v_player.fair_value * exp(v_after / v_player.liquidity_depth), 2);

  update public.players
     set shares_outstanding = v_after,
         market_price = v_new_price,
         updated_at = now()
   where id = p_player_id;

  insert into public.trades (user_id, player_id, side, shares, avg_price, gross, fee, net)
  values (v_user, p_player_id, p_side, p_shares, v_avg_price, v_gross, v_fee, v_net);

  insert into public.price_ticks (player_id, market_price, fair_value, shares_outstanding)
  values (p_player_id, v_new_price, v_player.fair_value, v_after);

  return jsonb_build_object(
    'side', p_side,
    'action', v_action,
    'shares', p_shares,
    'avgPrice', v_avg_price,
    'net', v_net,
    'priceAfter', v_new_price
  );
end;
$fn$;

/**
 * Force-close shorts whose collateral no longer covers them.
 *
 * Without this a losing short simply keeps losing, and because play money has
 * no debt there is nothing to settle against — a trader would end up with a
 * position they can never buy back. Run from the daily cron, before the bots.
 *
 * Deliberately not run inside execute_trade: a margin call is something the
 * house does to you, not a side effect of somebody else's order.
 */
create or replace function public.margin_call()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r          record;
  v_cost     numeric;
  v_closed   integer := 0;
begin
  for r in
    select h.user_id, h.player_id, h.shares, h.collateral,
           p.fair_value, p.shares_outstanding, p.liquidity_depth
      from public.holdings h
      join public.players p on p.id = h.player_id
     where h.shares < 0
  loop
    v_cost := round(public.curve_area(
      r.fair_value, r.shares_outstanding, r.shares_outstanding + abs(r.shares), r.liquidity_depth
    ), 2);

    if v_cost > r.collateral then
      update public.profiles set cash_balance = cash_balance - v_cost where id = r.user_id;
      update public.players
         set shares_outstanding = shares_outstanding + abs(r.shares),
             market_price = round(r.fair_value * exp((r.shares_outstanding + abs(r.shares)) / r.liquidity_depth), 2),
             updated_at = now()
       where id = r.player_id;

      insert into public.trades (user_id, player_id, side, shares, avg_price, gross, fee, net)
      values (r.user_id, r.player_id, 'buy', abs(r.shares),
              round(v_cost / abs(r.shares), 4), v_cost, 0, v_cost);

      delete from public.holdings where user_id = r.user_id and player_id = r.player_id;
      v_closed := v_closed + 1;
    end if;
  end loop;

  return v_closed;
end;
$$;

revoke all on function public.margin_call() from public;
