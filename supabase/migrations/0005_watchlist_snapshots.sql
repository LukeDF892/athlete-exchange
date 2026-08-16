-- Patch 0005: watchlists, portfolio value history, and leaderboard access.
--
-- Three additions that share one migration because they are all small:
--   * watchlist        — athletes you are following but do not own
--   * portfolio_snapshots — net worth over time, so performance is a chart
--   * leaderboard      — grant is re-asserted here; the view already existed
--                        in 0001 but nothing ever read from it
--
-- Safe to re-run.

-- ---------------------------------------------------------------------------
-- Watchlist
-- ---------------------------------------------------------------------------
create table if not exists public.watchlist (
  user_id    uuid not null references auth.users(id) on delete cascade,
  player_id  uuid not null references public.players(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, player_id)
);

create index if not exists watchlist_user_idx on public.watchlist(user_id);

alter table public.watchlist enable row level security;

-- A watchlist is private: you can only ever see or change your own.
drop policy if exists "watchlist is self-readable" on public.watchlist;
create policy "watchlist is self-readable"
  on public.watchlist for select using (auth.uid() = user_id);

drop policy if exists "watchlist is self-insertable" on public.watchlist;
create policy "watchlist is self-insertable"
  on public.watchlist for insert with check (auth.uid() = user_id);

drop policy if exists "watchlist is self-deletable" on public.watchlist;
create policy "watchlist is self-deletable"
  on public.watchlist for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Portfolio value over time
-- ---------------------------------------------------------------------------
create table if not exists public.portfolio_snapshots (
  user_id        uuid not null references auth.users(id) on delete cascade,
  ts             timestamptz not null default now(),
  cash           numeric(16,2) not null,
  holdings_value numeric(16,2) not null,
  net_worth      numeric(16,2) not null,
  primary key (user_id, ts)
);

create index if not exists portfolio_snapshots_user_ts_idx
  on public.portfolio_snapshots(user_id, ts desc);

alter table public.portfolio_snapshots enable row level security;

-- Your own history only. Writes come from the scheduled job using the service
-- role, which bypasses RLS, so no insert policy is granted on purpose.
drop policy if exists "snapshots are self-readable" on public.portfolio_snapshots;
create policy "snapshots are self-readable"
  on public.portfolio_snapshots for select using (auth.uid() = user_id);

/**
 * Record every trader's net worth as of now.
 *
 * Called by the daily job. Marked SECURITY DEFINER so one call can write a row
 * for every user; it takes no arguments and reads only aggregate state, so it
 * cannot be steered into exposing one user's holdings to another.
 */
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
    select h.user_id, sum(h.shares * pl.market_price) as market_value
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

-- ---------------------------------------------------------------------------
-- Leaderboard
-- ---------------------------------------------------------------------------
-- The view was created in 0001 but never granted or read. It runs with
-- security_invoker = false so it can rank across all profiles while the base
-- profiles table stays self-access only — usernames and net worth are visible,
-- cash and individual positions are not.
grant select on public.leaderboard to authenticated;
