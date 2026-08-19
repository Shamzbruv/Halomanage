-- Halomanage — one-time self-service bootstrap for the very first organization
-- Ref: PRODUCT_BLUEPRINT.md "employer-controlled invitations, not public
-- signup"; ARCHITECTURE.md "No multi-tenant billing/provisioning flow"
-- (docs/ROADMAP.md "Known simplifications").
--
-- The "no public signup" rule is correct and stays — nobody should be able
-- to create an employee record in *someone else's* company. But that rule
-- was implemented too bluntly: it also blocked the very first admin of a
-- brand-new deployment, who by definition has no HR administrator to ask
-- for an invitation yet. Discovered live, in production, by a real user
-- hitting exactly that dead end ("ask an HR administrator" with no admin
-- to ask) — this closes it.
--
-- Design: this only works when the *entire deployment* has zero
-- organizations. The moment one exists (created either by this function or
-- by anything else, e.g. a migration/seed), it's permanently locked out —
-- every subsequent employee still needs a real invitation. This is not a
-- general signup mechanism; it fires exactly once per deployment, ever.

-- Safe to expose broadly (authenticated or not): it reveals nothing more
-- sensitive than "does any organization exist in this deployment yet",
-- which the frontend needs to decide whether to show the bootstrap form or
-- the normal "ask your HR administrator" message.
create or replace function public.deployment_needs_bootstrap()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (select 1 from public.organizations limit 1);
$$;

revoke execute on function public.deployment_needs_bootstrap() from public;
grant execute on function public.deployment_needs_bootstrap() to authenticated, anon;

create or replace function public.bootstrap_first_organization(
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
  v_org public.organizations;
  v_employee public.employees;
  v_email text;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to set up an organization';
  end if;

  -- The core guard: re-check for zero organizations inside the same
  -- transaction as the insert below, not just in
  -- deployment_needs_bootstrap() moments earlier from the client — closes
  -- the race where two people could otherwise both pass the earlier check.
  if exists (select 1 from public.organizations limit 1) then
    raise exception 'This deployment already has an organization set up. Self-service setup only works once, for the very first admin — ask your HR administrator for an invitation instead.';
  end if;

  select email into v_email from auth.users where id = auth.uid();

  insert into public.organizations (name, slug, timezone, country_code)
  values (p_organization_name, p_slug, coalesce(p_timezone, 'UTC'), p_country_code)
  returning * into v_org;

  insert into public.employees (
    organization_id, user_id, employee_number, first_name, last_name, work_email, status, hire_date
  )
  values (
    v_org.id, auth.uid(), 'EMP-0001', p_first_name, p_last_name, v_email, 'active', current_date
  )
  returning * into v_employee;

  insert into public.role_assignments (organization_id, user_id, role)
  values (v_org.id, auth.uid(), 'admin');

  perform private.log_audit_event(
    v_org.id, 'ORGANIZATION_BOOTSTRAPPED', 'organization', v_org.id, null,
    jsonb_build_object('organization', to_jsonb(v_org), 'first_admin_employee_id', v_employee.id)
  );

  return v_org;
end;
$$;

revoke execute on function public.bootstrap_first_organization(text, text, text, text, text, text) from public;
grant execute on function public.bootstrap_first_organization(text, text, text, text, text, text) to authenticated;
