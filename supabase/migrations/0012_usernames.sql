-- Usernames a trader can change, and a fix for what letting them write their
-- own profile row actually allowed.
--
-- The self-update policy from 0008 pinned is_admin so nobody could promote
-- themselves. It did not pin cash_balance. Every other column on profiles was
-- assumed to be inert, but cash_balance is the whole game: a signed-in user
-- holding only the publishable key could
--
--     update profiles set cash_balance = 1e9 where id = auth.uid()
--
-- and RLS would have allowed it, because the policy only ever asked "is this
-- your row?". Trading is guarded by execute_trade(), so nothing in the app can
-- do this — but the policy is the boundary, not the app, and anyone can call
-- PostgREST directly.
--
-- So the policy is narrowed to what a user genuinely owns: their username.
-- Balances move only through execute_trade() and settle_listing(), which are
-- SECURITY DEFINER and bypass this policy by design.

-- Usernames appear on a public leaderboard, so they get shape rules rather than
-- only a length. Existing rows are left alone: `not valid` skips the backfill
-- check and applies the constraint to writes from here on, which is what
-- matters — nobody should be locked out of renaming because the name they were
-- auto-assigned in 2025 has a character this now disallows.
alter table public.profiles
  drop constraint if exists profiles_username_shape;

alter table public.profiles
  add constraint profiles_username_shape
  check (username ~ '^[A-Za-z0-9_]{3,20}$') not valid;

drop policy if exists "profiles are self-updatable" on public.profiles;
create policy "profiles are self-updatable"
  on public.profiles for update
  using (auth.uid() = id)
  with check (
    auth.uid() = id
    -- Both pinned to their current values: the only column this policy lets
    -- through is username.
    and is_admin     = (select p.is_admin     from public.profiles p where p.id = auth.uid())
    and cash_balance = (select p.cash_balance from public.profiles p where p.id = auth.uid())
  );

/**
 * Rename yourself.
 *
 * Goes through a function rather than a bare update so the failure a user is
 * most likely to hit — the name is taken — comes back as a sentence they can
 * act on instead of a Postgres unique-violation string. Case-insensitive,
 * because two traders separated only by capitalisation is a leaderboard that
 * lies about who is who.
 */
create or replace function public.set_username(p_username text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_name text := btrim(coalesce(p_username, ''));
begin
  if v_user is null then
    raise exception 'sign in to change your username';
  end if;

  if v_name !~ '^[A-Za-z0-9_]{3,20}$' then
    raise exception 'usernames are 3-20 characters, letters, numbers and underscores only';
  end if;

  if exists (
    select 1 from public.profiles
     where lower(username) = lower(v_name)
       and id <> v_user
  ) then
    raise exception 'that username is taken';
  end if;

  update public.profiles set username = v_name where id = v_user;
  return v_name;
end;
$$;

revoke all on function public.set_username(text) from public;
grant execute on function public.set_username(text) to authenticated;

-- Stop two accounts differing only by case from existing at all, which the
-- plain unique constraint on username permits.
create unique index if not exists profiles_username_lower_key
  on public.profiles (lower(username));
