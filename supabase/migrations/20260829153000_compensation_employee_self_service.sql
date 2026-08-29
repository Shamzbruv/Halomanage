-- Halomanage — compensation employee self-service repair
--
-- The compensation administration migration created these tables after the
-- repository's earlier one-time `grant ... on all tables` migration. RLS was
-- correct, but the Data API role could not reach the tables at all. Restore
-- table privileges explicitly; RLS remains the authority for every row.

grant select, insert, update, delete on table
  public.pay_groups,
  public.pay_calendars,
  public.pay_periods,
  public.pay_grades,
  public.compensation_components,
  public.compensation_change_reasons,
  public.employee_compensation_components
to authenticated;

-- These helpers deliberately use the employee + organization pair instead
-- of private.current_employee_id(), whose legacy implementation returns the
-- first employee record for a user. That keeps the self-service policies
-- tenant-safe even if one account later belongs to more than one workspace.
create or replace function private.current_employee_uses_pay_group(
  p_organization_id uuid,
  p_pay_group_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.employees e
    join public.employee_compensation ec
      on ec.employee_id = e.id
     and ec.organization_id = e.organization_id
    where e.user_id = (select auth.uid())
      and e.organization_id = p_organization_id
      and ec.pay_group_id = p_pay_group_id
      and ec.start_date <= current_date
      and (ec.end_date is null or ec.end_date >= current_date)
      and private.has_permission(p_organization_id, 'compensation.read_self')
  );
$$;

create or replace function private.current_employee_uses_pay_calendar(
  p_organization_id uuid,
  p_pay_calendar_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.employees e
    join public.employee_compensation ec
      on ec.employee_id = e.id
     and ec.organization_id = e.organization_id
    join public.pay_groups pg
      on pg.id = ec.pay_group_id
     and pg.organization_id = ec.organization_id
    where e.user_id = (select auth.uid())
      and e.organization_id = p_organization_id
      and pg.pay_calendar_id = p_pay_calendar_id
      and ec.start_date <= current_date
      and (ec.end_date is null or ec.end_date >= current_date)
      and private.has_permission(p_organization_id, 'compensation.read_self')
  );
$$;

drop policy if exists "employees read own effective pay group" on public.pay_groups;
create policy "employees read own effective pay group"
on public.pay_groups
for select
to authenticated
using (private.current_employee_uses_pay_group(organization_id, id));

drop policy if exists "employees read own effective pay calendar" on public.pay_calendars;
create policy "employees read own effective pay calendar"
on public.pay_calendars
for select
to authenticated
using (private.current_employee_uses_pay_calendar(organization_id, id));

drop policy if exists "employees read own effective pay periods" on public.pay_periods;
create policy "employees read own effective pay periods"
on public.pay_periods
for select
to authenticated
using (private.current_employee_uses_pay_calendar(organization_id, pay_calendar_id));

-- Calendar creation and pay-group wiring used to be two browser writes. A
-- failed second write left a calendar that looked assigned in one direction
-- while pay_groups.pay_calendar_id (the documented source of truth) stayed
-- null. This RPC validates, locks, creates, links, and audits in one database
-- transaction.
create or replace function public.create_pay_calendar(
  p_organization_id uuid,
  p_name text,
  p_pay_frequency text,
  p_pay_group_id uuid default null
)
returns public.pay_calendars
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_group public.pay_groups;
  v_calendar public.pay_calendars;
  v_previous_calendar_id uuid;
begin
  if not private.has_permission(p_organization_id, 'pay_calendar.manage') then
    raise exception using errcode = '42501',
      message = 'Not authorized to manage this organization''s pay calendars';
  end if;

  if nullif(btrim(p_name), '') is null or char_length(btrim(p_name)) > 120 then
    raise exception using errcode = '22023',
      message = 'Calendar name must be between 1 and 120 characters';
  end if;

  if p_pay_frequency is null or p_pay_frequency not in (
    'weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'annual', 'custom'
  ) then
    raise exception using errcode = '22023', message = 'Invalid pay frequency';
  end if;

  if p_pay_group_id is not null then
    if not private.has_permission(p_organization_id, 'compensation.manage_structure') then
      raise exception using errcode = '42501',
        message = 'Not authorized to assign a pay calendar to a pay group';
    end if;

    select * into v_group
    from public.pay_groups
    where id = p_pay_group_id
    for update;

    if v_group.id is null or v_group.organization_id <> p_organization_id then
      raise exception using errcode = '22023',
        message = 'Pay group was not found in this organization';
    end if;
    if not v_group.is_active then
      raise exception using errcode = '23514', message = 'An inactive pay group cannot be assigned a new calendar';
    end if;
    if v_group.pay_frequency <> p_pay_frequency then
      raise exception using errcode = '22023',
        message = 'Calendar frequency must match the selected pay group';
    end if;

    v_previous_calendar_id := v_group.pay_calendar_id;
  end if;

  insert into public.pay_calendars (
    organization_id,
    pay_group_id,
    name,
    pay_frequency,
    created_by
  ) values (
    p_organization_id,
    p_pay_group_id,
    btrim(p_name),
    p_pay_frequency,
    (select auth.uid())
  )
  returning * into v_calendar;

  if p_pay_group_id is not null then
    update public.pay_groups
    set pay_calendar_id = v_calendar.id
    where id = p_pay_group_id;
  end if;

  perform private.log_audit_event(
    p_organization_id,
    'PAY_CALENDAR_CREATED',
    'pay_calendar',
    v_calendar.id,
    null,
    to_jsonb(v_calendar) || jsonb_build_object(
      'linked_pay_group_id', p_pay_group_id,
      'previous_pay_calendar_id', v_previous_calendar_id
    )
  );

  return v_calendar;
end;
$$;

revoke all on function public.create_pay_calendar(uuid, text, text, uuid) from public, anon;
grant execute on function public.create_pay_calendar(uuid, text, text, uuid) to authenticated;
