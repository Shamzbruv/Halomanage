-- Halomanage — account security events
--
-- Settings → Account security shows "Recent security activity". Supabase
-- Auth's audit log isn't written to this project's database
-- (audit_log_disable_postgres), so HaloManage records the events it shows
-- itself, from triggers on Supabase's auth tables:
--   signed_in        auth.users.last_sign_in_at changed
--   password_changed auth.users.encrypted_password changed
--   mfa_added        a TOTP factor became verified
--   mfa_removed      a verified factor was deleted
-- These triggers run inside Supabase Auth's own writes (sign-in, password
-- change), so they must never fail: every insert is wrapped so an error
-- here can't block anyone from signing in.

create table public.account_security_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  event text not null check (event in ('signed_in', 'password_changed', 'mfa_added', 'mfa_removed')),
  occurred_at timestamptz not null default now()
);
alter table public.account_security_events enable row level security;
create index account_security_events_user_idx on public.account_security_events(user_id, occurred_at desc);
create policy "read own security events" on public.account_security_events for select to authenticated
  using (user_id = (select auth.uid()));
grant select on public.account_security_events to authenticated;

create or replace function private.record_security_event(p_user_id uuid, p_event text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.account_security_events (user_id, event) values (p_user_id, p_event);
  delete from public.account_security_events
  where user_id = p_user_id and occurred_at < now() - interval '180 days';
exception when others then
  -- Never let activity logging break authentication.
  null;
end;
$$;

create or replace function private.auth_users_security_events()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.encrypted_password is distinct from old.encrypted_password and old.encrypted_password is not null and old.encrypted_password <> '' then
    perform private.record_security_event(new.id, 'password_changed');
  end if;
  if new.last_sign_in_at is distinct from old.last_sign_in_at and new.last_sign_in_at is not null then
    perform private.record_security_event(new.id, 'signed_in');
  end if;
  return null;
exception when others then
  return null;
end;
$$;

drop trigger if exists halomanage_security_events on auth.users;
create trigger halomanage_security_events
  after update on auth.users
  for each row execute function private.auth_users_security_events();

create or replace function private.auth_mfa_security_events()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.status::text = 'verified' and old.status::text is distinct from 'verified' then
    perform private.record_security_event(new.user_id, 'mfa_added');
  elsif tg_op = 'DELETE' and old.status::text = 'verified' then
    perform private.record_security_event(old.user_id, 'mfa_removed');
  end if;
  return null;
exception when others then
  return null;
end;
$$;

do $$
begin
  if to_regclass('auth.mfa_factors') is not null then
    execute 'drop trigger if exists halomanage_mfa_security_events on auth.mfa_factors';
    execute 'create trigger halomanage_mfa_security_events after update or delete on auth.mfa_factors for each row execute function private.auth_mfa_security_events()';
  end if;
end $$;

create or replace function public.list_my_security_activity()
returns table (occurred_at timestamptz, action text)
language sql
stable
security definer
set search_path = ''
as $$
  select e.occurred_at, e.event
  from public.account_security_events e
  where e.user_id = (select auth.uid())
  order by e.occurred_at desc
  limit 15;
$$;

revoke execute on function public.list_my_security_activity() from public, anon;
grant execute on function public.list_my_security_activity() to authenticated;
