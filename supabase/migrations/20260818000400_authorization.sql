-- Halomanage — RBAC (role + scoped permission) and RLS for the foundation tables
-- Ref: PRODUCT_BLUEPRINT.md "Permission model: Role + relationship + scope + action";
--      ARCHITECTURE.md "RBAC model".
--
-- Model: role_assignments gives a user a broad role (employee/supervisor/
-- manager/admin) scoped to an organization. role_permissions maps
-- role -> fine-grained permission, with an org-level override so an
-- employer can customize a role's permission bundle without a code change
-- (e.g. splitting "admin" into HR Admin vs System Admin by granting two
-- people the admin role with different role_permissions overrides — or,
-- more simply, by only ever assigning the specific permissions each of
-- those people actually need). management_scope is a precomputed
-- "who can act on whom" table so Supervisor/Manager RLS checks are a fast
-- indexed EXISTS instead of a recursive org-tree walk on every query.

create type public.app_role as enum ('employee', 'supervisor', 'manager', 'admin');

create type public.app_permission as enum (
  'organization.manage',
  'employee.read_self',
  'employee.read_team',
  'employee.read_org',
  'employee.update_self',
  'employee.manage',
  'attendance.clock_self',
  'attendance.read_team',
  'attendance.read_org',
  'attendance.adjust_team',
  'attendance.manage_policies',
  'leave.request_self',
  'leave.approve_direct_reports',
  'leave.approve_unit',
  'leave.manage_policies',
  'onboarding.complete_self',
  'onboarding.manage_team',
  'onboarding.manage_templates',
  'appraisal.complete_self',
  'appraisal.review_direct_reports',
  'appraisal.manage_cycles',
  'documents.read_self',
  'documents.manage_team',
  'documents.manage_org',
  'payroll.read_self',
  'payroll.import',
  'payroll.read_org',
  'assets.manage',
  'training.manage',
  'reports.team',
  'reports.org',
  'roles.manage',
  'audit.read'
);

create table public.role_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null,
  -- 'organization' (whole org) | 'org_unit' | 'employee' (rare: scoped grant over one person)
  scope_type text not null default 'organization'
    check (scope_type in ('organization', 'org_unit', 'employee')),
  scope_id uuid,
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  granted_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  check (valid_until is null or valid_until > valid_from)
);
alter table public.role_assignments enable row level security;
create index role_assignments_lookup_idx on public.role_assignments(user_id, organization_id, role);
create index role_assignments_org_idx on public.role_assignments(organization_id);

create table public.role_permissions (
  id uuid primary key default gen_random_uuid(),
  -- NULL = global default template shipped by Halomanage; non-null = an
  -- organization's override of that role's bundle.
  organization_id uuid references public.organizations(id) on delete cascade,
  role public.app_role not null,
  permission public.app_permission not null,
  created_at timestamptz not null default now(),
  unique (organization_id, role, permission)
);
alter table public.role_permissions enable row level security;
create index role_permissions_org_idx on public.role_permissions(organization_id);

-- Precomputed "who can act on whom" — recomputed whenever employee_assignments
-- change (see trigger in employees history section below). v1 covers direct
-- supervisor/manager relationships; org-subtree recursion for Manager (per
-- PRODUCT_BLUEPRINT.md: "Manager might see the Supervisor's teams underneath
-- them") is a documented future enhancement over the existing org_units
-- hierarchy — it does not require a schema change, only a richer refresh query.
create table public.management_scope (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  scope_reason text not null check (scope_reason in ('supervisor', 'manager')),
  primary key (organization_id, actor_user_id, employee_id, scope_reason)
);
alter table public.management_scope enable row level security;
create index management_scope_actor_idx on public.management_scope(actor_user_id, employee_id);
-- No client-facing policies on management_scope: it is written only by
-- private.refresh_management_scope() (SECURITY DEFINER) and read only from
-- inside other tables' RLS policies via private.in_management_scope().

-- ---------------------------------------------------------------------------
-- Helper functions (private schema: SECURITY DEFINER, empty search_path,
-- never exposed via the Data API). RLS policies call these.
-- ---------------------------------------------------------------------------

create or replace function private.current_employee_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.id
  from public.employees e
  where e.user_id = (select auth.uid())
  limit 1;
$$;

create or replace function private.is_org_member(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.role_assignments ra
    where ra.user_id = (select auth.uid())
      and ra.organization_id = p_org_id
      and ra.valid_from <= now()
      and (ra.valid_until is null or ra.valid_until > now())
  );
$$;

create or replace function private.has_org_role(p_org_id uuid, p_roles public.app_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.role_assignments ra
    where ra.user_id = (select auth.uid())
      and ra.organization_id = p_org_id
      and ra.role = any(p_roles)
      and ra.valid_from <= now()
      and (ra.valid_until is null or ra.valid_until > now())
  );
$$;

-- Effective permission check: does the caller hold ANY active role in this
-- org whose (org-specific override, falling back to the global default)
-- permission bundle includes p_permission?
create or replace function private.has_permission(p_org_id uuid, p_permission public.app_permission)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.role_assignments ra
    where ra.user_id = (select auth.uid())
      and ra.organization_id = p_org_id
      and ra.valid_from <= now()
      and (ra.valid_until is null or ra.valid_until > now())
      and exists (
        select 1
        from public.role_permissions rp
        where rp.role = ra.role
          and rp.permission = p_permission
          and (
            rp.organization_id = p_org_id
            or (
              rp.organization_id is null
              and not exists (
                select 1 from public.role_permissions rp_override
                where rp_override.organization_id = p_org_id
                  and rp_override.role = ra.role
              )
            )
          )
      )
  );
$$;

create or replace function private.in_management_scope(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.management_scope ms
    where ms.actor_user_id = (select auth.uid())
      and ms.employee_id = p_employee_id
  );
$$;

-- Full recompute of management_scope for one organization. Called by a
-- trigger on employee_assignments; cheap enough at MVP scale (thousands of
-- employees), and correctness-first beats a premature incremental design.
create or replace function private.refresh_management_scope(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.management_scope where organization_id = p_org_id;

  insert into public.management_scope (organization_id, actor_user_id, employee_id, scope_reason)
  select ea.organization_id, sup.user_id, ea.employee_id, 'supervisor'
  from public.employee_assignments ea
  join public.employees sup on sup.id = ea.supervisor_employee_id
  where ea.organization_id = p_org_id
    and ea.end_date is null
    and sup.user_id is not null;

  insert into public.management_scope (organization_id, actor_user_id, employee_id, scope_reason)
  select ea.organization_id, mgr.user_id, ea.employee_id, 'manager'
  from public.employee_assignments ea
  join public.employees mgr on mgr.id = ea.manager_employee_id
  where ea.organization_id = p_org_id
    and ea.end_date is null
    and mgr.user_id is not null
  on conflict do nothing;
end;
$$;

create or replace function private.refresh_management_scope_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.refresh_management_scope(coalesce(new.organization_id, old.organization_id));
  return null;
end;
$$;

create trigger employee_assignments_refresh_scope
  after insert or update or delete on public.employee_assignments
  for each row execute function private.refresh_management_scope_trigger();

-- Also refresh when an employee's account gets linked (or unlinked). This
-- matters because the realistic sequence is: HR sets up the org chart
-- (employee_assignments) for a whole team *before* anyone is invited, then
-- invites people afterward. Without this trigger, refresh_management_scope()
-- would have already run against a supervisor with user_id still NULL (its
-- "sup.user_id is not null" filter drops the row), and nothing would ever
-- re-run it once that supervisor's account exists — so they'd never see
-- their reports. Verified against this exact scenario with a scripted
-- pgTAP-equivalent run before shipping this fix.
create or replace function private.refresh_management_scope_on_user_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.user_id is distinct from old.user_id then
    perform private.refresh_management_scope(new.organization_id);
  end if;
  return new;
end;
$$;

create trigger employees_refresh_scope_on_user_link
  after update of user_id on public.employees
  for each row execute function private.refresh_management_scope_on_user_link();

-- Employees may edit their own directory row, but only "self-service"
-- columns — employment facts (status, dates, org id, employee number,
-- payroll linkage, account linkage) can only change through someone
-- holding employee.manage. This is enforced in the database, not just by
-- which UI screen is shown.
create or replace function private.enforce_employee_protected_columns()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- auth.uid() is null outside of an authenticated request context (the
  -- service_role key used by trusted server-side code such as the
  -- invite-employee Edge Function, migrations, or Cron jobs) — those
  -- callers are expected to have already done their own authorization
  -- before reaching the database, so this guard only needs to constrain
  -- ordinary `authenticated` requests from the browser/mobile client.
  if auth.uid() is null or private.has_permission(new.organization_id, 'employee.manage') then
    return new;
  end if;

  if new.organization_id is distinct from old.organization_id
    or new.employee_number is distinct from old.employee_number
    or new.status is distinct from old.status
    or new.hire_date is distinct from old.hire_date
    or new.probation_end_date is distinct from old.probation_end_date
    or new.termination_date is distinct from old.termination_date
    or new.termination_reason is distinct from old.termination_reason
    or new.external_payroll_id is distinct from old.external_payroll_id
    or new.user_id is distinct from old.user_id
  then
    raise exception 'Only an HR administrator can change employment fields';
  end if;

  return new;
end;
$$;

create trigger employees_protect_columns
  before update on public.employees
  for each row execute function private.enforce_employee_protected_columns();

-- ---------------------------------------------------------------------------
-- RLS policies
-- ---------------------------------------------------------------------------

-- organizations
create policy "org members can read their organization"
  on public.organizations for select to authenticated
  using (private.is_org_member(id));
create policy "org admins can update organization settings"
  on public.organizations for update to authenticated
  using (private.has_permission(id, 'organization.manage'))
  with check (private.has_permission(id, 'organization.manage'));

-- org_units / locations / positions: readable by any org member (directory
-- data), manageable only by whoever holds organization.manage.
create policy "org members can read org units" on public.org_units for select to authenticated
  using (private.is_org_member(organization_id));
create policy "admins manage org units" on public.org_units for all to authenticated
  using (private.has_permission(organization_id, 'organization.manage'))
  with check (private.has_permission(organization_id, 'organization.manage'));

create policy "org members can read locations" on public.locations for select to authenticated
  using (private.is_org_member(organization_id));
create policy "admins manage locations" on public.locations for all to authenticated
  using (private.has_permission(organization_id, 'organization.manage'))
  with check (private.has_permission(organization_id, 'organization.manage'));

create policy "org members can read positions" on public.positions for select to authenticated
  using (private.is_org_member(organization_id));
create policy "admins manage positions" on public.positions for all to authenticated
  using (private.has_permission(organization_id, 'organization.manage'))
  with check (private.has_permission(organization_id, 'organization.manage'));

-- employees
create policy "read own employee record" on public.employees for select to authenticated
  using (user_id = (select auth.uid()));
create policy "read direct-report employee records" on public.employees for select to authenticated
  using (
    private.has_permission(organization_id, 'employee.read_team')
    and private.in_management_scope(id)
  );
create policy "read org-wide employee records" on public.employees for select to authenticated
  using (private.has_permission(organization_id, 'employee.read_org'));
create policy "hr manage employee records" on public.employees for select to authenticated
  using (private.has_permission(organization_id, 'employee.manage'));
create policy "insert employee records" on public.employees for insert to authenticated
  with check (private.has_permission(organization_id, 'employee.manage'));
create policy "update employee records" on public.employees for update to authenticated
  using (
    user_id = (select auth.uid())
    or private.has_permission(organization_id, 'employee.manage')
  )
  with check (
    user_id = (select auth.uid())
    or private.has_permission(organization_id, 'employee.manage')
  );
-- Deliberately no delete policy: employees are deactivated (status =
-- 'terminated'), never deleted, so history/audit/payroll-import references
-- stay valid. Hard erasure for data-subject requests is a service_role
-- operation handled outside normal application traffic.

-- employee_private (PII) — self read/write of one's own row, or explicit
-- employee.manage (HR), never implied by Supervisor/Manager.
create policy "read own private info" on public.employee_private for select to authenticated
  using (employee_id = private.current_employee_id());
create policy "hr read private info" on public.employee_private for select to authenticated
  using (private.has_permission(organization_id, 'employee.manage'));
create policy "write own private info" on public.employee_private for insert to authenticated
  with check (employee_id = private.current_employee_id());
create policy "update own private info" on public.employee_private for update to authenticated
  using (employee_id = private.current_employee_id())
  with check (employee_id = private.current_employee_id());
create policy "hr write private info" on public.employee_private for all to authenticated
  using (private.has_permission(organization_id, 'employee.manage'))
  with check (private.has_permission(organization_id, 'employee.manage'));

-- employee_assignments — history is read-scoped like the employee directory;
-- writes (promotions/transfers) require employee.manage.
create policy "read own assignments" on public.employee_assignments for select to authenticated
  using (employee_id = private.current_employee_id());
create policy "read team assignments" on public.employee_assignments for select to authenticated
  using (
    private.has_permission(organization_id, 'employee.read_team')
    and private.in_management_scope(employee_id)
  );
create policy "read org assignments" on public.employee_assignments for select to authenticated
  using (private.has_permission(organization_id, 'employee.read_org'));
create policy "hr read assignments" on public.employee_assignments for select to authenticated
  using (private.has_permission(organization_id, 'employee.manage'));
create policy "hr manage assignments" on public.employee_assignments for all to authenticated
  using (private.has_permission(organization_id, 'employee.manage'))
  with check (private.has_permission(organization_id, 'employee.manage'));

-- role_assignments
create policy "read own role assignments" on public.role_assignments for select to authenticated
  using (user_id = (select auth.uid()));
create policy "admins manage role assignments" on public.role_assignments for all to authenticated
  using (private.has_permission(organization_id, 'roles.manage'))
  with check (private.has_permission(organization_id, 'roles.manage'));

-- role_permissions — org members can read the effective bundle (used to
-- drive frontend navigation); only roles.manage can create org overrides.
-- Global default rows (organization_id is null) are seeded by migrations
-- only — no client insert/update policy matches organization_id is null,
-- so they are effectively read-only to every client.
create policy "read role permission bundles" on public.role_permissions for select to authenticated
  using (organization_id is null or private.is_org_member(organization_id));
create policy "admins override role permissions" on public.role_permissions for all to authenticated
  using (organization_id is not null and private.has_permission(organization_id, 'roles.manage'))
  with check (organization_id is not null and private.has_permission(organization_id, 'roles.manage'));

-- ---------------------------------------------------------------------------
-- Global default role → permission bundles
-- ---------------------------------------------------------------------------

insert into public.role_permissions (organization_id, role, permission) values
  (null, 'employee', 'employee.read_self'),
  (null, 'employee', 'employee.update_self'),
  (null, 'employee', 'attendance.clock_self'),
  (null, 'employee', 'leave.request_self'),
  (null, 'employee', 'onboarding.complete_self'),
  (null, 'employee', 'appraisal.complete_self'),
  (null, 'employee', 'documents.read_self'),
  (null, 'employee', 'payroll.read_self'),

  (null, 'supervisor', 'employee.read_self'),
  (null, 'supervisor', 'employee.update_self'),
  (null, 'supervisor', 'employee.read_team'),
  (null, 'supervisor', 'attendance.clock_self'),
  (null, 'supervisor', 'attendance.read_team'),
  (null, 'supervisor', 'attendance.adjust_team'),
  (null, 'supervisor', 'leave.request_self'),
  (null, 'supervisor', 'leave.approve_direct_reports'),
  (null, 'supervisor', 'onboarding.complete_self'),
  (null, 'supervisor', 'onboarding.manage_team'),
  (null, 'supervisor', 'appraisal.complete_self'),
  (null, 'supervisor', 'appraisal.review_direct_reports'),
  (null, 'supervisor', 'documents.read_self'),
  (null, 'supervisor', 'payroll.read_self'),
  (null, 'supervisor', 'reports.team'),

  (null, 'manager', 'employee.read_self'),
  (null, 'manager', 'employee.update_self'),
  (null, 'manager', 'employee.read_team'),
  (null, 'manager', 'attendance.clock_self'),
  (null, 'manager', 'attendance.read_team'),
  (null, 'manager', 'attendance.adjust_team'),
  (null, 'manager', 'leave.request_self'),
  (null, 'manager', 'leave.approve_direct_reports'),
  (null, 'manager', 'leave.approve_unit'),
  (null, 'manager', 'onboarding.complete_self'),
  (null, 'manager', 'onboarding.manage_team'),
  (null, 'manager', 'appraisal.complete_self'),
  (null, 'manager', 'appraisal.review_direct_reports'),
  (null, 'manager', 'documents.read_self'),
  (null, 'manager', 'payroll.read_self'),
  (null, 'manager', 'reports.team'),

  (null, 'admin', 'organization.manage'),
  (null, 'admin', 'employee.read_self'),
  (null, 'admin', 'employee.update_self'),
  (null, 'admin', 'employee.read_org'),
  (null, 'admin', 'employee.manage'),
  (null, 'admin', 'attendance.clock_self'),
  (null, 'admin', 'attendance.read_org'),
  (null, 'admin', 'attendance.adjust_team'),
  (null, 'admin', 'attendance.manage_policies'),
  (null, 'admin', 'leave.request_self'),
  (null, 'admin', 'leave.approve_unit'),
  (null, 'admin', 'leave.manage_policies'),
  (null, 'admin', 'onboarding.complete_self'),
  (null, 'admin', 'onboarding.manage_team'),
  (null, 'admin', 'onboarding.manage_templates'),
  (null, 'admin', 'appraisal.complete_self'),
  (null, 'admin', 'appraisal.review_direct_reports'),
  (null, 'admin', 'appraisal.manage_cycles'),
  (null, 'admin', 'documents.read_self'),
  (null, 'admin', 'documents.manage_team'),
  (null, 'admin', 'documents.manage_org'),
  (null, 'admin', 'payroll.read_self'),
  (null, 'admin', 'payroll.import'),
  (null, 'admin', 'payroll.read_org'),
  (null, 'admin', 'assets.manage'),
  (null, 'admin', 'training.manage'),
  (null, 'admin', 'reports.team'),
  (null, 'admin', 'reports.org'),
  (null, 'admin', 'roles.manage'),
  (null, 'admin', 'audit.read')
on conflict do nothing;

comment on table public.role_permissions is
  'Default role -> permission bundles (organization_id NULL). An organization can override a role''s bundle by inserting its own rows with its organization_id — see private.has_permission().';
