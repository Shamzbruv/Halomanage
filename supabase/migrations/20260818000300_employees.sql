-- Halomanage — employees, private PII, effective-dated assignments
-- Ref: PRODUCT_BLUEPRINT.md "Employee Profile"; ARCHITECTURE.md "Use effective-dated records".
--
-- employees != auth.users. auth.users is the login identity; employees is
-- the HR/employment record and can exist before an account is ever created
-- (user_id nullable) — e.g. HR pre-loads a new hire ahead of their start date.

create table public.employees (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid unique references auth.users(id) on delete set null,

  employee_number text not null,
  external_payroll_id text,

  first_name text not null,
  last_name text not null,
  preferred_name text,
  work_email citext,
  work_phone text,

  status text not null default 'prehire'
    check (status in ('prehire', 'active', 'leave', 'suspended', 'terminated')),

  hire_date date,
  probation_end_date date,
  termination_date date,
  termination_reason text,

  avatar_url text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (organization_id, employee_number)
);
alter table public.employees enable row level security;
create index employees_org_idx on public.employees(organization_id);
create index employees_user_idx on public.employees(user_id);
create index employees_status_idx on public.employees(organization_id, status);
create trigger employees_set_updated_at
  before update on public.employees
  for each row execute function private.set_updated_at();

comment on table public.employees is
  'Directory-level employment record. Sensitive PII lives in employee_private, not here, so a wider audience can safely read this table.';

-- Sensitive PII, deliberately a separate table so it can be permissioned
-- independently of the ordinary employee directory (ARCHITECTURE.md rule #3
-- in README.md: "Manager should not automatically equal HR").
create table public.employee_private (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  personal_email citext,
  personal_phone text,
  date_of_birth date,
  gender text,
  marital_status text,
  national_id text,
  address_line1 text,
  address_line2 text,
  city text,
  region text,
  country_code text,
  postal_code text,
  emergency_contact_name text,
  emergency_contact_phone text,
  emergency_contact_relationship text,
  bank_account_last4 text,
  notes text,
  updated_at timestamptz not null default now()
);
alter table public.employee_private enable row level security;
create index employee_private_org_idx on public.employee_private(organization_id);
create trigger employee_private_set_updated_at
  before update on public.employee_private
  for each row execute function private.set_updated_at();

-- Effective-dated employment facts: department, position, supervisor,
-- manager, location. Never mutated in place — a change closes the current
-- row (end_date) and opens a new one, so historical reporting stays correct
-- (moving John from Sales to Operations must not rewrite last year's Sales
-- report as if he'd always been in Operations).
create table public.employee_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  org_unit_id uuid references public.org_units(id) on delete set null,
  position_id uuid references public.positions(id) on delete set null,
  location_id uuid references public.locations(id) on delete set null,
  supervisor_employee_id uuid references public.employees(id) on delete set null,
  manager_employee_id uuid references public.employees(id) on delete set null,
  employment_type text
    check (employment_type in ('full_time', 'part_time', 'contract', 'temporary', 'intern')),
  start_date date not null,
  end_date date,
  is_primary boolean not null default true,
  change_reason text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  check (end_date is null or end_date >= start_date)
);
alter table public.employee_assignments enable row level security;
create index employee_assignments_employee_idx on public.employee_assignments(employee_id, start_date desc);
create index employee_assignments_org_idx on public.employee_assignments(organization_id);
create index employee_assignments_supervisor_idx on public.employee_assignments(supervisor_employee_id) where end_date is null;
create index employee_assignments_manager_idx on public.employee_assignments(manager_employee_id) where end_date is null;
create index employee_assignments_org_unit_idx on public.employee_assignments(org_unit_id) where end_date is null;
-- Only one open (current) assignment per employee at a time.
create unique index employee_assignments_one_open
  on public.employee_assignments(employee_id)
  where end_date is null;

comment on table public.employee_assignments is
  'Effective-dated department/position/reporting-line history. The row with end_date IS NULL is the current assignment.';

-- Convenience view: each employee's current assignment, joined out for
-- easy reads. security_invoker so it inherits the caller's RLS, never the
-- view owner's privileges.
create view public.employee_current_assignment_v
  with (security_invoker = true)
as
select
  ea.*,
  e.organization_id as employee_organization_id
from public.employee_assignments ea
join public.employees e on e.id = ea.employee_id
where ea.end_date is null;
