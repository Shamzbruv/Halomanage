-- Halomanage — custom, organization-named roles ("HR Manager", etc.)
--
-- Prior state: role_assignments/role_permissions were keyed to the fixed
-- 4-value app_role enum only. The schema already supported an org
-- overriding a built-in role's permission bundle (role_permissions rows
-- with organization_id set), but nothing ever built a UI for it, and there
-- was no way for a company to have a genuinely distinct role — e.g. "HR
-- Manager" with its own name and its own hand-picked permission set,
-- independent of "Admin". This migration adds that as a first-class,
-- additive concept sitting alongside the 4 built-ins, which remain
-- permanent and are not going away (see ARCHITECTURE.md for the full
-- design writeup).
--
-- Approach: role_assignments/role_permissions gain a nullable
-- custom_role_id pointing at a new organization_roles table, with a CHECK
-- that a row is either a built-in role OR a custom role, never both/neither.
-- Every place in the schema that resolves "what can this role do" or "does
-- this literally say admin" is generalized to walk both paths. This keeps
-- the existing app_role enum, its indexes, and the many places that
-- legitimately mean "the literal built-in Admin role" (see
-- repair_current_workspace's starter-workspace seeding) completely intact,
-- while making custom roles behave identically to built-in ones everywhere
-- permissions are actually checked.

-- ---------------------------------------------------------------------------
-- 1. organization_roles — an org's own named roles
-- ---------------------------------------------------------------------------

create table public.organization_roles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  description text,
  is_active boolean not null default true,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.organization_roles enable row level security;
create index organization_roles_org_idx on public.organization_roles(organization_id);
create unique index organization_roles_org_name_key on public.organization_roles(organization_id, lower(name));

create trigger organization_roles_set_updated_at
  before update on public.organization_roles
  for each row execute function private.set_updated_at();

-- Every org member can see the roles that exist (needed to render "this
-- person holds HR Manager" anywhere in the UI); only roles.manage holders
-- may write, and only through the audited RPCs below — matching the
-- role_assignments precedent (20260828110000_lifecycle_rbac_hardening.sql).
create policy "read organization roles" on public.organization_roles for select to authenticated
  using (private.is_org_member(organization_id));
revoke insert, update, delete on table public.organization_roles from authenticated;
grant select on table public.organization_roles to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Generalize role_assignments and role_permissions
-- ---------------------------------------------------------------------------

alter table public.role_assignments
  alter column role drop not null,
  add column custom_role_id uuid references public.organization_roles(id),
  add constraint role_assignments_role_xor_custom
    check ((role is not null) <> (custom_role_id is not null));

alter table public.role_permissions
  alter column role drop not null,
  add column custom_role_id uuid references public.organization_roles(id) on delete cascade,
  drop constraint role_permissions_organization_id_role_permission_key,
  add constraint role_permissions_role_xor_custom
    check ((role is not null) <> (custom_role_id is not null));

-- Replaces the dropped table-level UNIQUE (organization_id, role, permission)
-- with two partial indexes, since a custom role's bundle has no
-- organization_id-is-null "global default" concept to also uniquely key on.
create unique index role_permissions_default_role_permission_key
  on public.role_permissions (organization_id, role, permission) where role is not null;
create unique index role_permissions_custom_role_permission_key
  on public.role_permissions (custom_role_id, permission) where custom_role_id is not null;

-- Direct writes to role_permissions were technically RLS-permitted before
-- (an unused "admins override role permissions" policy — no UI ever called
-- it) but every mutation now goes through the audited RPCs below, matching
-- role_assignments' already-hardened pattern.
drop policy if exists "admins override role permissions" on public.role_permissions;
revoke insert, update, delete on table public.role_permissions from authenticated;
grant select on table public.role_permissions to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Permission resolution — generalized to walk both the built-in and
--    custom-role paths. private.has_permission()'s signature and callers
--    are untouched; only its internals change, via a new reusable helper.
-- ---------------------------------------------------------------------------

-- Does a built-in role, for this org (its override if one exists, else the
-- global default bundle), grant this permission? Factored out of
-- has_permission()/get_effective_permissions() so the same override-aware
-- resolution logic isn't duplicated a third time by the invariant checks
-- below.
create or replace function private.role_grants_permission(p_org_id uuid, p_role public.app_role, p_permission public.app_permission)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.role_permissions rp
    where rp.role = p_role
      and rp.permission = p_permission
      and (
        rp.organization_id = p_org_id
        or (
          rp.organization_id is null
          and not exists (
            select 1 from public.role_permissions rp_override
            where rp_override.organization_id = p_org_id and rp_override.role = p_role
          )
        )
      )
  );
$$;

create or replace function private.custom_role_grants_permission(p_custom_role_id uuid, p_permission public.app_permission)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.role_permissions rp
    where rp.custom_role_id = p_custom_role_id and rp.permission = p_permission
  );
$$;

-- has_permission(), parameterized by user rather than always auth.uid(), so
-- the same resolution can be reused to check invariants about *other*
-- members of an org (e.g. "does anyone else still hold roles.manage") —
-- not just the caller.
create or replace function private.user_has_permission(p_org_id uuid, p_user_id uuid, p_permission public.app_permission)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.role_assignments ra
    where ra.user_id = p_user_id
      and ra.organization_id = p_org_id
      and ra.valid_from <= now()
      and (ra.valid_until is null or ra.valid_until > now())
      and (
        (ra.role is not null and private.role_grants_permission(p_org_id, ra.role, p_permission))
        or (ra.custom_role_id is not null and private.custom_role_grants_permission(ra.custom_role_id, p_permission))
      )
  );
$$;

create or replace function private.has_permission(p_org_id uuid, p_permission public.app_permission)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.user_has_permission(p_org_id, (select auth.uid()), p_permission);
$$;

-- get_effective_permissions() — same dual-path generalization, still
-- returns setof app_permission (session.ts already handles the PostgREST
-- scalar-array shape this produces).
create or replace function public.get_effective_permissions(p_org_id uuid)
returns setof public.app_permission
language sql
stable
security definer
set search_path = ''
as $$
  select distinct rp.permission
  from public.role_assignments ra
  join public.role_permissions rp
    on (
      (
        ra.role is not null and rp.role = ra.role
        and (
          rp.organization_id = p_org_id
          or (
            rp.organization_id is null
            and not exists (
              select 1 from public.role_permissions rp_override
              where rp_override.organization_id = p_org_id and rp_override.role = ra.role
            )
          )
        )
      )
      or (ra.custom_role_id is not null and rp.custom_role_id = ra.custom_role_id)
    )
  where ra.user_id = (select auth.uid())
    and ra.organization_id = p_org_id
    and ra.valid_from <= now()
    and (ra.valid_until is null or ra.valid_until > now());
$$;

-- ---------------------------------------------------------------------------
-- 4. set_member_role() — accepts a custom role as an alternative to a
--    built-in one. The "last person who can manage roles" invariant is
--    generalized from a literal role = 'admin' check to an actual
--    roles.manage permission resolution, which is strictly more correct
--    (it now also protects an org that customized roles.manage onto a
--    different role or a custom role) and behaves identically for every
--    org that hasn't customized anything, since only the default Admin
--    bundle grants roles.manage out of the box.
-- ---------------------------------------------------------------------------

drop function if exists public.set_member_role(uuid, public.app_role, timestamptz);

create function public.set_member_role(
  p_employee_id uuid,
  p_role public.app_role default null,
  p_valid_until timestamptz default null,
  p_custom_role_id uuid default null
)
returns public.role_assignments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_now timestamptz := clock_timestamp();
  v_employee public.employees;
  v_assignment public.role_assignments;
  v_old_roles jsonb;
  v_target_had_roles_manage boolean;
  v_new_grants_roles_manage boolean;
  v_other_holder_exists boolean;
begin
  if v_actor is null then
    raise exception using errcode = '42501', message = 'You must be signed in to manage roles';
  end if;
  if (p_role is null) = (p_custom_role_id is null) then
    raise exception using errcode = '22023', message = 'Provide exactly one of a built-in role or a custom role';
  end if;

  select * into v_employee
  from public.employees
  where id = p_employee_id
  for update;

  if v_employee.id is null then
    raise exception 'Employee not found';
  end if;
  if not private.has_permission(v_employee.organization_id, 'roles.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to manage roles for this organization';
  end if;
  if v_employee.user_id is null then
    raise exception using errcode = '23514', message = 'The employee must have a linked account before a role can be assigned';
  end if;
  if v_employee.status = 'terminated' then
    raise exception using errcode = '23514', message = 'A terminated employee cannot receive an active role';
  end if;
  if p_valid_until is not null and p_valid_until <= v_now then
    raise exception using errcode = '22023', message = 'Role expiry must be in the future';
  end if;
  if p_custom_role_id is not null and not exists (
    select 1 from public.organization_roles orr
    where orr.id = p_custom_role_id
      and orr.organization_id = v_employee.organization_id
      and orr.is_active
  ) then
    raise exception using errcode = '23514', message = 'That role is not available for this organization';
  end if;
  if exists (
    select 1 from public.role_assignments ra
    where ra.user_id = v_employee.user_id
      and ra.organization_id <> v_employee.organization_id
      and ra.valid_from <= v_now
      and (ra.valid_until is null or ra.valid_until > v_now)
  ) then
    raise exception using errcode = '23514', message = 'The linked account has an active role in another organization';
  end if;

  -- Serialize role replacement and last-roles.manage-holder checks per organization.
  perform pg_advisory_xact_lock(hashtextextended(v_employee.organization_id::text, 73));

  v_target_had_roles_manage := private.user_has_permission(v_employee.organization_id, v_employee.user_id, 'roles.manage');
  v_new_grants_roles_manage := (
    (p_role is not null and private.role_grants_permission(v_employee.organization_id, p_role, 'roles.manage'))
    or (p_custom_role_id is not null and private.custom_role_grants_permission(p_custom_role_id, 'roles.manage'))
  );

  if v_target_had_roles_manage and (not v_new_grants_roles_manage or p_valid_until is not null) then
    select exists (
      select 1
      from public.role_assignments ra
      join public.employees e
        on e.organization_id = ra.organization_id and e.user_id = ra.user_id
      where ra.organization_id = v_employee.organization_id
        and ra.user_id <> v_employee.user_id
        and ra.valid_from <= v_now
        and (ra.valid_until is null or ra.valid_until > v_now)
        and e.status <> 'terminated'
        and (
          (ra.role is not null and private.role_grants_permission(v_employee.organization_id, ra.role, 'roles.manage'))
          or (ra.custom_role_id is not null and private.custom_role_grants_permission(ra.custom_role_id, 'roles.manage'))
        )
    ) into v_other_holder_exists;

    if not v_other_holder_exists then
      raise exception using errcode = '23514', message = 'The last person able to manage roles cannot be demoted or scheduled to expire';
    end if;
  end if;

  select coalesce(jsonb_agg(to_jsonb(ra) order by ra.created_at), '[]'::jsonb)
  into v_old_roles
  from public.role_assignments ra
  where ra.organization_id = v_employee.organization_id
    and ra.user_id = v_employee.user_id
    and (ra.valid_until is null or ra.valid_until > v_now);

  update public.role_assignments
  set valid_until = v_now
  where organization_id = v_employee.organization_id
    and user_id = v_employee.user_id
    and valid_from <= v_now
    and (valid_until is null or valid_until > v_now);

  -- A future scheduled grant must not reactivate after this replacement.
  delete from public.role_assignments
  where organization_id = v_employee.organization_id
    and user_id = v_employee.user_id
    and valid_from > v_now;

  insert into public.role_assignments (
    organization_id, user_id, role, custom_role_id, scope_type, scope_id,
    valid_from, valid_until, granted_by
  ) values (
    v_employee.organization_id, v_employee.user_id, p_role, p_custom_role_id,
    'organization', null, v_now, p_valid_until, v_actor
  )
  returning * into v_assignment;

  perform private.log_audit_event(
    v_employee.organization_id, 'MEMBER_ROLE_CHANGED', 'employee', v_employee.id,
    jsonb_build_object('roles', v_old_roles),
    jsonb_build_object('role_assignment', to_jsonb(v_assignment))
  );
  return v_assignment;
end;
$$;

revoke execute on function public.set_member_role(uuid, public.app_role, timestamptz, uuid) from public, anon;
grant execute on function public.set_member_role(uuid, public.app_role, timestamptz, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. terminate_employee() — same generalization for its "last admin" guard.
--    Every other line is unchanged from 20260828110000_lifecycle_rbac_hardening.sql.
-- ---------------------------------------------------------------------------

create or replace function public.terminate_employee(
  p_employee_id uuid,
  p_termination_date date default current_date,
  p_reason text default null
)
returns public.employees
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_now timestamptz := clock_timestamp();
  v_employee public.employees;
  v_old_employee public.employees;
  v_other_holder_exists boolean;
  v_target_had_roles_manage boolean;
  v_assignments_closed integer := 0;
  v_roles_expired integer := 0;
  v_future_roles_cancelled integer := 0;
  v_onboarding_cancelled integer := 0;
  v_appraisals_cancelled integer := 0;
begin
  if v_actor is null then
    raise exception using errcode = '42501', message = 'You must be signed in to terminate an employee';
  end if;

  select * into v_employee
  from public.employees
  where id = p_employee_id
  for update;

  if v_employee.id is null then
    raise exception 'Employee not found';
  end if;
  if not private.has_permission(v_employee.organization_id, 'employee.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to terminate this employee';
  end if;
  if v_employee.user_id = v_actor then
    raise exception using errcode = '23514', message = 'You cannot terminate your own employee account';
  end if;
  if v_employee.status = 'terminated' then
    raise exception using errcode = '23514', message = 'Employee is already terminated';
  end if;
  if p_termination_date is null or p_termination_date > current_date then
    raise exception using errcode = '22023', message = 'Termination date must be today or earlier';
  end if;
  if v_employee.hire_date is not null and p_termination_date < v_employee.hire_date then
    raise exception using errcode = '22023', message = 'Termination date cannot be before the hire date';
  end if;
  if exists (
    select 1 from public.employee_assignments ea
    where ea.employee_id = v_employee.id
      and ea.end_date is null
      and ea.start_date > p_termination_date
  ) then
    raise exception using errcode = '22023', message = 'Termination date cannot be before the current assignment start date';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_employee.organization_id::text, 73));

  v_target_had_roles_manage := private.user_has_permission(v_employee.organization_id, v_employee.user_id, 'roles.manage');

  if v_target_had_roles_manage then
    select exists (
      select 1
      from public.role_assignments ra
      join public.employees e
        on e.organization_id = ra.organization_id and e.user_id = ra.user_id
      where ra.organization_id = v_employee.organization_id
        and ra.user_id <> v_employee.user_id
        and ra.valid_from <= v_now
        and (ra.valid_until is null or ra.valid_until > v_now)
        and e.status <> 'terminated'
        and (
          (ra.role is not null and private.role_grants_permission(v_employee.organization_id, ra.role, 'roles.manage'))
          or (ra.custom_role_id is not null and private.custom_role_grants_permission(ra.custom_role_id, 'roles.manage'))
        )
    ) into v_other_holder_exists;

    if not v_other_holder_exists then
      raise exception using errcode = '23514', message = 'The last person able to manage roles cannot be terminated';
    end if;
  end if;

  v_old_employee := v_employee;

  update public.employees
  set status = 'terminated',
      termination_date = p_termination_date,
      termination_reason = nullif(btrim(p_reason), '')
  where id = v_employee.id
  returning * into v_employee;

  update public.offboarding_runs
  set final_work_date = p_termination_date
  where employee_id = v_employee.id and status = 'in_progress';

  update public.employee_assignments
  set end_date = p_termination_date
  where employee_id = v_employee.id and end_date is null;
  get diagnostics v_assignments_closed = row_count;

  update public.role_assignments
  set valid_until = v_now
  where organization_id = v_employee.organization_id
    and user_id = v_employee.user_id
    and valid_from <= v_now
    and (valid_until is null or valid_until > v_now);
  get diagnostics v_roles_expired = row_count;

  delete from public.role_assignments
  where organization_id = v_employee.organization_id
    and user_id = v_employee.user_id
    and valid_from > v_now;
  get diagnostics v_future_roles_cancelled = row_count;

  update public.onboarding_tasks
  set status = 'skipped',
      completed_at = v_now,
      completed_by = v_actor,
      completion_data = coalesce(completion_data, '{}'::jsonb)
        || jsonb_build_object('skipped_reason', 'employee_terminated')
  where employee_id = v_employee.id
    and status in ('pending', 'in_progress', 'blocked')
    and run_id in (
      select id from public.onboarding_runs
      where employee_id = v_employee.id and status = 'in_progress'
    );

  update public.onboarding_runs
  set status = 'cancelled', completed_at = v_now
  where employee_id = v_employee.id and status = 'in_progress';
  get diagnostics v_onboarding_cancelled = row_count;

  update public.appraisal_reviewers
  set status = 'skipped'
  where status = 'pending'
    and instance_id in (
      select id from public.appraisal_instances
      where employee_id = v_employee.id
        and status not in ('complete', 'cancelled')
    );

  update public.appraisal_instances
  set status = 'cancelled'
  where employee_id = v_employee.id
    and status not in ('complete', 'cancelled');
  get diagnostics v_appraisals_cancelled = row_count;

  perform private.log_audit_event(
    v_employee.organization_id, 'EMPLOYEE_TERMINATED', 'employee', v_employee.id,
    to_jsonb(v_old_employee),
    to_jsonb(v_employee) || jsonb_build_object(
      'assignments_closed', v_assignments_closed,
      'active_roles_expired', v_roles_expired,
      'future_roles_cancelled', v_future_roles_cancelled,
      'onboarding_runs_cancelled', v_onboarding_cancelled,
      'appraisal_instances_cancelled', v_appraisals_cancelled
    )
  );
  return v_employee;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. set_employee_reporting_scope() — a custom role with team-visibility
--    permissions can lead either relationship tier, same as before for the
--    built-ins (whose supervisor/manager/admin tiering is unchanged).
-- ---------------------------------------------------------------------------

create or replace function public.set_employee_reporting_scope(
  p_leader_employee_id uuid,
  p_report_employee_ids uuid[],
  p_relationship text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_leader public.employees;
  v_report_id uuid;
  v_selected uuid[];
  v_current public.employee_assignments;
  v_updated public.employee_assignments;
  v_desired_leader uuid;
  v_valid_count integer;
  v_changed integer := 0;
  v_custom_can_lead boolean;
begin
  if v_actor is null then
    raise exception using errcode = '42501', message = 'You must be signed in to manage reporting scope';
  end if;
  if p_relationship not in ('supervisor', 'manager') then
    raise exception using errcode = '22023', message = 'Relationship must be supervisor or manager';
  end if;

  select * into v_leader
  from public.employees
  where id = p_leader_employee_id
  for update;

  if v_leader.id is null then
    raise exception using errcode = 'P0002', message = 'Leader employee not found';
  end if;
  if not private.has_permission(v_leader.organization_id, 'employee.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to manage reporting lines for this organization';
  end if;
  if v_leader.user_id is null or v_leader.status = 'terminated' then
    raise exception using errcode = '23514', message = 'The selected leader must have an active employee account';
  end if;

  -- Does an active custom role held by this leader carry team-visibility
  -- permissions? Computed once and OR'd into both tier checks below —
  -- unlike the built-ins, a custom role isn't itself tiered
  -- supervisor-vs-manager, so it satisfies either relationship.
  select exists (
    select 1 from public.role_assignments ra
    where ra.organization_id = v_leader.organization_id
      and ra.user_id = v_leader.user_id
      and ra.custom_role_id is not null
      and ra.valid_from <= now() and (ra.valid_until is null or ra.valid_until > now())
      and (
        private.custom_role_grants_permission(ra.custom_role_id, 'employee.read_team')
        or private.custom_role_grants_permission(ra.custom_role_id, 'employee.read_org')
      )
  ) into v_custom_can_lead;

  if p_relationship = 'manager' and not v_custom_can_lead and not exists (
    select 1 from public.role_assignments ra
    where ra.organization_id = v_leader.organization_id
      and ra.user_id = v_leader.user_id
      and ra.role in ('manager', 'admin')
      and ra.valid_from <= now()
      and (ra.valid_until is null or ra.valid_until > now())
  ) then
    raise exception using errcode = '23514', message = 'Assign the Manager role (or a custom role with team-visibility permissions) before adding manager reports';
  end if;

  if p_relationship = 'supervisor' and not v_custom_can_lead and not exists (
    select 1 from public.role_assignments ra
    where ra.organization_id = v_leader.organization_id
      and ra.user_id = v_leader.user_id
      and ra.role in ('supervisor', 'manager', 'admin')
      and ra.valid_from <= now()
      and (ra.valid_until is null or ra.valid_until > now())
  ) then
    raise exception using errcode = '23514', message = 'Assign the Supervisor or Manager role (or a custom role with team-visibility permissions) before adding supervisor reports';
  end if;

  select coalesce(array_agg(distinct report_id), '{}'::uuid[])
  into v_selected
  from unnest(coalesce(p_report_employee_ids, '{}'::uuid[])) as selected(report_id);

  if cardinality(v_selected) > 500 then
    raise exception using errcode = '22023', message = 'Reporting scope cannot contain more than 500 direct reports';
  end if;
  if p_leader_employee_id = any(v_selected) then
    raise exception using errcode = '23514', message = 'An employee cannot report to themselves';
  end if;

  select count(*) into v_valid_count
  from public.employees e
  where e.id = any(v_selected)
    and e.organization_id = v_leader.organization_id
    and e.status <> 'terminated';

  if v_valid_count <> cardinality(v_selected) then
    raise exception using errcode = '23514', message = 'Every selected report must be an active employee in the same organization';
  end if;
  if exists (
    select 1
    from public.employee_assignments leader_assignment
    where leader_assignment.employee_id = v_leader.id
      and leader_assignment.end_date is null
      and (
        leader_assignment.supervisor_employee_id = any(v_selected)
        or leader_assignment.manager_employee_id = any(v_selected)
      )
  ) then
    raise exception using errcode = '23514', message = 'This selection would create a circular reporting line';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_leader.organization_id::text, 81));

  -- Include both newly selected employees and employees who must be removed
  -- from this leader's current direct-report list.
  for v_report_id in
    select e.id
    from public.employees e
    where e.organization_id = v_leader.organization_id
      and e.id <> v_leader.id
      and (
        e.id = any(v_selected)
        or exists (
          select 1
          from public.employee_assignments ea
          where ea.employee_id = e.id
            and ea.end_date is null
            and (
              (p_relationship = 'supervisor' and ea.supervisor_employee_id = v_leader.id)
              or (p_relationship = 'manager' and ea.manager_employee_id = v_leader.id)
            )
        )
      )
    order by e.id
  loop
    v_desired_leader := case when v_report_id = any(v_selected) then v_leader.id else null end;

    select * into v_current
    from public.employee_assignments
    where employee_id = v_report_id and end_date is null
    for update;

    if v_current.id is null then
      insert into public.employee_assignments (
        organization_id, employee_id, supervisor_employee_id, manager_employee_id,
        start_date, change_reason, created_by
      ) values (
        v_leader.organization_id,
        v_report_id,
        case when p_relationship = 'supervisor' then v_desired_leader else null end,
        case when p_relationship = 'manager' then v_desired_leader else null end,
        current_date,
        'Reporting scope updated',
        v_actor
      )
      returning * into v_updated;
    elsif (
      (p_relationship = 'supervisor' and v_current.supervisor_employee_id is not distinct from v_desired_leader)
      or (p_relationship = 'manager' and v_current.manager_employee_id is not distinct from v_desired_leader)
    ) then
      continue;
    elsif v_current.start_date >= current_date then
      -- There is no earlier effective period to preserve when an assignment
      -- was created today (or staged for the future), so amend that row and
      -- keep its single audit trail instead of manufacturing a zero-day row.
      update public.employee_assignments
      set supervisor_employee_id = case when p_relationship = 'supervisor' then v_desired_leader else supervisor_employee_id end,
          manager_employee_id = case when p_relationship = 'manager' then v_desired_leader else manager_employee_id end,
          change_reason = 'Reporting scope updated',
          created_by = v_actor
      where id = v_current.id
      returning * into v_updated;
    else
      update public.employee_assignments
      set end_date = current_date - 1
      where id = v_current.id;

      insert into public.employee_assignments (
        organization_id, employee_id, org_unit_id, position_id, location_id,
        supervisor_employee_id, manager_employee_id, employment_type,
        start_date, is_primary, change_reason, created_by
      ) values (
        v_current.organization_id,
        v_current.employee_id,
        v_current.org_unit_id,
        v_current.position_id,
        v_current.location_id,
        case when p_relationship = 'supervisor' then v_desired_leader else v_current.supervisor_employee_id end,
        case when p_relationship = 'manager' then v_desired_leader else v_current.manager_employee_id end,
        v_current.employment_type,
        current_date,
        v_current.is_primary,
        'Reporting scope updated',
        v_actor
      )
      returning * into v_updated;
    end if;

    v_changed := v_changed + 1;
    perform private.log_audit_event(
      v_leader.organization_id,
      'EMPLOYEE_REPORTING_LINE_CHANGED',
      'employee_assignment',
      v_updated.id,
      case when v_current.id is null then null else to_jsonb(v_current) end,
      to_jsonb(v_updated)
    );
  end loop;

  perform private.log_audit_event(
    v_leader.organization_id,
    'REPORTING_SCOPE_UPDATED',
    'employee',
    v_leader.id,
    null,
    jsonb_build_object(
      'relationship', p_relationship,
      'direct_report_ids', to_jsonb(v_selected),
      'changed_assignments', v_changed
    )
  );

  return jsonb_build_object(
    'ok', true,
    'relationship', p_relationship,
    'direct_report_count', cardinality(v_selected),
    'changed_assignments', v_changed
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Custom role CRUD — all narrow, audited RPCs (see comment on
--    organization_roles above for why direct table writes aren't allowed).
-- ---------------------------------------------------------------------------

create or replace function public.create_organization_role(
  p_organization_id uuid,
  p_name text,
  p_description text default null,
  p_permissions public.app_permission[] default '{}'
)
returns public.organization_roles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.organization_roles;
  v_permission public.app_permission;
begin
  if not private.has_permission(p_organization_id, 'roles.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to manage roles for this organization';
  end if;
  if char_length(btrim(coalesce(p_name, ''))) = 0 then
    raise exception using errcode = '23514', message = 'Role name is required';
  end if;
  if exists (
    select 1 from public.organization_roles orr
    where orr.organization_id = p_organization_id and lower(orr.name) = lower(btrim(p_name))
  ) then
    raise exception using errcode = '23505', message = 'A role with this name already exists';
  end if;

  insert into public.organization_roles (organization_id, name, description, created_by)
  values (p_organization_id, btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''), auth.uid())
  returning * into v_role;

  foreach v_permission in array coalesce(p_permissions, '{}'::public.app_permission[])
  loop
    insert into public.role_permissions (organization_id, custom_role_id, permission)
    values (p_organization_id, v_role.id, v_permission)
    on conflict do nothing;
  end loop;

  perform private.log_audit_event(
    p_organization_id, 'ORGANIZATION_ROLE_CREATED', 'organization_role', v_role.id,
    null, jsonb_build_object('name', v_role.name, 'permissions', p_permissions)
  );
  return v_role;
end;
$$;

revoke execute on function public.create_organization_role(uuid, text, text, public.app_permission[]) from public, anon;
grant execute on function public.create_organization_role(uuid, text, text, public.app_permission[]) to authenticated;

create or replace function public.update_organization_role(
  p_role_id uuid,
  p_name text,
  p_description text default null
)
returns public.organization_roles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.organization_roles;
  v_old public.organization_roles;
begin
  select * into v_old from public.organization_roles where id = p_role_id for update;
  if v_old.id is null then
    raise exception 'Role not found';
  end if;
  if not private.has_permission(v_old.organization_id, 'roles.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to manage roles for this organization';
  end if;
  if char_length(btrim(coalesce(p_name, ''))) = 0 then
    raise exception using errcode = '23514', message = 'Role name is required';
  end if;
  if exists (
    select 1 from public.organization_roles orr
    where orr.organization_id = v_old.organization_id
      and orr.id <> p_role_id
      and lower(orr.name) = lower(btrim(p_name))
  ) then
    raise exception using errcode = '23505', message = 'A role with this name already exists';
  end if;

  update public.organization_roles
  set name = btrim(p_name), description = nullif(btrim(coalesce(p_description, '')), '')
  where id = p_role_id
  returning * into v_role;

  perform private.log_audit_event(
    v_role.organization_id, 'ORGANIZATION_ROLE_UPDATED', 'organization_role', v_role.id,
    to_jsonb(v_old), to_jsonb(v_role)
  );
  return v_role;
end;
$$;

revoke execute on function public.update_organization_role(uuid, text, text) from public, anon;
grant execute on function public.update_organization_role(uuid, text, text) to authenticated;

-- Replace-all semantics: a custom role's bundle is unambiguous (no rows =
-- zero permissions, unlike a built-in role's org override, which falls
-- back to the global default when empty) — so an empty array is allowed
-- here and simply means the role currently grants nothing.
create or replace function public.set_organization_role_permissions(
  p_role_id uuid,
  p_permissions public.app_permission[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.organization_roles;
  v_old_permissions public.app_permission[];
  v_permission public.app_permission;
begin
  select * into v_role from public.organization_roles where id = p_role_id for update;
  if v_role.id is null then
    raise exception 'Role not found';
  end if;
  if not private.has_permission(v_role.organization_id, 'roles.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to manage roles for this organization';
  end if;

  select coalesce(array_agg(rp.permission order by rp.permission), '{}'::public.app_permission[])
  into v_old_permissions
  from public.role_permissions rp
  where rp.custom_role_id = p_role_id;

  if v_role.is_active and (
    select exists (
      select 1 from public.role_assignments ra
      join public.employees e on e.organization_id = ra.organization_id and e.user_id = ra.user_id
      where ra.custom_role_id = p_role_id
        and ra.valid_from <= now() and (ra.valid_until is null or ra.valid_until > now())
        and e.status <> 'terminated'
    )
  ) and not (coalesce(array_position(p_permissions, 'roles.manage'::public.app_permission), 0) > 0)
    and 'roles.manage'::public.app_permission = any(v_old_permissions)
  then
    -- This role is about to lose roles.manage and currently has active
    -- holders — same "don't strand the org" invariant as set_member_role(),
    -- applied at the bundle level since this can affect many people at once.
    if not exists (
      select 1
      from public.role_assignments ra
      join public.employees e on e.organization_id = ra.organization_id and e.user_id = ra.user_id
      where ra.organization_id = v_role.organization_id
        and ra.valid_from <= now() and (ra.valid_until is null or ra.valid_until > now())
        and e.status <> 'terminated'
        and not (ra.custom_role_id = p_role_id)
        and (
          (ra.role is not null and private.role_grants_permission(v_role.organization_id, ra.role, 'roles.manage'))
          or (ra.custom_role_id is not null and private.custom_role_grants_permission(ra.custom_role_id, 'roles.manage'))
        )
    ) then
      raise exception using errcode = '23514', message = 'This role currently grants the last active roles.manage holder(s) in the organization — removing it would lock everyone out of role management';
    end if;
  end if;

  delete from public.role_permissions where custom_role_id = p_role_id;

  foreach v_permission in array coalesce(p_permissions, '{}'::public.app_permission[])
  loop
    insert into public.role_permissions (organization_id, custom_role_id, permission)
    values (v_role.organization_id, p_role_id, v_permission)
    on conflict do nothing;
  end loop;

  perform private.log_audit_event(
    v_role.organization_id, 'ORGANIZATION_ROLE_PERMISSIONS_UPDATED', 'organization_role', p_role_id,
    jsonb_build_object('permissions', v_old_permissions), jsonb_build_object('permissions', p_permissions)
  );
end;
$$;

revoke execute on function public.set_organization_role_permissions(uuid, public.app_permission[]) from public, anon;
grant execute on function public.set_organization_role_permissions(uuid, public.app_permission[]) to authenticated;

-- Editing one of the 4 built-in roles' bundle for an org (creates/replaces
-- that org's override rows). Unlike a custom role, an empty set here is
-- rejected — deleting every override row would make role_permissions fall
-- straight back through to the global default bundle (see
-- role_grants_permission()'s "or organization_id is null and not exists an
-- override" fallback), silently undoing the very thing the caller asked
-- for. An org that wants a role reduced to nothing should create a custom
-- role instead and stop assigning the built-in one.
create or replace function public.set_default_role_permissions(
  p_organization_id uuid,
  p_role public.app_role,
  p_permissions public.app_permission[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_permissions public.app_permission[];
  v_permission public.app_permission;
begin
  if not private.has_permission(p_organization_id, 'roles.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to manage roles for this organization';
  end if;
  if coalesce(array_length(p_permissions, 1), 0) = 0 then
    raise exception using errcode = '23514', message = 'A built-in role must keep at least one permission — create a custom role instead if you need one with none';
  end if;

  select coalesce(array_agg(rp.permission order by rp.permission), '{}'::public.app_permission[])
  into v_old_permissions
  from public.role_permissions rp
  where rp.organization_id = p_organization_id and rp.role = p_role;

  if not (coalesce(array_position(p_permissions, 'roles.manage'::public.app_permission), 0) > 0)
    and private.role_grants_permission(p_organization_id, p_role, 'roles.manage')
    and exists (
      select 1 from public.role_assignments ra
      join public.employees e on e.organization_id = ra.organization_id and e.user_id = ra.user_id
      where ra.organization_id = p_organization_id and ra.role = p_role
        and ra.valid_from <= now() and (ra.valid_until is null or ra.valid_until > now())
        and e.status <> 'terminated'
    )
  then
    if not exists (
      select 1
      from public.role_assignments ra
      join public.employees e on e.organization_id = ra.organization_id and e.user_id = ra.user_id
      where ra.organization_id = p_organization_id
        and ra.valid_from <= now() and (ra.valid_until is null or ra.valid_until > now())
        and e.status <> 'terminated'
        and not (ra.role = p_role)
        and (
          (ra.role is not null and private.role_grants_permission(p_organization_id, ra.role, 'roles.manage'))
          or (ra.custom_role_id is not null and private.custom_role_grants_permission(ra.custom_role_id, 'roles.manage'))
        )
    ) then
      raise exception using errcode = '23514', message = 'This role currently grants the last active roles.manage holder(s) in the organization — removing it would lock everyone out of role management';
    end if;
  end if;

  delete from public.role_permissions where organization_id = p_organization_id and role = p_role;

  foreach v_permission in array p_permissions
  loop
    insert into public.role_permissions (organization_id, role, permission)
    values (p_organization_id, p_role, v_permission)
    on conflict do nothing;
  end loop;

  perform private.log_audit_event(
    p_organization_id, 'ROLE_PERMISSIONS_OVERRIDDEN', 'role', null,
    jsonb_build_object('role', p_role, 'permissions', v_old_permissions),
    jsonb_build_object('role', p_role, 'permissions', p_permissions)
  );
end;
$$;

revoke execute on function public.set_default_role_permissions(uuid, public.app_role, public.app_permission[]) from public, anon;
grant execute on function public.set_default_role_permissions(uuid, public.app_role, public.app_permission[]) to authenticated;

create or replace function public.reset_default_role_permissions(
  p_organization_id uuid,
  p_role public.app_role
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_permissions public.app_permission[];
begin
  if not private.has_permission(p_organization_id, 'roles.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to manage roles for this organization';
  end if;

  select coalesce(array_agg(rp.permission order by rp.permission), '{}'::public.app_permission[])
  into v_old_permissions
  from public.role_permissions rp
  where rp.organization_id = p_organization_id and rp.role = p_role;

  if coalesce(array_length(v_old_permissions, 1), 0) = 0 then
    return; -- already on the default bundle, nothing to do
  end if;

  -- Compute whether the GLOBAL DEFAULT bundle for this role grants
  -- roles.manage (what we're about to revert to), and if it doesn't while
  -- the current org override does, run the same last-holder check as
  -- set_default_role_permissions().
  if not exists (
    select 1 from public.role_permissions rp
    where rp.organization_id is null and rp.role = p_role and rp.permission = 'roles.manage'
  )
  and 'roles.manage'::public.app_permission = any(v_old_permissions)
  and exists (
    select 1 from public.role_assignments ra
    join public.employees e on e.organization_id = ra.organization_id and e.user_id = ra.user_id
    where ra.organization_id = p_organization_id and ra.role = p_role
      and ra.valid_from <= now() and (ra.valid_until is null or ra.valid_until > now())
      and e.status <> 'terminated'
  ) then
    if not exists (
      select 1
      from public.role_assignments ra
      join public.employees e on e.organization_id = ra.organization_id and e.user_id = ra.user_id
      where ra.organization_id = p_organization_id
        and ra.valid_from <= now() and (ra.valid_until is null or ra.valid_until > now())
        and e.status <> 'terminated'
        and not (ra.role = p_role)
        and (
          (ra.role is not null and private.role_grants_permission(p_organization_id, ra.role, 'roles.manage'))
          or (ra.custom_role_id is not null and private.custom_role_grants_permission(ra.custom_role_id, 'roles.manage'))
        )
    ) then
      raise exception using errcode = '23514', message = 'Reverting this role to its default would remove the last active roles.manage holder(s) in the organization';
    end if;
  end if;

  delete from public.role_permissions where organization_id = p_organization_id and role = p_role;

  perform private.log_audit_event(
    p_organization_id, 'ROLE_PERMISSIONS_RESET_TO_DEFAULT', 'role', null,
    jsonb_build_object('role', p_role, 'permissions', v_old_permissions), null
  );
end;
$$;

revoke execute on function public.reset_default_role_permissions(uuid, public.app_role) from public, anon;
grant execute on function public.reset_default_role_permissions(uuid, public.app_role) to authenticated;

create or replace function public.set_organization_role_active(
  p_role_id uuid,
  p_is_active boolean
)
returns public.organization_roles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.organization_roles;
  v_holder_count integer;
begin
  select * into v_role from public.organization_roles where id = p_role_id for update;
  if v_role.id is null then
    raise exception 'Role not found';
  end if;
  if not private.has_permission(v_role.organization_id, 'roles.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to manage roles for this organization';
  end if;

  if not p_is_active then
    select count(*) into v_holder_count
    from public.role_assignments ra
    where ra.custom_role_id = p_role_id
      and ra.valid_from <= now() and (ra.valid_until is null or ra.valid_until > now());
    if v_holder_count > 0 then
      raise exception using errcode = '23514', message = format('Reassign %s active member(s) off this role before deactivating it', v_holder_count);
    end if;
  end if;

  update public.organization_roles set is_active = p_is_active where id = p_role_id returning * into v_role;

  perform private.log_audit_event(
    v_role.organization_id,
    case when p_is_active then 'ORGANIZATION_ROLE_REACTIVATED' else 'ORGANIZATION_ROLE_DEACTIVATED' end,
    'organization_role', v_role.id, null, jsonb_build_object('is_active', p_is_active)
  );
  return v_role;
end;
$$;

revoke execute on function public.set_organization_role_active(uuid, boolean) from public, anon;
grant execute on function public.set_organization_role_active(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Platform Console — widen the reported "role" column since it can now
--    be a custom role's name, not only an app_role literal. Return shape
--    changes, so this needs drop+create rather than plain replace.
-- ---------------------------------------------------------------------------

drop function if exists public.platform_list_organization_employees(uuid);

create function public.platform_list_organization_employees(p_org_id uuid)
returns table (
  id uuid,
  first_name text,
  last_name text,
  work_email public.citext,
  status text,
  has_account boolean,
  role text
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
        select coalesce(ra.role::text, orr.name)
        from public.role_assignments ra
        left join public.organization_roles orr on orr.id = ra.custom_role_id
        where ra.organization_id = p_org_id and ra.user_id = e.user_id
          and ra.valid_from <= now() and (ra.valid_until is null or ra.valid_until > now())
        limit 1
      )
    from public.employees e
    where e.organization_id = p_org_id
    order by e.last_name;
end;
$$;

revoke all on function public.platform_list_organization_employees(uuid) from public, anon, authenticated;
grant execute on function public.platform_list_organization_employees(uuid) to authenticated;

comment on table public.organization_roles is
  'An organization''s own named roles (e.g. "HR Manager"), each with its own permission bundle via role_permissions.custom_role_id — sits alongside the 4 built-in app_role values, which remain permanent. See set_member_role() for assignment and ARCHITECTURE.md for the full design writeup.';
