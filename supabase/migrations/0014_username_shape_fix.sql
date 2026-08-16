-- Fix a constraint that quietly locked two people out of trading.
--
-- 0012 added `profiles_username_shape` as `^[A-Za-z0-9_]{3,20}$ NOT VALID`,
-- reasoning that NOT VALID skips the backfill so nobody would be locked out of
-- renaming by a name they were auto-assigned. That reasoning was wrong in a way
-- worth writing down: **NOT VALID only skips the check for rows as they already
-- are — every subsequent UPDATE to the row is still checked**, including
-- updates that do not touch username at all.
--
-- `execute_trade()` updates `profiles.cash_balance`. So the two accounts whose
-- usernames contain a space (two real accounts) could no longer
-- buy or sell anything: every trade failed on a constraint about a column the
-- trade never touched. Nothing in the UI could have explained that.
--
-- The real lesson is about where validation belongs. A table-wide CHECK on
-- `username` gates *every* write to the row, so it is not a username rule at
-- all — it is a rule about the whole profile. The shape genuinely does need
-- enforcing at the table, because the self-update policy lets a user PATCH
-- `username` directly without going through set_username(). So it stays, but
-- widened to accept the names people already have, and then VALIDATED so the
-- database confirms every existing row passes rather than leaving landmines.
--
-- Spaces, hyphens and apostrophes are allowed because they are how people
-- actually write names. What stays banned is the set that causes trouble
-- elsewhere: angle brackets, quotes, slashes, control characters.

alter table public.profiles
  drop constraint if exists profiles_username_shape;

alter table public.profiles
  add constraint profiles_username_shape
  check (username ~ '^[A-Za-z0-9_''. -]{3,20}$');

-- No NOT VALID this time. If any row fails, this migration fails loudly here
-- rather than silently turning into a trading outage for that person later.

/**
 * Keep set_username() in step with the constraint above.
 *
 * These two must agree. If the function is stricter than the table, a user is
 * told a name is invalid that the database would happily accept; if it is
 * looser, the function raises a friendly message and then the write fails on a
 * raw constraint error anyway.
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

  if v_name !~ '^[A-Za-z0-9_''. -]{3,20}$' then
    raise exception 'usernames are 3-20 characters: letters, numbers, spaces, and _ - . '' only';
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
