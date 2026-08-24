-- Self-service organization-owner provisioning.
--
-- Employee membership remains invitation-only. This RPC exists for a new,
-- authenticated organization owner who has no employee or role membership
-- anywhere yet. SECURITY DEFINER is required because that person cannot have
-- normal INSERT rights before the first tenant-scoped role exists.

create or replace function public.create_organization_workspace(
  p_organization_name text,
  p_slug text,
  p_first_name text,
  p_last_name text,
  p_timezone text default 'UTC',
  p_country_code text default null
)
returns public.organizations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_email text;
  v_org public.organizations;
  v_employee public.employees;
  v_slug text;
  v_base_slug text;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'You must be signed in to create an organization';
  end if;

  -- Serialize provisioning for this account so a double submit cannot create
  -- two organizations before either transaction sees the other's inserts.
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));

  if exists (select 1 from public.role_assignments where user_id = v_user_id)
     or exists (select 1 from public.employees where user_id = v_user_id) then
    raise exception using errcode = '23505', message = 'This account already belongs to an organization';
  end if;

  if nullif(btrim(p_organization_name), '') is null or char_length(btrim(p_organization_name)) > 120 then
    raise exception using errcode = '22023', message = 'Organization name must be between 1 and 120 characters';
  end if;
  if nullif(btrim(p_first_name), '') is null or char_length(btrim(p_first_name)) > 80 then
    raise exception using errcode = '22023', message = 'First name must be between 1 and 80 characters';
  end if;
  if nullif(btrim(p_last_name), '') is null or char_length(btrim(p_last_name)) > 80 then
    raise exception using errcode = '22023', message = 'Last name must be between 1 and 80 characters';
  end if;
  if nullif(btrim(p_timezone), '') is null or char_length(btrim(p_timezone)) > 100 then
    raise exception using errcode = '22023', message = 'A valid timezone is required';
  end if;
  if p_country_code is not null and p_country_code !~ '^[A-Za-z]{2}$' then
    raise exception using errcode = '22023', message = 'Country code must contain two letters';
  end if;

  select email into v_email from auth.users where id = v_user_id;
  if v_email is null then
    raise exception using errcode = '22023', message = 'A verified email address is required';
  end if;

  v_base_slug := trim(both '-' from regexp_replace(lower(coalesce(p_slug, p_organization_name)), '[^a-z0-9]+', '-', 'g'));
  if char_length(v_base_slug) < 2 then v_base_slug := 'organization'; end if;
  v_slug := left(v_base_slug, 50);
  if exists (select 1 from public.organizations where slug = v_slug) then
    v_slug := left(v_base_slug, 41) || '-' || left(replace(gen_random_uuid()::text, '-', ''), 8);
  end if;

  insert into public.organizations (name, slug, timezone, country_code)
  values (btrim(p_organization_name), v_slug, btrim(p_timezone), upper(p_country_code))
  returning * into v_org;

  insert into public.employees (
    organization_id, user_id, employee_number, first_name, last_name, work_email, status, hire_date
  ) values (
    v_org.id, v_user_id, 'EMP-0001', btrim(p_first_name), btrim(p_last_name), v_email, 'active', current_date
  ) returning * into v_employee;

  insert into public.role_assignments (organization_id, user_id, role, granted_by)
  values (v_org.id, v_user_id, 'admin', v_user_id);

  perform private.log_audit_event(
    v_org.id,
    'ORGANIZATION_WORKSPACE_CREATED',
    'organization',
    v_org.id,
    null,
    jsonb_build_object('organization', to_jsonb(v_org), 'first_admin_employee_id', v_employee.id)
  );

  return v_org;
end;
$$;

revoke execute on function public.create_organization_workspace(text, text, text, text, text, text)
  from public, anon;
grant execute on function public.create_organization_workspace(text, text, text, text, text, text)
  to authenticated;
