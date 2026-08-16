-- Athlete Exchange — initial schema
--
-- Security model in one paragraph: the browser is never trusted with a price.
-- Clients may read the market and their own rows, but every trade goes through
-- execute_trade(), a SECURITY DEFINER function that recomputes the bonding-curve
-- cost from server-held state inside a single transaction. A user cannot forge a
-- price, spend cash they do not have, sell shares they do not own, or race
-- themselves into a negative balance.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id            uuid primary key references auth.users on delete cascade,
  username      text not null unique check (char_length(username) between 3 and 20),
  cash_balance  numeric(16,2) not null default 100000.00 check (cash_balance >= 0),
  created_at    timestamptz not null default now()
);

comment on column public.profiles.cash_balance is
  'Fake money. Every account starts with $100,000.';

-- ---------------------------------------------------------------------------
-- Players (the listed securities)
-- ---------------------------------------------------------------------------

create table if not exists public.players (
  id                  uuid primary key default gen_random_uuid(),
  external_id         text not null unique,
  sport               text not null check (sport in ('nba','nhl')),
  full_name           text not null,
  first_name          text,
  last_name           text,
  position            text,
  jersey              text,
  team_abbrev         text,
  team_name           text,
  headshot_url        text,
  birth_date          date,
  age_years           numeric(4,1),
  is_goalie           boolean not null default false,

  -- The performance line.
  fair_value          numeric(12,2) not null check (fair_value > 0),
  -- Fair value at listing. Frozen: liquidity_depth derives from it and must not
  -- drift, or the curve would reshape under existing holders.
  opening_fair_value  numeric(12,2) not null check (opening_fair_value > 0),
  liquidity_depth     integer not null check (liquidity_depth > 0),

  -- The market line.
  shares_outstanding  numeric(16,4) not null default 0 check (shares_outstanding >= 0),
  market_price        numeric(12,2) not null check (market_price > 0),
  prev_close          numeric(12,2),

  stat_tables         jsonb not null default '[]'::jsonb,
  game_log            jsonb not null default '[]'::jsonb,
  updated_at          timestamptz not null default now(),
  created_at          timestamptz not null default now()
);

create index if not exists players_sport_idx on public.players (sport);
create index if not exists players_market_price_idx on public.players (market_price desc);
create index if not exists players_name_idx on public.players using gin (to_tsvector('simple', full_name));

-- ---------------------------------------------------------------------------
-- Price history — stores BOTH lines so the chart can show performance vs market
-- ---------------------------------------------------------------------------

create table if not exists public.price_ticks (
  id                 bigserial primary key,
  player_id          uuid not null references public.players on delete cascade,
  ts                 timestamptz not null default now(),
  market_price       numeric(12,2) not null,
  fair_value         numeric(12,2) not null,
  shares_outstanding numeric(16,4) not null
);

create index if not exists price_ticks_player_ts_idx on public.price_ticks (player_id, ts desc);

-- ---------------------------------------------------------------------------
-- Positions and trade history
-- ---------------------------------------------------------------------------

create table if not exists public.holdings (
  user_id    uuid not null references public.profiles on delete cascade,
  player_id  uuid not null references public.players on delete cascade,
  shares     numeric(16,4) not null default 0 check (shares >= 0),
  -- Weighted average cost per share, used for P&L.
  avg_cost   numeric(12,4) not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, player_id)
);

create index if not exists holdings_user_idx on public.holdings (user_id);

create table if not exists public.trades (
  id         bigserial primary key,
  user_id    uuid not null references public.profiles on delete cascade,
  player_id  uuid not null references public.players on delete cascade,
  side       text not null check (side in ('buy','sell')),
  shares     numeric(16,4) not null check (shares > 0),
  avg_price  numeric(12,4) not null,
  gross      numeric(16,2) not null,
  fee        numeric(16,2) not null,
  net        numeric(16,2) not null,
  created_at timestamptz not null default now()
);

create index if not exists trades_user_idx on public.trades (user_id, created_at desc);
create index if not exists trades_player_idx on public.trades (player_id, created_at desc);

create table if not exists public.watchlist (
  user_id    uuid not null references public.profiles on delete cascade,
  player_id  uuid not null references public.players on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, player_id)
);

-- ---------------------------------------------------------------------------
-- News
-- ---------------------------------------------------------------------------

create table if not exists public.news (
  id           bigserial primary key,
  guid         text not null unique,
  sport        text check (sport in ('nba','nhl')),
  title        text not null,
  summary      text,
  url          text not null,
  source       text,
  image_url    text,
  published_at timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index if not exists news_published_idx on public.news (published_at desc);

-- Which players a story mentions, so a player page can show its own headlines.
create table if not exists public.news_players (
  news_id   bigint not null references public.news on delete cascade,
  player_id uuid not null references public.players on delete cascade,
  primary key (news_id, player_id)
);

create index if not exists news_players_player_idx on public.news_players (player_id);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.profiles      enable row level security;
alter table public.players       enable row level security;
alter table public.price_ticks   enable row level security;
alter table public.holdings      enable row level security;
alter table public.trades        enable row level security;
alter table public.watchlist     enable row level security;
alter table public.news          enable row level security;
alter table public.news_players  enable row level security;

-- Profiles: everyone can see usernames (leaderboard), only you can see your cash.
-- Splitting that is done in the view below; the base table is self-access only.
drop policy if exists "profiles are self-readable" on public.profiles;
create policy "profiles are self-readable"
  on public.profiles for select using (auth.uid() = id);

drop policy if exists "profiles are self-updatable" on public.profiles;
create policy "profiles are self-updatable"
  on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "profiles are self-insertable" on public.profiles;
create policy "profiles are self-insertable"
  on public.profiles for insert with check (auth.uid() = id);

-- Market data is public to any signed-in user. Writes are service-role only,
-- which bypasses RLS, so no write policy is granted here on purpose.
drop policy if exists "players readable by authenticated" on public.players;
create policy "players readable by authenticated"
  on public.players for select to authenticated using (true);

drop policy if exists "ticks readable by authenticated" on public.price_ticks;
create policy "ticks readable by authenticated"
  on public.price_ticks for select to authenticated using (true);

drop policy if exists "news readable by authenticated" on public.news;
create policy "news readable by authenticated"
  on public.news for select to authenticated using (true);

drop policy if exists "news links readable by authenticated" on public.news_players;
create policy "news links readable by authenticated"
  on public.news_players for select to authenticated using (true);

-- Positions and trades: strictly your own, read-only from the client.
-- All mutation happens inside execute_trade().
drop policy if exists "holdings are self-readable" on public.holdings;
create policy "holdings are self-readable"
  on public.holdings for select using (auth.uid() = user_id);

drop policy if exists "trades are self-readable" on public.trades;
create policy "trades are self-readable"
  on public.trades for select using (auth.uid() = user_id);

drop policy if exists "watchlist is self-managed" on public.watchlist;
create policy "watchlist is self-managed"
  on public.watchlist for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- New user bootstrap
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data->>'username', ''),
      'trader_' || substr(new.id::text, 1, 8)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- The exchange: server-authoritative trade execution
-- ---------------------------------------------------------------------------

-- Area under the bonding curve  price(s) = V * e^(s/L)  from s0 to s1.
create or replace function public.curve_area(
  fair numeric, s0 numeric, s1 numeric, depth numeric
) returns numeric
language sql immutable
as $$
  select fair * depth * (exp(s1 / depth) - exp(s0 / depth));
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
as $$
declare
  v_user      uuid := auth.uid();
  v_fee_rate  constant numeric := 0.005;
  v_player    public.players%rowtype;
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
  if p_side not in ('buy','sell') then
    raise exception 'side must be buy or sell';
  end if;
  if p_shares is null or p_shares <= 0 then
    raise exception 'shares must be positive';
  end if;
  -- Whole shares only: keeps the ledger legible and avoids dust positions.
  if p_shares <> floor(p_shares) then
    raise exception 'shares must be a whole number';
  end if;

  -- Lock the player row first, then the profile, always in that order.
  -- Consistent lock ordering is what prevents deadlock between two users
  -- trading the same athlete at the same instant.
  select * into v_player from public.players where id = p_player_id for update;
  if not found then
    raise exception 'player not found';
  end if;

  select cash_balance into v_cash from public.profiles where id = v_user for update;
  if not found then
    raise exception 'profile not found';
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
    -- Rounding gross first shifts the fee by up to a cent, which would make the
    -- browser's quote disagree with what the seller actually receives.
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

  insert into public.price_ticks (player_id, market_price, fair_value, shares_outstanding)
  values (p_player_id, v_new_price, v_player.fair_value, v_after);

  insert into public.trades (user_id, player_id, side, shares, avg_price, gross, fee, net)
  values (v_user, p_player_id, p_side, p_shares, v_avg_price, v_gross, v_fee, v_net);

  return jsonb_build_object(
    'ok', true,
    'side', p_side,
    'shares', p_shares,
    'avgPrice', v_avg_price,
    'gross', v_gross,
    'fee', v_fee,
    'net', v_net,
    'priceAfter', v_new_price,
    'sharesOutstanding', v_after
  );
end;
$$;

revoke all on function public.execute_trade(uuid, text, numeric) from public;
grant execute on function public.execute_trade(uuid, text, numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- Leaderboard: exposes portfolio value WITHOUT exposing anyone's cash directly
-- ---------------------------------------------------------------------------

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
           sum(h.shares * pl.market_price) as market_value,
           count(*) as position_count
    from public.holdings h
    join public.players pl on pl.id = h.player_id
    group by h.user_id
  ) h on h.user_id = p.id;

grant select on public.leaderboard to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: broadcast market and portfolio changes to every connected device
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table public.players;
alter publication supabase_realtime add table public.holdings;
alter publication supabase_realtime add table public.trades;
