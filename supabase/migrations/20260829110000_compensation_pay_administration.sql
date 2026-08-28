-- Halomanage — Compensation & Pay Administration (Phase 2)
--
-- Scope reminder (see the user-facing audit this responds to): Halomanage
-- manages compensation structure, pay calendars, and time/payroll
-- readiness. It never computes gross-to-net, tax, or statutory deductions,
-- and pay-calendar/period generation here is scheduling — plain date
-- arithmetic — never payroll calculation.
--
-- ============================================================================
-- 1. EFFECTIVE PERMISSIONS RPC — the frontend has had no concept of resolved
--    permissions at all (every admin page gates on role, e.g. admin/payroll
--    checking session.roles.includes("admin") instead of the payroll.import
--    permission the underlying RPCs already enforce). This is the
--    foundational fix everything else in this migration depends on for its
--    UI to gate correctly instead of by role.
-- ============================================================================

create or replace function public.get_effective_permissions(p_org_id uuid)
returns setof public.app_permission
language sql
stable
security definer
set search_path = ''
as $$
  select distinct rp.permission
  from public.role_assignments ra
  join public.role_permissions rp on rp.role = ra.role
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
  where ra.user_id = (select auth.uid())
    and ra.organization_id = p_org_id
    and ra.valid_from <= now()
    and (ra.valid_until is null or ra.valid_until > now());
$$;

revoke all on function public.get_effective_permissions(uuid) from public, anon;
grant execute on function public.get_effective_permissions(uuid) to authenticated;

-- ============================================================================
-- 2. PAY GROUPS
-- ============================================================================

create table public.pay_groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  code text not null,
  currency text not null default 'USD',
  pay_frequency text not null
    check (pay_frequency in ('weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'annual', 'custom')),
  pay_calendar_id uuid, -- FK added after pay_calendars exists, below
  external_provider_reference text,
  default_standard_weekly_hours numeric(5,2),
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code)
);
alter table public.pay_groups enable row level security;
create index pay_groups_org_idx on public.pay_groups(organization_id);
create trigger pay_groups_set_updated_at before update on public.pay_groups
  for each row execute function private.set_updated_at();

comment on table public.pay_groups is
  'Employer-configurable pay group: currency, cadence, and which pay calendar governs it. pay_calendar_id is the source of truth for which calendar a group currently uses.';

-- ============================================================================
-- 3. PAY CALENDARS + PAY PERIODS
-- ============================================================================

create table public.pay_calendars (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  pay_group_id uuid references public.pay_groups(id) on delete set null,
  name text not null,
  pay_frequency text not null
    check (pay_frequency in ('weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'annual', 'custom')),
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.pay_calendars enable row level security;
create index pay_calendars_org_idx on public.pay_calendars(organization_id);
create trigger pay_calendars_set_updated_at before update on public.pay_calendars
  for each row execute function private.set_updated_at();

comment on table public.pay_calendars is
  'Scheduling only. pay_group_id here is informational (a calendar built for one specific group) — pay_groups.pay_calendar_id is what actually governs which calendar a group uses.';

alter table public.pay_groups
  add constraint pay_groups_pay_calendar_id_fkey
  foreign key (pay_calendar_id) references public.pay_calendars(id) on delete set null;
create index pay_groups_pay_calendar_idx on public.pay_groups(pay_calendar_id) where pay_calendar_id is not null;

create table public.pay_periods (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  pay_calendar_id uuid not null references public.pay_calendars(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  timesheet_cutoff_at timestamptz,
  approval_deadline_at timestamptz,
  payroll_export_deadline_at timestamptz,
  pay_date date not null,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'open', 'locked', 'exported', 'closed', 'canceled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (period_end >= period_start)
);
alter table public.pay_periods enable row level security;
create index pay_periods_calendar_idx on public.pay_periods(pay_calendar_id, period_start desc);
create index pay_periods_org_idx on public.pay_periods(organization_id, pay_date);
create unique index pay_periods_no_overlap on public.pay_periods(pay_calendar_id, period_start);
create trigger pay_periods_set_updated_at before update on public.pay_periods
  for each row execute function private.set_updated_at();

-- Pure date-arithmetic scheduling helper — never touches money. HR can
-- still hand-edit any generated row afterward (e.g. shifting a pay date
-- around a holiday) through the plain pay_calendar.manage RLS policy below.
create or replace function public.generate_pay_periods(
  p_pay_calendar_id uuid,
  p_first_period_start date,
  p_number_of_periods integer,
  p_pay_date_offset_days integer default 5,
  p_timesheet_cutoff_offset_days integer default 1,
  p_approval_deadline_offset_days integer default 2,
  p_export_deadline_offset_days integer default 3
)
returns setof public.pay_periods
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_calendar public.pay_calendars;
  v_start date := p_first_period_start;
  v_end date;
  v_row public.pay_periods;
  i integer;
begin
  select * into v_calendar from public.pay_calendars where id = p_pay_calendar_id;
  if v_calendar.id is null then
    raise exception 'Pay calendar not found';
  end if;
  if not private.has_permission(v_calendar.organization_id, 'pay_calendar.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to manage this organization''s pay calendars';
  end if;
  if p_number_of_periods is null or p_number_of_periods < 1 or p_number_of_periods > 366 then
    raise exception using errcode = '22023', message = 'Number of periods must be between 1 and 366';
  end if;

  for i in 1..p_number_of_periods loop
    v_end := case v_calendar.pay_frequency
      when 'weekly' then v_start + 6
      when 'biweekly' then v_start + 13
      -- Assumes an aligned first_period_start (the 1st or 16th) for clean
      -- 1st-15th / 16th-end-of-month periods; HR can hand-edit any row.
      when 'semimonthly' then
        case when extract(day from v_start) <= 1
          then (date_trunc('month', v_start) + interval '14 days')::date
          else (date_trunc('month', v_start) + interval '1 month - 1 day')::date
        end
      when 'monthly' then (date_trunc('month', v_start) + interval '1 month - 1 day')::date
      when 'quarterly' then (date_trunc('quarter', v_start) + interval '3 months - 1 day')::date
      when 'annual' then (date_trunc('year', v_start) + interval '1 year - 1 day')::date
      else v_start + 13 -- 'custom': a placeholder length HR edits directly afterward
    end;

    insert into public.pay_periods (
      organization_id, pay_calendar_id, period_start, period_end,
      timesheet_cutoff_at, approval_deadline_at, payroll_export_deadline_at, pay_date, status
    ) values (
      v_calendar.organization_id, p_pay_calendar_id, v_start, v_end,
      (v_end + p_timesheet_cutoff_offset_days)::timestamptz,
      (v_end + p_approval_deadline_offset_days)::timestamptz,
      (v_end + p_export_deadline_offset_days)::timestamptz,
      v_end + p_pay_date_offset_days,
      'scheduled'
    )
    returning * into v_row;

    return next v_row;
    v_start := v_end + 1;
  end loop;

  perform private.log_audit_event(
    v_calendar.organization_id, 'PAY_PERIODS_GENERATED', 'pay_calendar', p_pay_calendar_id, null,
    jsonb_build_object('count', p_number_of_periods, 'first_period_start', p_first_period_start)
  );
  return;
end;
$$;

revoke all on function public.generate_pay_periods(uuid, date, integer, integer, integer, integer, integer) from public, anon;
grant execute on function public.generate_pay_periods(uuid, date, integer, integer, integer, integer, integer) to authenticated;

-- ============================================================================
-- 4. PAY GRADES / RANGES (positions.grade stays as free text for anyone not
--    ready to adopt structured grades yet; pay_grade_id is the structured
--    path forward)
-- ============================================================================

create table public.pay_grades (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  code text,
  level text,
  location_id uuid references public.locations(id) on delete set null,
  currency text not null default 'USD',
  rate_unit text check (rate_unit in ('hour', 'day', 'week', 'month', 'year')),
  minimum_amount numeric(14,2),
  midpoint_amount numeric(14,2),
  maximum_amount numeric(14,2),
  effective_start date not null default current_date,
  effective_end date,
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_end is null or effective_end >= effective_start),
  check (minimum_amount is null or midpoint_amount is null or minimum_amount <= midpoint_amount),
  check (midpoint_amount is null or maximum_amount is null or midpoint_amount <= maximum_amount),
  check (minimum_amount is null or maximum_amount is null or minimum_amount <= maximum_amount)
);
alter table public.pay_grades enable row level security;
create index pay_grades_org_idx on public.pay_grades(organization_id);
create trigger pay_grades_set_updated_at before update on public.pay_grades
  for each row execute function private.set_updated_at();

alter table public.positions add column if not exists pay_grade_id uuid references public.pay_grades(id) on delete set null;
create index if not exists positions_pay_grade_idx on public.positions(pay_grade_id) where pay_grade_id is not null;

-- ============================================================================
-- 5. COMPENSATION COMPONENTS + effective-dated employee assignments
-- ============================================================================

create table public.compensation_components (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  code text not null,
  component_type text not null
    check (component_type in ('base_salary', 'allowance', 'premium', 'bonus', 'commission', 'other')),
  recurrence text not null check (recurrence in ('recurring', 'one_time')),
  value_type text not null check (value_type in ('fixed_amount', 'percentage')),
  default_amount numeric(14,2),
  default_percentage numeric(6,3),
  payable_to text not null default 'employee' check (payable_to in ('employee', 'employer_cost')),
  external_payroll_code text,
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code),
  check (
    (value_type = 'fixed_amount' and default_percentage is null)
    or (value_type = 'percentage' and default_amount is null)
  )
);
alter table public.compensation_components enable row level security;
create index compensation_components_org_idx on public.compensation_components(organization_id);
create trigger compensation_components_set_updated_at before update on public.compensation_components
  for each row execute function private.set_updated_at();

comment on table public.compensation_components is
  'Configurable pay elements (allowances, premiums, bonuses, commission). Never a tax or net-pay calculator — value_type/default_amount|percentage describe the component, external payroll still computes anything statutory.';

create table public.compensation_change_reasons (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  code text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, name)
);
alter table public.compensation_change_reasons enable row level security;
create index compensation_change_reasons_org_idx on public.compensation_change_reasons(organization_id);

create table public.employee_compensation_components (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  component_id uuid not null references public.compensation_components(id) on delete restrict,
  amount numeric(14,2),
  percentage numeric(6,3),
  currency text not null default 'USD',
  start_date date not null,
  end_date date,
  change_reason_id uuid references public.compensation_change_reasons(id) on delete set null,
  notes text,
  source text not null default 'manual' check (source in ('manual', 'payroll_import')),
  source_batch_id uuid references public.payroll_import_batches(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (end_date is null or end_date >= start_date),
  check (amount is not null or percentage is not null)
);
alter table public.employee_compensation_components enable row level security;
create index employee_comp_components_employee_idx on public.employee_compensation_components(employee_id, start_date desc);
create index employee_comp_components_org_idx on public.employee_compensation_components(organization_id);

-- A recurring component (e.g. a car allowance) can only have one open
-- assignment per employee at a time — mirrors employee_compensation's own
-- "one open row" rule. A one-time component (a single bonus) has no such
-- concept of "current", so this is enforced by trigger rather than a plain
-- partial unique index, which cannot reference another table's column.
create or replace function private.enforce_one_open_recurring_component()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recurrence text;
  v_conflict boolean;
begin
  if new.end_date is not null then
    return new;
  end if;
  select recurrence into v_recurrence from public.compensation_components where id = new.component_id;
  if v_recurrence is distinct from 'recurring' then
    return new;
  end if;
  select exists (
    select 1 from public.employee_compensation_components
    where employee_id = new.employee_id
      and component_id = new.component_id
      and end_date is null
      and id is distinct from new.id
  ) into v_conflict;
  if v_conflict then
    raise exception using errcode = '23514',
      message = 'This employee already has an open assignment of this recurring component — close it before adding a new one';
  end if;
  return new;
end;
$$;

create trigger employee_comp_components_enforce_one_open
  before insert or update on public.employee_compensation_components
  for each row execute function private.enforce_one_open_recurring_component();

-- ============================================================================
-- 6. EMPLOYEE_COMPENSATION — extend, don't replace. The existing table,
--    RLS, and effective-dating pattern are preserved; pay_frequency's old
--    conflated values are backfilled into the new columns below.
-- ============================================================================

alter table public.employee_compensation
  add column if not exists pay_type text,
  add column if not exists pay_type_other_label text,
  add column if not exists rate_unit text,
  add column if not exists standard_weekly_hours numeric(5,2),
  add column if not exists fte numeric(4,3),
  add column if not exists overtime_eligible boolean,
  add column if not exists time_policy_id uuid references public.attendance_policies(id) on delete set null,
  add column if not exists pay_group_id uuid references public.pay_groups(id) on delete set null,
  add column if not exists pay_grade_id uuid references public.pay_grades(id) on delete set null,
  add column if not exists change_reason_id uuid references public.compensation_change_reasons(id) on delete set null,
  add column if not exists change_notes text,
  add column if not exists approved_by uuid references auth.users(id) on delete set null,
  add column if not exists approved_at timestamptz,
  -- Set true by the one-time backfill below wherever pay_type/rate_unit
  -- had to be inferred from the old conflated pay_frequency value — the
  -- Compensation tab prompts HR to confirm/correct these.
  add column if not exists needs_review boolean not null default false;

-- Backfill: the old pay_frequency conflated compensation basis ('hourly',
-- 'annual') with actual payment cadence ('weekly', 'biweekly', ...). This
-- is a best-effort, one-time reconstruction from data that was never rich
-- enough to be perfectly recoverable — every touched row is flagged
-- needs_review rather than silently guessed and left unmarked.
update public.employee_compensation
set pay_type = 'hourly', rate_unit = 'hour', pay_frequency = null, needs_review = true
where pay_frequency = 'hourly' and pay_type is null;

update public.employee_compensation
set pay_type = 'salaried', rate_unit = 'year', pay_frequency = null, needs_review = true
where pay_frequency = 'annual' and pay_type is null;

update public.employee_compensation
set pay_type = 'salaried',
    rate_unit = case pay_frequency when 'semimonthly' then 'month' when 'monthly' then 'month' else 'week' end,
    needs_review = true
where pay_frequency in ('weekly', 'biweekly', 'semimonthly', 'monthly') and pay_type is null;

do $$
declare
  v_org record;
  v_count integer;
begin
  for v_org in select distinct organization_id from public.employee_compensation where needs_review loop
    select count(*) into v_count from public.employee_compensation
    where organization_id = v_org.organization_id and needs_review;
    perform private.log_audit_event(
      v_org.organization_id, 'COMPENSATION_SCHEMA_BACKFILLED', 'organization', v_org.organization_id, null,
      jsonb_build_object('rows_flagged_needs_review', v_count, 'reason', 'pay_type/rate_unit inferred from legacy pay_frequency values')
    );
  end loop;
end $$;

-- pay_frequency's meaning is now cadence-only — replace the old conflated
-- check constraint with the clean vocabulary.
alter table public.employee_compensation drop constraint if exists employee_compensation_pay_frequency_check;
alter table public.employee_compensation
  add constraint employee_compensation_pay_frequency_check
  check (pay_frequency is null or pay_frequency in ('weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'annual', 'custom'));

alter table public.employee_compensation
  add constraint employee_compensation_pay_type_check
  check (pay_type is null or pay_type in (
    'salaried', 'hourly', 'daily', 'weekly_rated', 'monthly_rated', 'piece_rate', 'commission', 'contract_fixed_fee', 'other'
  ));
alter table public.employee_compensation
  add constraint employee_compensation_rate_unit_check
  check (rate_unit is null or rate_unit in ('hour', 'day', 'week', 'month', 'year', 'piece', 'contract'));
alter table public.employee_compensation
  add constraint employee_compensation_fte_check check (fte is null or (fte > 0 and fte <= 2));

create index if not exists employee_compensation_pay_group_idx on public.employee_compensation(pay_group_id) where pay_group_id is not null;
create index if not exists employee_compensation_needs_review_idx on public.employee_compensation(organization_id) where needs_review;

-- ---------------------------------------------------------------------------
-- Manual, effective-dated Change Compensation workflow.
--
-- "submit/approve where approval workflow is enabled" from the audit is
-- deliberately NOT a separate pending-state queue in this phase — either
-- compensation.manage or compensation.approve can call this directly, and
-- the change takes effect immediately (a first-class two-step submit-then-
-- approve queue is documented as follow-up work, not silently skipped).
-- ---------------------------------------------------------------------------

create or replace function public.change_employee_compensation(
  p_employee_id uuid,
  p_amount numeric,
  p_pay_type text,
  p_effective_date date,
  p_currency text default 'USD',
  p_rate_unit text default null,
  p_pay_frequency text default null,
  p_reason_id uuid default null,
  p_notes text default null,
  p_pay_group_id uuid default null,
  p_pay_grade_id uuid default null,
  p_standard_weekly_hours numeric default null,
  p_fte numeric default null,
  p_overtime_eligible boolean default null,
  p_time_policy_id uuid default null,
  p_pay_type_other_label text default null
)
returns public.employee_compensation
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  v_old public.employee_compensation;
  v_new public.employee_compensation;
begin
  select * into v_employee from public.employees where id = p_employee_id for update;
  if v_employee.id is null then
    raise exception 'Employee not found';
  end if;
  if not (
    private.has_permission(v_employee.organization_id, 'compensation.manage')
    or private.has_permission(v_employee.organization_id, 'compensation.approve')
  ) then
    raise exception using errcode = '42501', message = 'Not authorized to change compensation for this organization';
  end if;
  if v_employee.status = 'terminated' then
    raise exception using errcode = '23514', message = 'Cannot change compensation for a terminated employee';
  end if;
  if p_amount is null or p_amount < 0 then
    raise exception using errcode = '22023', message = 'Enter a valid, non-negative amount';
  end if;
  if p_pay_type is null or p_pay_type not in (
    'salaried', 'hourly', 'daily', 'weekly_rated', 'monthly_rated', 'piece_rate', 'commission', 'contract_fixed_fee', 'other'
  ) then
    raise exception using errcode = '22023', message = 'Invalid pay type';
  end if;
  if p_rate_unit is not null and p_rate_unit not in ('hour', 'day', 'week', 'month', 'year', 'piece', 'contract') then
    raise exception using errcode = '22023', message = 'Invalid rate unit';
  end if;
  if p_pay_frequency is not null and p_pay_frequency not in ('weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'annual', 'custom') then
    raise exception using errcode = '22023', message = 'Invalid pay frequency';
  end if;
  if p_effective_date is null then
    raise exception using errcode = '22023', message = 'An effective date is required';
  end if;

  select * into v_old from public.employee_compensation where employee_id = p_employee_id and end_date is null;

  if v_old.id is not null then
    if p_effective_date <= v_old.start_date then
      raise exception using errcode = '22023', message = 'Effective date must be after the current compensation record''s start date';
    end if;
    update public.employee_compensation set end_date = p_effective_date - 1 where id = v_old.id;
  end if;

  insert into public.employee_compensation (
    organization_id, employee_id, amount, currency, pay_type, pay_type_other_label, rate_unit,
    pay_frequency, standard_weekly_hours, fte, overtime_eligible, time_policy_id,
    pay_group_id, pay_grade_id, change_reason_id, change_notes,
    source, start_date, created_by, approved_by, approved_at
  ) values (
    v_employee.organization_id, p_employee_id, p_amount, coalesce(p_currency, 'USD'), p_pay_type, p_pay_type_other_label, p_rate_unit,
    p_pay_frequency, p_standard_weekly_hours, p_fte, p_overtime_eligible, p_time_policy_id,
    p_pay_group_id, p_pay_grade_id, p_reason_id, nullif(trim(p_notes), ''),
    'manual', p_effective_date, (select auth.uid()), (select auth.uid()), now()
  )
  returning * into v_new;

  perform private.log_audit_event(
    v_employee.organization_id, 'COMPENSATION_CHANGED', 'employee', p_employee_id, to_jsonb(v_old), to_jsonb(v_new)
  );

  return v_new;
end;
$$;

revoke all on function public.change_employee_compensation(
  uuid, numeric, text, date, text, text, text, uuid, text, uuid, uuid, numeric, numeric, boolean, uuid, text
) from public, anon;
grant execute on function public.change_employee_compensation(
  uuid, numeric, text, date, text, text, text, uuid, text, uuid, uuid, numeric, numeric, boolean, uuid, text
) to authenticated;

-- ============================================================================
-- 7. RLS — pay_groups / pay_calendars / pay_periods / pay_grades /
--    compensation_components / compensation_change_reasons /
--    employee_compensation_components, and the tightened
--    employee_compensation policy (compensation.* replaces employee.manage).
-- ============================================================================

create policy "read pay groups" on public.pay_groups for select to authenticated
  using (private.has_permission(organization_id, 'compensation.read_org') or private.has_permission(organization_id, 'compensation.manage_structure'));
create policy "manage pay groups" on public.pay_groups for all to authenticated
  using (private.has_permission(organization_id, 'compensation.manage_structure'))
  with check (private.has_permission(organization_id, 'compensation.manage_structure'));

create policy "read pay calendars" on public.pay_calendars for select to authenticated
  using (private.has_permission(organization_id, 'pay_calendar.read') or private.has_permission(organization_id, 'pay_calendar.manage'));
create policy "manage pay calendars" on public.pay_calendars for all to authenticated
  using (private.has_permission(organization_id, 'pay_calendar.manage'))
  with check (private.has_permission(organization_id, 'pay_calendar.manage'));

create policy "read pay periods" on public.pay_periods for select to authenticated
  using (private.has_permission(organization_id, 'pay_calendar.read') or private.has_permission(organization_id, 'pay_calendar.manage'));
create policy "manage pay periods" on public.pay_periods for all to authenticated
  using (private.has_permission(organization_id, 'pay_calendar.manage'))
  with check (private.has_permission(organization_id, 'pay_calendar.manage'));

create policy "read pay grades" on public.pay_grades for select to authenticated
  using (private.is_org_member(organization_id));
create policy "manage pay grades" on public.pay_grades for all to authenticated
  using (private.has_permission(organization_id, 'compensation.manage_structure'))
  with check (private.has_permission(organization_id, 'compensation.manage_structure'));

create policy "read compensation components" on public.compensation_components for select to authenticated
  using (private.is_org_member(organization_id));
create policy "manage compensation components" on public.compensation_components for all to authenticated
  using (private.has_permission(organization_id, 'compensation.manage_structure'))
  with check (private.has_permission(organization_id, 'compensation.manage_structure'));

create policy "read compensation change reasons" on public.compensation_change_reasons for select to authenticated
  using (private.is_org_member(organization_id));
create policy "manage compensation change reasons" on public.compensation_change_reasons for all to authenticated
  using (private.has_permission(organization_id, 'compensation.manage_structure'))
  with check (private.has_permission(organization_id, 'compensation.manage_structure'));

create policy "read own compensation components" on public.employee_compensation_components for select to authenticated
  using (employee_id = private.current_employee_id() and private.has_permission(organization_id, 'compensation.read_self'));
create policy "read team compensation components" on public.employee_compensation_components for select to authenticated
  using (private.has_permission(organization_id, 'compensation.read_team') and private.in_management_scope(employee_id));
create policy "read org compensation components" on public.employee_compensation_components for select to authenticated
  using (private.has_permission(organization_id, 'compensation.read_org'));
create policy "manage compensation components assignments" on public.employee_compensation_components for all to authenticated
  using (private.has_permission(organization_id, 'compensation.manage'))
  with check (private.has_permission(organization_id, 'compensation.manage'));

-- employee_compensation: replace employee.manage as the sole write
-- authority with dedicated compensation.* permissions. Supervisors and
-- Managers get employee.read_team/employee.manage in their default
-- bundles but never compensation.read_team/.manage — access must be
-- granted explicitly, never implied.
drop policy if exists "hr manage compensation history" on public.employee_compensation;
drop policy if exists "hr read compensation history" on public.employee_compensation;
drop policy if exists "read own compensation history" on public.employee_compensation;

create policy "read own compensation history" on public.employee_compensation for select to authenticated
  using (employee_id = private.current_employee_id() and private.has_permission(organization_id, 'compensation.read_self'));
create policy "read team compensation history" on public.employee_compensation for select to authenticated
  using (private.has_permission(organization_id, 'compensation.read_team') and private.in_management_scope(employee_id));
create policy "read org compensation history" on public.employee_compensation for select to authenticated
  using (private.has_permission(organization_id, 'compensation.read_org'));
-- Writes go only through change_employee_compensation() (manual changes)
-- and approve_payroll_import() (compensation-change imports, unchanged) —
-- both SECURITY DEFINER, both already audited. No direct insert/update/
-- delete policy is granted to `authenticated` here, matching the
-- role_assignments write-lockdown pattern already used elsewhere.
revoke insert, update, delete on public.employee_compensation from authenticated;

-- ============================================================================
-- 8. Connect payroll imports to pay groups/periods without touching
--    existing, already-approved batches — nullable, additive columns only.
-- ============================================================================

alter table public.payroll_import_batches
  add column if not exists pay_group_id uuid references public.pay_groups(id) on delete set null,
  add column if not exists pay_period_id uuid references public.pay_periods(id) on delete set null;
create index if not exists payroll_batches_pay_period_idx on public.payroll_import_batches(pay_period_id) where pay_period_id is not null;

-- ============================================================================
-- 9. Default role -> permission bundles for the new permissions.
--    Deliberately: employee gets compensation.read_self; admin gets the
--    org-wide/manage/approve/structure/pay-calendar/export set. Supervisor
--    and Manager get NOTHING new here — compensation access must be an
--    explicit grant, never implied by employee.read_team/employee.manage.
-- ============================================================================

insert into public.role_permissions (organization_id, role, permission) values
  -- Every role independently re-declares its own baseline self-service
  -- permissions in this schema (roles do not inherit from one another —
  -- see how payroll.read_self is listed separately for all four roles
  -- above), so compensation.read_self needs the same explicit repetition:
  -- being a Supervisor/Manager/Admin never removes your own right to see
  -- your own pay.
  (null, 'employee', 'compensation.read_self'),
  (null, 'supervisor', 'compensation.read_self'),
  (null, 'manager', 'compensation.read_self'),
  (null, 'admin', 'compensation.read_self'),

  (null, 'admin', 'compensation.read_org'),
  (null, 'admin', 'compensation.manage'),
  (null, 'admin', 'compensation.approve'),
  (null, 'admin', 'compensation.manage_structure'),
  (null, 'admin', 'pay_calendar.read'),
  (null, 'admin', 'pay_calendar.manage'),
  (null, 'admin', 'payroll.export')
on conflict do nothing;
