-- Halomanage — platform console foundation
--
-- Everything in this file lives in a trust boundary that is deliberately
-- separate from tenant RBAC (role_assignments / app_role / has_permission).
-- Platform staff are Halomanage operators who can see and act across every
-- organization; tenant admins (however powerful inside their own org) get
-- none of this by construction — nothing here is reachable through
-- organization-scoped permission bundles, and nothing in the tenant RBAC
-- system can grant it.
--
-- Scope note: this ships the mechanism (staff roster, audit trail, a
-- per-organization feature-override switch, and an approval workflow for
-- the SSO connection requests already sitting behind "trusted platform
-- operator"). It deliberately does not invent a plan/pricing ladder —
-- that's a decision for later, and layering plan-bundled features on top
-- of organization_feature_overrides is additive whenever it's made.

-- ============================== PLATFORM STAFF ===============================

create type public.platform_role as enum ('owner', 'admin', 'support', 'billing', 'developer', 'security');

create table public.platform_staff (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  role public.platform_role not null,
  display_name text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);
alter table public.platform_staff enable row level security;

comment on table public.platform_staff is
  'Halomanage operators with cross-organization access. Entirely separate from role_assignments — a tenant admin holds none of this by default.';

create or replace function private.is_platform_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.platform_staff where user_id = (select auth.uid()));
$$;

create or replace function private.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.platform_staff
    where user_id = (select auth.uid()) and role in ('owner', 'admin')
  );
$$;

create policy "platform staff read roster"
  on public.platform_staff for select to authenticated
  using (private.is_platform_staff());

revoke insert, update, delete on public.platform_staff from authenticated;

-- ============================== PLATFORM AUDIT LOG ===========================

create table public.platform_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  target_organization_id uuid references public.organizations(id) on delete set null,
  target_type text,
  target_id uuid,
  detail jsonb,
  created_at timestamptz not null default now()
);
alter table public.platform_audit_log enable row level security;
create index platform_audit_log_created_at_idx on public.platform_audit_log(created_at desc);
create index platform_audit_log_target_org_idx on public.platform_audit_log(target_organization_id)
  where target_organization_id is not null;

comment on table public.platform_audit_log is
  'Every platform-staff action against any tenant, including changes to the roster itself. Insert-only from log_platform_audit_event() — never written directly.';

create policy "platform staff read audit log"
  on public.platform_audit_log for select to authenticated
  using (private.is_platform_staff());

revoke insert, update, delete on public.platform_audit_log from authenticated;

create or replace function private.log_platform_audit_event(
  p_action text,
  p_target_organization_id uuid default null,
  p_target_type text default null,
  p_target_id uuid default null,
  p_detail jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.platform_audit_log (
    actor_user_id, action, target_organization_id, target_type, target_id, detail
  ) values (
    (select auth.uid()), p_action, p_target_organization_id, p_target_type, p_target_id, p_detail
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- ============================ FEATURE ENTITLEMENTS ===========================

create table public.platform_features (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{0,63}$'),
  name text not null,
  description text
);
alter table public.platform_features enable row level security;

create policy "platform staff read feature catalog"
  on public.platform_features for select to authenticated
  using (private.is_platform_staff());

revoke insert, update, delete on public.platform_features from authenticated;

create table public.organization_feature_overrides (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  feature_key text not null references public.platform_features(key) on delete cascade,
  enabled boolean not null,
  note text,
  set_by uuid references auth.users(id) on delete set null,
  set_at timestamptz not null default now(),
  primary key (organization_id, feature_key)
);
alter table public.organization_feature_overrides enable row level security;
create index organization_feature_overrides_org_idx on public.organization_feature_overrides(organization_id);

comment on table public.organization_feature_overrides is
  'Per-organization feature switches, set by platform staff. Absence of a row means the feature is off — there is no plan-bundle fallback yet by design; see file header.';

create policy "platform staff read feature overrides"
  on public.organization_feature_overrides for select to authenticated
  using (private.is_platform_staff());

-- Org admins may read only their own organization's effective overrides —
-- the "why is this off for us" view — without seeing anyone else's tenant.
create policy "org admins read own feature overrides"
  on public.organization_feature_overrides for select to authenticated
  using (private.has_permission(organization_id, 'organization.manage'));

revoke insert, update, delete on public.organization_feature_overrides from authenticated;

create or replace function public.organization_has_feature(p_org_id uuid, p_feature_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select enabled from public.organization_feature_overrides
     where organization_id = p_org_id and feature_key = p_feature_key),
    false
  );
$$;

revoke all on function public.organization_has_feature(uuid, text) from public, anon;
grant execute on function public.organization_has_feature(uuid, text) to authenticated;

-- ================================ PLATFORM RPCs ==============================

create or replace function public.platform_add_staff(
  p_email text,
  p_role public.platform_role
)
returns public.platform_staff
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_result public.platform_staff;
begin
  if not private.is_platform_admin() then
    raise exception using errcode = '42501', message = 'Only a platform owner or admin can manage platform staff';
  end if;

  select id into v_user_id from auth.users where email::public.citext = trim(p_email)::public.citext limit 1;
  if v_user_id is null then
    raise exception using errcode = 'P0002', message = 'No Halomanage account exists for that email yet — ask them to sign up first';
  end if;

  insert into public.platform_staff (user_id, role, created_by)
  values (v_user_id, p_role, (select auth.uid()))
  on conflict (user_id) do update set role = excluded.role
  returning * into v_result;

  perform private.log_platform_audit_event(
    'PLATFORM_STAFF_SET', null, 'platform_staff', v_result.id,
    jsonb_build_object('email', p_email, 'role', p_role)
  );
  return v_result;
end;
$$;

create or replace function public.platform_remove_staff(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_self uuid := (select auth.uid());
  v_role public.platform_role;
  v_other_owner_exists boolean;
begin
  if not private.is_platform_admin() then
    raise exception using errcode = '42501', message = 'Only a platform owner or admin can manage platform staff';
  end if;
  if p_user_id = v_self then
    raise exception using errcode = '23514', message = 'You cannot remove your own platform access here';
  end if;

  select role into v_role from public.platform_staff where user_id = p_user_id;
  if v_role is null then
    raise exception 'That person is not on the platform staff roster';
  end if;

  if v_role = 'owner' then
    select exists (
      select 1 from public.platform_staff where role = 'owner' and user_id <> p_user_id
    ) into v_other_owner_exists;
    if not v_other_owner_exists then
      raise exception using errcode = '23514', message = 'The last platform owner cannot be removed';
    end if;
  end if;

  delete from public.platform_staff where user_id = p_user_id;
  perform private.log_platform_audit_event('PLATFORM_STAFF_REMOVED', null, 'platform_staff', p_user_id, null);
end;
$$;

create or replace function public.platform_list_organizations()
returns table (
  id uuid,
  name text,
  slug public.citext,
  subscription_status text,
  employee_count bigint,
  active_employee_count bigint,
  portal_account_count bigint,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_platform_staff() then
    raise exception using errcode = '42501', message = 'Platform staff access required';
  end if;
  return query
    select
      o.id, o.name, o.slug, os.status,
      (select count(*) from public.employees e where e.organization_id = o.id),
      (select count(*) from public.employees e where e.organization_id = o.id and e.status = 'active'),
      (select count(*) from public.employees e where e.organization_id = o.id and e.user_id is not null),
      o.created_at
    from public.organizations o
    left join public.organization_subscriptions os on os.organization_id = o.id
    order by o.created_at desc;
end;
$$;

create or replace function public.platform_list_organization_employees(p_org_id uuid)
returns table (
  id uuid,
  first_name text,
  last_name text,
  work_email public.citext,
  status text,
  has_account boolean,
  role public.app_role
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_platform_staff() then
    raise exception using errcode = '42501', message = 'Platform staff access required';
  end if;
  return query
    select
      e.id, e.first_name, e.last_name, e.work_email, e.status,
      (e.user_id is not null),
      (
        select ra.role from public.role_assignments ra
        where ra.organization_id = p_org_id and ra.user_id = e.user_id
          and ra.valid_from <= now() and (ra.valid_until is null or ra.valid_until > now())
        limit 1
      )
    from public.employees e
    where e.organization_id = p_org_id
    order by e.last_name;
end;
$$;

create or replace function public.platform_set_feature_override(
  p_org_id uuid,
  p_feature_key text,
  p_enabled boolean,
  p_note text default null
)
returns public.organization_feature_overrides
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result public.organization_feature_overrides;
begin
  if not private.is_platform_staff() then
    raise exception using errcode = '42501', message = 'Platform staff access required';
  end if;

  insert into public.organization_feature_overrides (organization_id, feature_key, enabled, note, set_by, set_at)
  values (p_org_id, p_feature_key, p_enabled, nullif(trim(p_note), ''), (select auth.uid()), now())
  on conflict (organization_id, feature_key) do update
    set enabled = excluded.enabled, note = excluded.note, set_by = excluded.set_by, set_at = now()
  returning * into v_result;

  perform private.log_platform_audit_event(
    'FEATURE_OVERRIDE_SET', p_org_id, 'feature', null,
    jsonb_build_object('feature_key', p_feature_key, 'enabled', p_enabled, 'note', p_note)
  );
  return v_result;
end;
$$;

create or replace function public.platform_clear_feature_override(
  p_org_id uuid,
  p_feature_key text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_platform_staff() then
    raise exception using errcode = '42501', message = 'Platform staff access required';
  end if;

  delete from public.organization_feature_overrides
  where organization_id = p_org_id and feature_key = p_feature_key;

  perform private.log_platform_audit_event(
    'FEATURE_OVERRIDE_CLEARED', p_org_id, 'feature', null,
    jsonb_build_object('feature_key', p_feature_key)
  );
end;
$$;

-- Surfaces the SSO connection requests that request_organization_sso() (see
-- 20260828130000_identity_localization_avatars.sql) leaves sitting at
-- 'requested' for a platform operator to pick up — this RPC plus
-- platform_update_identity_provider() below are that operator's UI.
create or replace function public.platform_list_sso_requests()
returns table (
  id uuid,
  organization_id uuid,
  organization_name text,
  organization_slug public.citext,
  domain public.citext,
  metadata_url text,
  sso_provider_id text,
  status text,
  enforce_sso boolean,
  requested_at timestamptz,
  activated_at timestamptz,
  last_error text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_platform_staff() then
    raise exception using errcode = '42501', message = 'Platform staff access required';
  end if;
  return query
    select
      ip.id, ip.organization_id, o.name, o.slug, ip.domain, ip.metadata_url, ip.sso_provider_id,
      ip.status, ip.enforce_sso, ip.requested_at, ip.activated_at, ip.last_error
    from public.organization_identity_providers ip
    join public.organizations o on o.id = ip.organization_id
    order by ip.requested_at desc;
end;
$$;

create or replace function public.platform_update_identity_provider(
  p_id uuid,
  p_status text,
  p_sso_provider_id text default null,
  p_enforce_sso boolean default false,
  p_last_error text default null
)
returns public.organization_identity_providers
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result public.organization_identity_providers;
begin
  if not private.is_platform_staff() then
    raise exception using errcode = '42501', message = 'Platform staff access required';
  end if;
  if p_status not in ('requested', 'configuring', 'active', 'error', 'disabled') then
    raise exception using errcode = '22023', message = 'Invalid identity provider status';
  end if;

  update public.organization_identity_providers
  set status = p_status,
      sso_provider_id = coalesce(nullif(trim(p_sso_provider_id), ''), sso_provider_id),
      enforce_sso = p_enforce_sso,
      last_error = nullif(trim(p_last_error), ''),
      activated_at = case when p_status = 'active' and activated_at is null then now() else activated_at end
  where id = p_id
  returning * into v_result;

  if v_result.id is null then
    raise exception 'Identity provider connection not found';
  end if;

  perform private.log_platform_audit_event(
    'SSO_CONNECTION_UPDATED', v_result.organization_id, 'identity_provider', v_result.id,
    jsonb_build_object('status', p_status, 'enforce_sso', p_enforce_sso)
  );
  return v_result;
end;
$$;

revoke all on function public.platform_add_staff(text, public.platform_role) from public, anon;
revoke all on function public.platform_remove_staff(uuid) from public, anon;
revoke all on function public.platform_list_organizations() from public, anon;
revoke all on function public.platform_list_organization_employees(uuid) from public, anon;
revoke all on function public.platform_set_feature_override(uuid, text, boolean, text) from public, anon;
revoke all on function public.platform_clear_feature_override(uuid, text) from public, anon;
revoke all on function public.platform_list_sso_requests() from public, anon;
revoke all on function public.platform_update_identity_provider(uuid, text, text, boolean, text) from public, anon;

grant execute on function public.platform_add_staff(text, public.platform_role) to authenticated;
grant execute on function public.platform_remove_staff(uuid) to authenticated;
grant execute on function public.platform_list_organizations() to authenticated;
grant execute on function public.platform_list_organization_employees(uuid) to authenticated;
grant execute on function public.platform_set_feature_override(uuid, text, boolean, text) to authenticated;
grant execute on function public.platform_clear_feature_override(uuid, text) to authenticated;
grant execute on function public.platform_list_sso_requests() to authenticated;
grant execute on function public.platform_update_identity_provider(uuid, text, text, boolean, text) to authenticated;

-- ================================== SEED DATA =================================

insert into public.platform_features (key, name, description) values
  ('sso', 'Single sign-on', 'Lets an organization request and use a SAML/OIDC connection instead of email/password.')
on conflict (key) do nothing;

-- Bootstrap: the account that has been operating this project becomes the
-- first platform owner. Safe to re-run — a no-op once the row exists, and a
-- no-op in any environment where this address hasn't signed up (e.g. tests).
insert into public.platform_staff (user_id, role, display_name)
select id, 'owner', 'Shamar Baker'
from auth.users
where email::public.citext = 'shamzbiz1@gmail.com'::public.citext
on conflict (user_id) do nothing;

-- Carries forward the SSO admin page's existing access for the one
-- organization already using it, so shipping the entitlement gate below
-- doesn't take away something that already worked.
insert into public.organization_feature_overrides (organization_id, feature_key, enabled, note)
select o.id, 'sso', true, 'Carried forward when feature gating shipped — already had SSO admin access.'
from public.organizations o
where o.slug = 'icreate-solutions-services'
on conflict (organization_id, feature_key) do nothing;
