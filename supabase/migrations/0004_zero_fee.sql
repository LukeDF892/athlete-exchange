-- Patch 0004: set the trading fee to zero.
--
-- The fee was never what kept the curve honest. Buying n shares costs the area
-- under the bonding curve from S to S+n, and selling them back returns the area
-- from S to S+n — the same integral — so an instant round trip is exactly
-- break-even at any size with no fee at all. The fee was only friction.
--
-- v_fee_rate here must always match TRADE_FEE_RATE in lib/pricing/engine.ts, or
-- the browser quotes a number this function will not honour. The fee columns on
-- public.trades are kept so switching a fee back on later needs no schema change.
--
-- Safe to re-run; replaces the function in place.

create or replace function public.execute_trade(
  p_player_id uuid,
  p_side      text,
  p_shares    numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user      uuid := auth.uid();
  v_player    public.players%rowtype;
  v_fee_rate  constant numeric := 0;
  v_cash      numeric;
  v_held      numeric := 0;
  v_avg_cost  numeric := 0;
  v_after     numeric;
  v_gross     numeric;
  v_fee       numeric;
  v_net       numeric;
  v_avg_price numeric;
  v_new_price numeric;
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

  select cash_balance into v_cash from public.profiles where id = v_user for update;
  if v_cash is null then
    raise exception 'no profile for this user';
  end if;

  select shares, avg_cost into v_held, v_avg_cost
    from public.holdings where user_id = v_user and player_id = p_player_id for update;
  v_held := coalesce(v_held, 0);
  v_avg_cost := coalesce(v_avg_cost, 0);

  if p_side = 'buy' then
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
          -- Weighted average cost across the combined position.
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

    -- Rounding order matters and must match the buy branch (and quoteSell in
    -- TypeScript): fee comes off the *exact* curve area, then gross is rounded.
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
$$;

revoke all on function public.execute_trade(uuid, text, numeric) from public;
grant execute on function public.execute_trade(uuid, text, numeric) to authenticated;
