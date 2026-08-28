-- Halomanage launch foundations: enterprise identity, locale preferences,
-- private employee avatars, and explicit Data API privileges.

alter table public.organizations
  add column if not exists default_locale text not null default 'en'
    check (default_locale in ('en', 'es', 'fr'));

alter table public.employees
  add column if not exists preferred_locale text
    check (preferred_locale is null or preferred_locale in ('en', 'es', 'fr'));

create table public.organization_identity_providers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  domain citext not null,
  metadata_url text,
  sso_provider_id text unique,
  status text not null default 'requested'
    check (status in ('requested', 'configuring', 'active', 'error', 'disabled')),
  enforce_sso boolean not null default false,
  requested_by uuid references auth.users(id) on delete set null,
  requested_at timestamptz not null default now(),
  activated_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, domain),
  check (not enforce_sso or (status = 'active' and sso_provider_id is not null))
);
alter table public.organization_identity_providers enable row level security;
create index organization_identity_providers_org_idx
  on public.organization_identity_providers(organization_id);
create index organization_identity_providers_requested_by_idx
  on public.organization_identity_providers(requested_by)
  where requested_by is not null;

create trigger organization_identity_providers_set_updated_at
  before update on public.organization_identity_providers
  for each row execute function private.set_updated_at();

comment on table public.organization_identity_providers is
  'Organization SAML connection registry. Tenant admins may request a connection through request_organization_sso(); only a trusted platform operator/service role may set provider ids, activation status, enforcement, or errors.';

create policy "organization admins read identity providers"
  on public.organization_identity_providers for select to authenticated
  using (private.has_permission(organization_id, 'organization.manage'));

create or replace function public.request_organization_sso(
  p_organization_id uuid,
  p_domain text,
  p_metadata_url text default null
)
returns public.organization_identity_providers
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_domain text := lower(trim(p_domain));
  v_metadata_url text := nullif(trim(p_metadata_url), '');
  v_result public.organization_identity_providers;
begin
  if (select auth.uid()) is null
     or not private.has_permission(p_organization_id, 'organization.manage') then
    raise exception using errcode = '42501', message = 'You are not authorized to manage organization identity';
  end if;

  if length(v_domain) > 253
     or v_domain !~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$' then
    raise exception using errcode = '22023', message = 'Enter a valid company domain such as example.com';
  end if;

  if v_metadata_url is not null
     and (length(v_metadata_url) > 2048 or v_metadata_url !~ '^https://') then
    raise exception using errcode = '22023', message = 'The identity provider metadata URL must use HTTPS';
  end if;

  insert into public.organization_identity_providers (
    organization_id, domain, metadata_url, status, requested_by, requested_at
  ) values (
    p_organization_id, v_domain, v_metadata_url, 'requested', (select auth.uid()), now()
  )
  on conflict (organization_id, domain) do update
    set metadata_url = excluded.metadata_url,
        requested_by = excluded.requested_by,
        requested_at = now(),
        status = case
          when public.organization_identity_providers.status = 'active'
            then public.organization_identity_providers.status
          else 'requested'
        end,
        last_error = case
          when public.organization_identity_providers.status = 'active'
            then public.organization_identity_providers.last_error
          else null
        end
  returning * into v_result;

  perform private.log_audit_event(
    p_organization_id,
    'ORGANIZATION_SSO_REQUESTED',
    'organization_identity_provider',
    v_result.id,
    null,
    jsonb_build_object('domain', v_result.domain, 'status', v_result.status)
  );

  return v_result;
end;
$$;

create or replace function public.get_portal_identity_options(p_slug text)
returns table (
  sso_available boolean,
  sso_enforced boolean,
  sso_domain text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    (ip.id is not null) as sso_available,
    coalesce(ip.enforce_sso, false) as sso_enforced,
    ip.domain::text as sso_domain
  from public.organizations o
  left join lateral (
    select p.id, p.enforce_sso, p.domain
    from public.organization_identity_providers p
    where p.organization_id = o.id
      and p.status = 'active'
      and p.sso_provider_id is not null
    order by p.enforce_sso desc, p.activated_at desc nulls last
    limit 1
  ) ip on true
  where o.slug = lower(trim(p_slug))::public.citext
    and o.is_active;
$$;

create or replace function public.link_sso_employee_account()
returns public.employees
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_provider_id text := (select auth.jwt() ->> 'sso_provider_id');
  v_email public.citext;
  v_provider public.organization_identity_providers;
  v_employee public.employees;
begin
  if v_user_id is null or nullif(v_provider_id, '') is null then
    raise exception using errcode = '42501', message = 'A verified SSO session is required';
  end if;

  select u.email::public.citext into v_email
  from auth.users u
  where u.id = v_user_id;

  select * into v_provider
  from public.organization_identity_providers ip
  where ip.sso_provider_id = v_provider_id
    and ip.status = 'active'
  for update;

  if v_provider.id is null or v_email is null
     or lower(v_email::text) not like '%@' || lower(v_provider.domain::text) then
    raise exception using errcode = '42501', message = 'This SSO account is not approved for an organization';
  end if;

  select * into v_employee
  from public.employees e
  where e.organization_id = v_provider.organization_id
    and e.work_email = v_email
    and e.status in ('prehire', 'active', 'leave')
    and (e.user_id is null or e.user_id = v_user_id)
  for update;

  if v_employee.id is null then
    raise exception using errcode = 'P0002', message = 'No eligible employee record matches this SSO email';
  end if;

  update public.employees
  set user_id = v_user_id
  where id = v_employee.id
  returning * into v_employee;

  if not exists (
    select 1 from public.role_assignments ra
    where ra.organization_id = v_employee.organization_id
      and ra.user_id = v_user_id
      and ra.valid_from <= now()
      and (ra.valid_until is null or ra.valid_until > now())
  ) then
    insert into public.role_assignments (
      organization_id, user_id, role, scope_type, valid_from, granted_by
    ) values (
      v_employee.organization_id, v_user_id, 'employee', 'organization', now(), v_user_id
    );
  end if;

  perform private.log_audit_event(
    v_employee.organization_id,
    'SSO_EMPLOYEE_ACCOUNT_LINKED',
    'employee',
    v_employee.id,
    null,
    jsonb_build_object('sso_provider_id', v_provider_id)
  );

  return v_employee;
end;
$$;

revoke execute on function public.request_organization_sso(uuid, text, text) from public, anon;
grant execute on function public.request_organization_sso(uuid, text, text) to authenticated;
revoke execute on function public.get_portal_identity_options(text) from public;
grant execute on function public.get_portal_identity_options(text) to anon, authenticated;
revoke execute on function public.link_sso_employee_account() from public, anon;
grant execute on function public.link_sso_employee_account() to authenticated;

-- Avatars are private objects. The stored employees.avatar_url value is an
-- object path, never a public URL: {organization_id}/{employee_id}/{uuid}.ext.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'employee-avatars', 'employee-avatars', false, 5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "organization members read employee avatars"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'employee-avatars'
    and private.is_org_member((storage.foldername(name))[1]::uuid)
  );

create policy "employees upload their avatar"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'employee-avatars'
    and exists (
      select 1 from public.employees e
      where e.id::text = (storage.foldername(name))[2]
        and e.organization_id::text = (storage.foldername(name))[1]
        and (
          e.user_id = (select auth.uid())
          or private.has_permission(e.organization_id, 'employee.manage')
        )
    )
  );

create policy "employees replace their avatar"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'employee-avatars'
    and exists (
      select 1 from public.employees e
      where e.id::text = (storage.foldername(name))[2]
        and e.organization_id::text = (storage.foldername(name))[1]
        and (
          e.user_id = (select auth.uid())
          or private.has_permission(e.organization_id, 'employee.manage')
        )
    )
  )
  with check (
    bucket_id = 'employee-avatars'
    and exists (
      select 1 from public.employees e
      where e.id::text = (storage.foldername(name))[2]
        and e.organization_id::text = (storage.foldername(name))[1]
        and (
          e.user_id = (select auth.uid())
          or private.has_permission(e.organization_id, 'employee.manage')
        )
    )
  );

create policy "employees delete their avatar"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'employee-avatars'
    and exists (
      select 1 from public.employees e
      where e.id::text = (storage.foldername(name))[2]
        and e.organization_id::text = (storage.foldername(name))[1]
        and (
          e.user_id = (select auth.uid())
          or private.has_permission(e.organization_id, 'employee.manage')
        )
    )
  );

-- New Supabase projects no longer implicitly expose newly-created public
-- tables. Declare Data API privileges explicitly; RLS remains the row-level
-- authority, and the service-only/append-only exceptions are revoked below.
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

revoke insert, update, delete on public.audit_events from authenticated;
revoke insert, update, delete on public.role_assignments from authenticated;
revoke all on public.organization_identity_providers from anon;
grant select on public.organization_identity_providers to authenticated;

do $$
begin
  if to_regclass('public.billing_webhook_events') is not null then
    execute 'revoke all on public.billing_webhook_events from anon, authenticated';
  end if;
end;
$$;
