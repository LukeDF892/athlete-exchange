-- Patch 0008: an owner-only view of every account.
--
-- Row-level security applies to the operator too — that is the point of it — so
-- there is no way to see other users' data without an explicit exception. This
-- adds the narrowest one that does the job:
--
--   * profiles.is_admin marks the owner. It defaults to false and users cannot
--     set it on themselves: the self-update policy below excludes the column,
--     so promoting an admin requires the service role or the SQL editor.
--   * is_admin() reads that flag as SECURITY DEFINER, so the policies can call
--     it without recursing back through RLS on profiles.
--   * One extra SELECT policy per table, granting admins read access. No admin
--     INSERT, UPDATE or DELETE is granted anywhere — the operator can look at
--     balances, not change them.
--
-- Users are told about this in the terms of service before they sign up.
--
-- Safe to re-run.

alter table public.profiles
  add column if not exists is_admin boolean not null default false;

/**
 * Whether the caller is an operator.
 *
 * SECURITY DEFINER so that a policy on profiles can check the flag without
 * triggering the very policy it is part of.
 */
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false);
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- Read-only visibility across every table that holds user activity.
drop policy if exists "admins read all profiles" on public.profiles;
create policy "admins read all profiles"
  on public.profiles for select using (public.is_admin());

drop policy if exists "admins read all holdings" on public.holdings;
create policy "admins read all holdings"
  on public.holdings for select using (public.is_admin());

drop policy if exists "admins read all trades" on public.trades;
create policy "admins read all trades"
  on public.trades for select using (public.is_admin());

drop policy if exists "admins read all watchlist" on public.watchlist;
create policy "admins read all watchlist"
  on public.watchlist for select using (public.is_admin());

drop policy if exists "admins read all snapshots" on public.portfolio_snapshots;
create policy "admins read all snapshots"
  on public.portfolio_snapshots for select using (public.is_admin());

-- Stop a user granting themselves admin. The existing self-update policy allows
-- writing your own row, so is_admin has to be pinned to its current value.
drop policy if exists "profiles are self-updatable" on public.profiles;
create policy "profiles are self-updatable"
  on public.profiles for update
  using (auth.uid() = id)
  with check (
    auth.uid() = id
    and is_admin = (select p.is_admin from public.profiles p where p.id = auth.uid())
  );

-- Make yourself the operator. Replace the address if you sign up with another.
update public.profiles
   set is_admin = true
 where id in (select id from auth.users where email = 'lukeflewwelling@gmail.com');
