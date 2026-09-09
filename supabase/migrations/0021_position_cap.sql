-- Lower the per-account position limit from 20% of depth to 8%.
--
-- The cap exists so no single trader can set a price: at 20% one account moves
-- a listing by at most about 22%, whatever the athlete costs. That was sized
-- for three traders, and it is a *per-account* cap, so it says nothing about
-- what a crowd can do — twenty people each taking their full 20% is S = 4L, and
-- price(S) = fairValue x e^(S/L) makes that about a 54x repricing. With twenty
-- or more players in a competition, one organic pile-in on a recognisable name
-- would have detached that listing for good.
--
-- At 8%, twenty maxed accounts reach S = 1.6L, roughly 5x. Still a large move,
-- and it should be: a crowd agreeing is what a market is for. What it no longer
-- does is run away.
--
-- The whole function is restated because that is the only way to change a
-- constant inside it. This is the definition from 0017 with one number altered
-- and nothing else touched — the fee, the rounding, the collateral maths and
-- the no-crossing-zero rule are byte-for-byte identical. MAX_POSITION_SHARE in
-- lib/pricing/engine.ts is the matching half and changes with it.

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
  v_max_share  constant numeric := 0.08;
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
