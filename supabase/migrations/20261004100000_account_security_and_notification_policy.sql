-- Halomanage — account security and notification policy
--
-- From the HR review of /settings (docs/ARCHITECTURE.md "Settings: account
-- security and notification policy"):
--
--  1. notification_preferences can't claim an organization the user isn't
--     a member of (same tenant-integrity rule as 20261003100000).
--  2. Notification requirements become organization- and channel-aware:
--     a small system-critical set nobody can switch off, HaloManage
--     defaults, and per-organization overrides — per channel, so "required
--     in-app" never silently means "required by SMS too".
--  3. Email delivery no longer depends on notifications.is_read: reading a
--     notification in the bell must not cancel an email that was due.
--  4. Organization security policy: who must use MFA, and whether
--     sensitive actions need a fresh MFA-verified (aal2) session. Enforced
--     in the database on the sensitive tables themselves, so it holds for
--     every client and every RPC path.
--  5. get_my_security_policy(), list_my_security_activity() and
--     verify_my_password() for the Settings page.

-- ---------------------------------------------------------------------------
-- 1. Notification preference tenant integrity
-- ---------------------------------------------------------------------------

drop policy if exists "manage own notification preferences" on public.notification_preferences;
create policy "manage own notification preferences" on public.notification_preferences for all to authenticated
  using (user_id = (select auth.uid()) and private.is_org_member(organization_id))
  with check (user_id = (select auth.uid()) and private.is_org_member(organization_id));

-- ---------------------------------------------------------------------------
-- 2. Organization- and channel-aware notification requirements
-- ---------------------------------------------------------------------------

create table public.organization_notification_policies (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  notification_type text not null check (char_length(notification_type) between 1 and 100),
  channel text not null check (channel in ('in_app', 'email', 'sms', 'push')),
  required boolean not null,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  primary key (organization_id, notification_type, channel)
);
alter table public.organization_notification_policies enable row level security;
create policy "members read notification policy" on public.organization_notification_policies for select to authenticated
  using (private.is_org_member(organization_id));
-- Writes only through set_notification_requirement().
grant select on public.organization_notification_policies to authenticated;

-- Record and compliance notices an employer cannot make optional.
create or replace function private.system_required_notification(p_type text, p_channel text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_channel = 'in_app' and p_type in (
    'record_request.decided', 'record_request.submitted', 'profile.confirmation_requested'
  );
$$;

-- HaloManage's default (an organization may change it).
create or replace function private.default_required_notification(p_type text, p_channel text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_channel = 'in_app' and p_type in ('onboarding.task_assigned');
$$;

create or replace function private.notification_required(p_organization_id uuid, p_type text, p_channel text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.system_required_notification(p_type, p_channel)
    or coalesce(
      (select p.required from public.organization_notification_policies p
       where p.organization_id = p_organization_id and p.notification_type = p_type and p.channel = p_channel),
      private.default_required_notification(p_type, p_channel)
    );
$$;

create or replace function private.create_notification(
  p_organization_id uuid,
  p_recipient_user_id uuid,
  p_employee_id uuid,
  p_type text,
  p_title text,
  p_body text default null,
  p_link_url text default null,
  p_data jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_enabled boolean;
begin
  if private.notification_required(p_organization_id, p_type, 'in_app') then
    v_enabled := true;
  else
    select coalesce(np.enabled, true) into v_enabled
    from public.notification_preferences np
    where np.user_id = p_recipient_user_id and np.organization_id = p_organization_id
      and np.notification_type = p_type and np.channel = 'in_app';
  end if;

  if v_enabled is distinct from false then
    insert into public.notifications (
      organization_id, recipient_user_id, employee_id, type, title, body, link_url, data
    )
    values (p_organization_id, p_recipient_user_id, p_employee_id, p_type, p_title, p_body, p_link_url, p_data)
    returning id into v_id;
  end if;

  return v_id;
end;
$$;

-- Opting out is refused only on the channel that is actually required.
create or replace function private.guard_required_notification_preference()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not new.enabled and private.notification_required(new.organization_id, new.notification_type, new.channel) then
    raise exception using errcode = '23514', message = 'Your organization requires this notification and it can''t be turned off';
  end if;
  return new;
end;
$$;

create or replace function public.set_notification_requirement(
  p_organization_id uuid,
  p_notification_types text[],
  p_channel text,
  p_required boolean
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text;
  v_count integer := 0;
begin
  if not private.has_permission(p_organization_id, 'organization.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to change notification policy';
  end if;
  if p_channel not in ('in_app', 'email', 'sms', 'push') then
    raise exception using errcode = '22023', message = 'Unknown notification channel';
  end if;
  foreach v_type in array coalesce(p_notification_types, '{}') loop
    if private.system_required_notification(v_type, p_channel) then
      continue;
    end if;
    insert into public.organization_notification_policies (organization_id, notification_type, channel, required, updated_by)
    values (p_organization_id, v_type, p_channel, p_required, auth.uid())
    on conflict (organization_id, notification_type, channel) do update
    set required = excluded.required, updated_by = excluded.updated_by, updated_at = now();
    -- Newly required: clear opt-outs so they actually receive it.
    if p_required then
      delete from public.notification_preferences
      where organization_id = p_organization_id and notification_type = v_type and channel = p_channel and not enabled;
    end if;
    v_count := v_count + 1;
  end loop;

  perform private.log_audit_event(
    p_organization_id, 'NOTIFICATION_POLICY_CHANGED', 'organization', p_organization_id, null,
    jsonb_build_object('types', to_jsonb(p_notification_types), 'channel', p_channel, 'required', p_required)
  );
  return v_count;
end;
$$;

revoke execute on function public.set_notification_requirement(uuid, text[], text, boolean) from public, anon;
grant execute on function public.set_notification_requirement(uuid, text[], text, boolean) to authenticated;

-- Which of the given types are required for the caller's organization on
-- a channel (the Settings page asks about the types it displays).
create or replace function public.get_required_notifications(p_types text[], p_channel text default 'in_app')
returns table (notification_type text, required boolean, system_required boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select t, private.notification_required(e.organization_id, t, p_channel), private.system_required_notification(t, p_channel)
  from unnest(coalesce(p_types, '{}')) as t
  cross join (select organization_id from public.employees where id = private.current_employee_id()) e;
$$;

revoke execute on function public.get_required_notifications(text[], text) from public, anon;
grant execute on function public.get_required_notifications(text[], text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Email delivery is tracked by delivery attempts, not by is_read
-- ---------------------------------------------------------------------------

-- For the send-notifications Edge Function (service role only): recent
-- notifications that should go by email — the recipient opted in, or the
-- organization requires email for that type — and haven't had an email
-- attempt yet, whether or not they were already read in the app.
create or replace function public.list_pending_email_notifications(p_limit integer default 50)
returns table (id uuid, organization_id uuid, recipient_user_id uuid, type text, title text, body text, link_url text)
language sql
stable
security definer
set search_path = ''
as $$
  select n.id, n.organization_id, n.recipient_user_id, n.type, n.title, n.body, n.link_url
  from public.notifications n
  where n.created_at > now() - interval '3 days'
    and not exists (
      select 1 from public.notification_delivery_attempts a
      where a.notification_id = n.id and a.channel = 'email'
    )
    and (
      private.notification_required(n.organization_id, n.type, 'email')
      or exists (
        select 1 from public.notification_preferences p
        where p.user_id = n.recipient_user_id and p.organization_id = n.organization_id
          and p.notification_type = n.type and p.channel = 'email' and p.enabled
      )
    )
  order by n.created_at
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

revoke execute on function public.list_pending_email_notifications(integer) from public, anon, authenticated;
grant execute on function public.list_pending_email_notifications(integer) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Organization security policy: MFA and step-up for sensitive actions
-- ---------------------------------------------------------------------------

create table public.organization_security_policies (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  -- Who must use multi-factor authentication to use HaloManage at all.
  mfa_policy text not null default 'optional'
    check (mfa_policy in ('optional', 'admins', 'managers_and_admins', 'everyone')),
  -- Sensitive actions (roles, compensation, payroll and employee imports,
  -- security settings, ending employment) need an MFA-verified session.
  step_up_for_sensitive_actions boolean not null default false,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);
alter table public.organization_security_policies enable row level security;
create policy "members read security policy" on public.organization_security_policies for select to authenticated
  using (private.is_org_member(organization_id));
-- Writes only through update_security_policy().
grant select on public.organization_security_policies to authenticated;

-- Authenticator Assurance Level of the current request: aal2 once an MFA
-- factor has been verified in this session (Supabase sets the claim).
create or replace function private.current_aal()
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(nullif((select auth.jwt()) ->> 'aal', ''), 'aal1');
$$;

create or replace function private.user_requires_mfa(p_organization_id uuid, p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_policy text;
  v_admin boolean;
begin
  select mfa_policy into v_policy from public.organization_security_policies where organization_id = p_organization_id;
  v_policy := coalesce(v_policy, 'optional');
  if v_policy = 'optional' or p_user_id is null then
    return false;
  end if;
  if v_policy = 'everyone' then
    return true;
  end if;
  v_admin := private.user_has_permission(p_organization_id, p_user_id, 'organization.manage')
    or private.user_has_permission(p_organization_id, p_user_id, 'roles.manage')
    or private.user_has_permission(p_organization_id, p_user_id, 'employee.manage')
    or private.user_has_permission(p_organization_id, p_user_id, 'payroll.import')
    or private.user_has_permission(p_organization_id, p_user_id, 'compensation.manage');
  if v_policy = 'admins' then
    return v_admin;
  end if;
  return v_admin
    or private.user_has_permission(p_organization_id, p_user_id, 'employee.read_team')
    or private.user_has_permission(p_organization_id, p_user_id, 'leave.approve_direct_reports');
end;
$$;

-- Raised from triggers on sensitive tables. Applies to signed-in users
-- only (auth.uid() is null for service-role and migration work, which do
-- their own authorization).
create or replace function private.assert_step_up(p_organization_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or p_organization_id is null then
    return;
  end if;
  if private.current_aal() = 'aal2' then
    return;
  end if;
  if coalesce((select s.step_up_for_sensitive_actions from public.organization_security_policies s where s.organization_id = p_organization_id), false)
     or private.user_requires_mfa(p_organization_id, auth.uid()) then
    raise exception using errcode = '42501',
      message = 'This action needs multi-factor verification. Verify your identity (Settings → Account security) and try again.';
  end if;
end;
$$;

create or replace function private.step_up_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(coalesce(new, old));
begin
  perform private.assert_step_up(nullif(v_row ->> 'organization_id', '')::uuid);
  return coalesce(new, old);
end;
$$;

create or replace function private.step_up_guard_termination()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'terminated' and old.status is distinct from 'terminated' then
    perform private.assert_step_up(new.organization_id);
  end if;
  return new;
end;
$$;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'role_assignments', 'role_permissions', 'organization_roles',
    'employee_compensation', 'employee_compensation_components',
    'payroll_import_batches', 'employee_import_batches',
    'organization_identity_providers', 'organization_network_policies',
    'organization_network_ranges', 'organization_network_exemptions',
    'organization_security_policies', 'organization_notification_policies'
  ] loop
    if to_regclass('public.' || v_table) is not null then
      execute format(
        'create trigger %I before insert or update or delete on public.%I for each row execute function private.step_up_guard()',
        v_table || '_step_up', v_table
      );
    end if;
  end loop;
end $$;

create trigger employees_termination_step_up
  before update of status on public.employees
  for each row execute function private.step_up_guard_termination();

create or replace function public.update_security_policy(
  p_organization_id uuid,
  p_mfa_policy text,
  p_step_up_for_sensitive_actions boolean
)
returns public.organization_security_policies
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.organization_security_policies;
  v_row public.organization_security_policies;
begin
  if not private.has_permission(p_organization_id, 'organization.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to change security policy';
  end if;
  if p_mfa_policy not in ('optional', 'admins', 'managers_and_admins', 'everyone') then
    raise exception using errcode = '22023', message = 'Unknown MFA policy';
  end if;

  select * into v_old from public.organization_security_policies where organization_id = p_organization_id;
  insert into public.organization_security_policies (organization_id, mfa_policy, step_up_for_sensitive_actions, updated_by)
  values (p_organization_id, p_mfa_policy, coalesce(p_step_up_for_sensitive_actions, false), auth.uid())
  on conflict (organization_id) do update
  set mfa_policy = excluded.mfa_policy,
      step_up_for_sensitive_actions = excluded.step_up_for_sensitive_actions,
      updated_by = excluded.updated_by,
      updated_at = now()
  returning * into v_row;

  perform private.log_audit_event(
    p_organization_id, 'SECURITY_POLICY_CHANGED', 'organization', p_organization_id,
    to_jsonb(v_old) - 'updated_by' - 'updated_at', to_jsonb(v_row) - 'updated_by' - 'updated_at'
  );
  return v_row;
end;
$$;

revoke execute on function public.update_security_policy(uuid, text, boolean) from public, anon;
grant execute on function public.update_security_policy(uuid, text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. What Settings needs to know
-- ---------------------------------------------------------------------------

create or replace function public.get_my_security_policy()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  v_policy public.organization_security_policies;
  v_sso record;
begin
  select * into v_employee from public.employees where id = private.current_employee_id();
  if v_employee.id is null then
    return null;
  end if;
  select * into v_policy from public.organization_security_policies where organization_id = v_employee.organization_id;
  select p.domain::text as domain, p.enforce_sso into v_sso
  from public.organization_identity_providers p
  where p.organization_id = v_employee.organization_id and p.status = 'active' and p.sso_provider_id is not null
  order by p.enforce_sso desc, p.activated_at desc nulls last
  limit 1;

  return jsonb_build_object(
    'mfa_policy', coalesce(v_policy.mfa_policy, 'optional'),
    'mfa_required', private.user_requires_mfa(v_employee.organization_id, auth.uid()),
    'step_up_for_sensitive_actions', coalesce(v_policy.step_up_for_sensitive_actions, false),
    'current_aal', private.current_aal(),
    'sso_available', v_sso.domain is not null,
    'sso_enforced', coalesce(v_sso.enforce_sso, false),
    'sso_domain', v_sso.domain
  );
end;
$$;

revoke execute on function public.get_my_security_policy() from public, anon;
grant execute on function public.get_my_security_policy() to authenticated;

-- Recent sign-in and security events for the caller, from Supabase Auth's
-- own audit log (empty if the project doesn't keep it).
create or replace function public.list_my_security_activity()
returns table (occurred_at timestamptz, action text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or to_regclass('auth.audit_log_entries') is null then
    return;
  end if;
  return query execute
    'select created_at, payload->>''action''
     from auth.audit_log_entries
     where payload->>''actor_id'' = $1
       and payload->>''action'' in (''login'', ''logout'', ''user_updated_password'', ''user_recovery_requested'',
         ''mfa_code_login'', ''factor_unenrolled'', ''factor_deleted'', ''invite_accepted'', ''user_reauthenticate_requested'')
     order by created_at desc
     limit 15'
  using auth.uid()::text;
end;
$$;

revoke execute on function public.list_my_security_activity() from public, anon;
grant execute on function public.list_my_security_activity() to authenticated;

-- Confirms the caller's current password before a password change,
-- without creating a session. Five wrong attempts lock it for 15 minutes.
create table public.password_verification_attempts (
  user_id uuid not null references auth.users(id) on delete cascade,
  attempted_at timestamptz not null default now(),
  succeeded boolean not null
);
alter table public.password_verification_attempts enable row level security;
create index password_verification_attempts_user_idx on public.password_verification_attempts(user_id, attempted_at desc);
-- No client policies: written and read only by verify_my_password().

create or replace function public.verify_my_password(p_password text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_hash text;
  v_ok boolean;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Not signed in';
  end if;
  if (select count(*) from public.password_verification_attempts
      where user_id = auth.uid() and not succeeded and attempted_at > now() - interval '15 minutes') >= 5 then
    raise exception using errcode = '54000', message = 'Too many incorrect attempts — wait 15 minutes and try again';
  end if;

  select encrypted_password into v_hash from auth.users where id = auth.uid();
  if v_hash is null or v_hash = '' then
    v_ok := false;
  elsif to_regprocedure('extensions.crypt(text,text)') is not null then
    execute 'select extensions.crypt($1, $2) = $2' into v_ok using p_password, v_hash;
  else
    execute 'select public.crypt($1, $2) = $2' into v_ok using p_password, v_hash;
  end if;

  insert into public.password_verification_attempts (user_id, succeeded) values (auth.uid(), coalesce(v_ok, false));
  delete from public.password_verification_attempts where user_id = auth.uid() and attempted_at < now() - interval '1 day';
  return coalesce(v_ok, false);
end;
$$;

revoke execute on function public.verify_my_password(text) from public, anon;
grant execute on function public.verify_my_password(text) to authenticated;
