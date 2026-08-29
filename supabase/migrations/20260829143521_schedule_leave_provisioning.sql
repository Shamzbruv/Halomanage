-- Halomanage -- complete schedule and leave default provisioning.
--
-- A starter workspace already creates useful schedule and leave defaults,
-- but only its owner was enrolled. This migration turns those defaults into
-- durable organization behaviour: every active employee is provisioned,
-- administrators get audited schedule RPCs, and reruns cannot duplicate an
-- open assignment or an opening leave entitlement.

-- ---------------------------------------------------------------------------
-- Work-schedule defaults and integrity
-- ---------------------------------------------------------------------------

alter table public.work_schedules
  add column if not exists is_default boolean not null default false;

-- Every existing organization needs one active schedule before we can select
-- a default. Organizations created by older flows may have none at all.
insert into public.work_schedules (organization_id, name, description, is_active)
select o.id, 'Standard work week', 'Monday to Friday, 9:00 AM to 5:00 PM', true
from public.organizations o
where not exists (
  select 1
  from public.work_schedules ws
  where ws.organization_id = o.id
    and ws.is_active
);

-- Complete an empty standard schedule without disturbing an employer's
-- existing shift pattern.
insert into public.schedule_shifts (
  schedule_id,
  day_of_week,
  start_time,
  end_time,
  break_minutes
)
select ws.id, day_number, time '09:00', time '17:00', 60
from public.work_schedules ws
cross join generate_series(1, 5) as day_number
where lower(ws.name) = 'standard work week'
  and not exists (
    select 1 from public.schedule_shifts ss where ss.schedule_id = ws.id
  );

-- Prefer the starter schedule, then the oldest active schedule. This is
-- deterministic and leaves exactly one default in each organization.
with ranked as (
  select
    ws.id,
    row_number() over (
      partition by ws.organization_id
      order by
        case when lower(ws.name) = 'standard work week' then 0 else 1 end,
        ws.created_at,
        ws.id
    ) as default_rank
  from public.work_schedules ws
  where ws.is_active
)
update public.work_schedules ws
set is_default = (ranked.default_rank = 1)
from ranked
where ws.id = ranked.id;

update public.work_schedules
set is_default = false
where not is_active
  and is_default;

create unique index if not exists work_schedules_one_default_per_org
  on public.work_schedules(organization_id)
  where is_default;

comment on column public.work_schedules.is_default is
  'The schedule automatically assigned to active employees who do not already have an open schedule assignment.';

-- Keep a direct or RPC-created first schedule useful, and serialize default
-- changes before the partial unique index is checked.
create or replace function private.prepare_work_schedule_default()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_default and not new.is_active then
    raise exception using errcode = '23514', message = 'An inactive work schedule cannot be the default';
  end if;

  if new.is_default then
    update public.work_schedules ws
    set is_default = false
    where ws.organization_id = new.organization_id
      and ws.id <> new.id
      and ws.is_default;
  elsif tg_op = 'INSERT'
    and new.is_active
    and not exists (
      select 1
      from public.work_schedules ws
      where ws.organization_id = new.organization_id
        and ws.is_default
    )
  then
    new.is_default := true;
  end if;

  return new;
end;
$$;

drop trigger if exists prepare_work_schedule_default on public.work_schedules;
create trigger prepare_work_schedule_default
before insert or update of is_default, is_active
on public.work_schedules
for each row execute function private.prepare_work_schedule_default();

-- An employee may be actively enrolled in a given leave policy only once.
-- Preserve any duplicate historical rows by closing all but the newest.
with ranked as (
  select
    lpa.id,
    row_number() over (
      partition by lpa.employee_id, lpa.leave_policy_id
      order by lpa.start_date desc, lpa.created_at desc, lpa.id desc
    ) as assignment_rank
  from public.leave_policy_assignments lpa
  where lpa.end_date is null
)
update public.leave_policy_assignments lpa
set end_date = lpa.start_date
from ranked
where lpa.id = ranked.id
  and ranked.assignment_rank > 1;

create unique index if not exists leave_policy_assignments_one_open
  on public.leave_policy_assignments(employee_id, leave_policy_id)
  where end_date is null;

-- A leave type can have only one active default policy. If legacy data has
-- more than one, retain the oldest policy as the deterministic default.
with ranked as (
  select
    lp.id,
    row_number() over (
      partition by lp.organization_id, lp.leave_type_id
      order by lp.created_at, lp.id
    ) as policy_rank
  from public.leave_policies lp
  where lp.is_active
    and lp.is_default
)
update public.leave_policies lp
set is_default = false
from ranked
where lp.id = ranked.id
  and ranked.policy_rank > 1;

create unique index if not exists leave_policies_one_active_default_per_type
  on public.leave_policies(organization_id, leave_type_id)
  where is_active and is_default;

-- Ledger entries remain append-only. An optional key makes system-generated
-- grants retry-safe while leaving manual adjustments and imports unchanged.
alter table public.leave_ledger
  add column if not exists idempotency_key text;

alter table public.leave_ledger
  drop constraint if exists leave_ledger_idempotency_key_length;
alter table public.leave_ledger
  add constraint leave_ledger_idempotency_key_length
  check (idempotency_key is null or char_length(idempotency_key) between 1 and 200);

create unique index if not exists leave_ledger_org_idempotency_key
  on public.leave_ledger(organization_id, idempotency_key)
  where idempotency_key is not null;

comment on column public.leave_ledger.idempotency_key is
  'Stable key used by automated grants/accruals so a retry cannot add the same entitlement twice.';

-- ---------------------------------------------------------------------------
-- Default provisioning
-- ---------------------------------------------------------------------------

create or replace function private.provision_employee_defaults(
  p_employee_id uuid,
  p_actor_user_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  v_schedule_id uuid;
  v_policy record;
  v_effective_date date;
  v_rows integer;
  v_changed boolean := false;
begin
  select e.* into v_employee
  from public.employees e
  where e.id = p_employee_id
  for update;

  if v_employee.id is null or v_employee.status <> 'active' then
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_employee.id::text, 0));
  v_effective_date := coalesce(v_employee.hire_date, current_date);

  select ws.id into v_schedule_id
  from public.work_schedules ws
  where ws.organization_id = v_employee.organization_id
    and ws.is_active
    and ws.is_default
  order by ws.created_at, ws.id
  limit 1;

  if v_schedule_id is not null
    and not exists (
      select 1
      from public.schedule_assignments sa
      where sa.employee_id = v_employee.id
        and sa.end_date is null
    )
  then
    insert into public.schedule_assignments (
      organization_id,
      employee_id,
      schedule_id,
      start_date
    ) values (
      v_employee.organization_id,
      v_employee.id,
      v_schedule_id,
      v_effective_date
    );
    v_changed := true;
  end if;

  for v_policy in
    select
      lp.id,
      lp.leave_type_id,
      lp.name,
      lp.accrual_method,
      lp.accrual_amount,
      lt.balance_tracked
    from public.leave_policies lp
    join public.leave_types lt
      on lt.id = lp.leave_type_id
     and lt.organization_id = lp.organization_id
    where lp.organization_id = v_employee.organization_id
      and lp.is_active
      and lp.is_default
      and lt.is_active
    order by lp.created_at, lp.id
  loop
    insert into public.leave_policy_assignments (
      organization_id,
      employee_id,
      leave_policy_id,
      start_date
    ) values (
      v_employee.organization_id,
      v_employee.id,
      v_policy.id,
      v_effective_date
    )
    on conflict (employee_id, leave_policy_id) where end_date is null
    do nothing;

    get diagnostics v_rows = row_count;
    v_changed := v_changed or v_rows > 0;

    if v_policy.balance_tracked
      and v_policy.accrual_method = 'annual_grant'
      and v_policy.accrual_amount <> 0
      and not exists (
        select 1
        from public.leave_ledger ll
        where ll.employee_id = v_employee.id
          and ll.leave_type_id = v_policy.leave_type_id
          and ll.entry_type = 'grant'
      )
    then
      insert into public.leave_ledger (
        organization_id,
        employee_id,
        leave_type_id,
        entry_type,
        amount,
        effective_date,
        note,
        created_by,
        idempotency_key
      ) values (
        v_employee.organization_id,
        v_employee.id,
        v_policy.leave_type_id,
        'grant',
        v_policy.accrual_amount,
        v_effective_date,
        'Automatic opening entitlement - ' || v_policy.name,
        p_actor_user_id,
        'employee-default-policy:' || v_employee.id::text || ':' || v_policy.id::text
      )
      on conflict (organization_id, idempotency_key) where idempotency_key is not null
      do nothing;

      get diagnostics v_rows = row_count;
      v_changed := v_changed or v_rows > 0;
    end if;
  end loop;

  if v_changed then
    perform private.log_audit_event(
      v_employee.organization_id,
      'EMPLOYEE_DEFAULTS_PROVISIONED',
      'employee',
      v_employee.id,
      null,
      jsonb_build_object(
        'default_schedule_id', v_schedule_id,
        'effective_date', v_effective_date,
        'provisioned_by', p_actor_user_id
      )
    );
  end if;
end;
$$;

create or replace function private.provision_organization_defaults(
  p_organization_id uuid,
  p_actor_user_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee_id uuid;
begin
  for v_employee_id in
    select e.id
    from public.employees e
    where e.organization_id = p_organization_id
      and e.status = 'active'
    order by e.id
  loop
    perform private.provision_employee_defaults(v_employee_id, p_actor_user_id);
  end loop;
end;
$$;

create or replace function private.provision_employee_defaults_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.provision_employee_defaults(new.id, auth.uid());
  return new;
end;
$$;

drop trigger if exists provision_employee_defaults_on_insert on public.employees;
create trigger provision_employee_defaults_on_insert
after insert on public.employees
for each row
when (new.status = 'active')
execute function private.provision_employee_defaults_trigger();

drop trigger if exists provision_employee_defaults_on_activation on public.employees;
create trigger provision_employee_defaults_on_activation
after update of status on public.employees
for each row
when (new.status = 'active' and old.status is distinct from new.status)
execute function private.provision_employee_defaults_trigger();

create or replace function private.provision_schedule_default_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_active and new.is_default then
    perform private.provision_organization_defaults(new.organization_id, auth.uid());
  end if;
  return new;
end;
$$;

drop trigger if exists provision_schedule_default_on_insert on public.work_schedules;
create trigger provision_schedule_default_on_insert
after insert on public.work_schedules
for each row execute function private.provision_schedule_default_trigger();

drop trigger if exists provision_schedule_default_on_update on public.work_schedules;
create trigger provision_schedule_default_on_update
after update of is_default, is_active on public.work_schedules
for each row
when (new.is_active and new.is_default)
execute function private.provision_schedule_default_trigger();

create or replace function private.provision_leave_policy_default_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_active and new.is_default then
    perform private.provision_organization_defaults(new.organization_id, auth.uid());
  end if;
  return new;
end;
$$;

drop trigger if exists provision_leave_policy_default_on_insert on public.leave_policies;
create trigger provision_leave_policy_default_on_insert
after insert on public.leave_policies
for each row execute function private.provision_leave_policy_default_trigger();

drop trigger if exists provision_leave_policy_default_on_update on public.leave_policies;
create trigger provision_leave_policy_default_on_update
after update of is_default, is_active on public.leave_policies
for each row
when (new.is_active and new.is_default)
execute function private.provision_leave_policy_default_trigger();

-- Existing active employees receive defaults now. The function is
-- idempotent, so a failed deployment can safely be retried.
do $$
declare
  v_organization_id uuid;
begin
  for v_organization_id in
    select o.id from public.organizations o order by o.id
  loop
    perform private.provision_organization_defaults(v_organization_id, null);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Audited administrator operations
-- ---------------------------------------------------------------------------

create or replace function public.create_work_schedule(
  p_organization_id uuid,
  p_name text,
  p_description text default null,
  p_is_default boolean default false,
  p_days_of_week smallint[] default array[1, 2, 3, 4, 5]::smallint[],
  p_start_time time default time '09:00',
  p_end_time time default time '17:00',
  p_break_minutes integer default 60
)
returns public.work_schedules
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_schedule public.work_schedules;
begin
  if auth.uid() is null
    or not private.has_permission(p_organization_id, 'attendance.manage_policies')
  then
    raise exception using errcode = '42501', message = 'Not authorized to manage work schedules for this organization';
  end if;

  if nullif(btrim(p_name), '') is null or char_length(btrim(p_name)) > 120 then
    raise exception using errcode = '22023', message = 'Schedule name must be between 1 and 120 characters';
  end if;
  if p_description is not null and char_length(p_description) > 500 then
    raise exception using errcode = '22023', message = 'Schedule description must be 500 characters or fewer';
  end if;
  if p_days_of_week is null
    or cardinality(p_days_of_week) = 0
    or exists (
      select 1 from unnest(p_days_of_week) as day_number
      where day_number not between 0 and 6
    )
  then
    raise exception using errcode = '22023', message = 'Choose at least one valid work day';
  end if;
  if p_start_time is null or p_end_time is null or p_end_time <= p_start_time then
    raise exception using errcode = '22023', message = 'Shift end time must be after its start time';
  end if;
  if p_break_minutes is null or p_break_minutes < 0 or p_break_minutes > 1440 then
    raise exception using errcode = '22023', message = 'Break minutes must be between 0 and 1440';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text, 0));

  if p_is_default then
    update public.work_schedules ws
    set is_default = false
    where ws.organization_id = p_organization_id
      and ws.is_default;
  end if;

  insert into public.work_schedules (
    organization_id,
    name,
    description,
    is_active,
    is_default
  ) values (
    p_organization_id,
    btrim(p_name),
    nullif(btrim(p_description), ''),
    true,
    p_is_default
  )
  returning * into v_schedule;

  insert into public.schedule_shifts (
    schedule_id,
    day_of_week,
    start_time,
    end_time,
    break_minutes
  )
  select
    v_schedule.id,
    day_number,
    p_start_time,
    p_end_time,
    p_break_minutes
  from (
    select distinct unnest(p_days_of_week) as day_number
  ) selected_days
  order by day_number;

  perform private.log_audit_event(
    p_organization_id,
    'WORK_SCHEDULE_CREATED',
    'work_schedule',
    v_schedule.id,
    null,
    to_jsonb(v_schedule) || jsonb_build_object(
      'days_of_week', p_days_of_week,
      'start_time', p_start_time,
      'end_time', p_end_time,
      'break_minutes', p_break_minutes
    )
  );

  return v_schedule;
end;
$$;

create or replace function public.assign_employee_schedule(
  p_employee_id uuid,
  p_schedule_id uuid,
  p_start_date date default current_date
)
returns public.schedule_assignments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  v_schedule public.work_schedules;
  v_current public.schedule_assignments;
  v_result public.schedule_assignments;
begin
  if p_start_date is null then
    raise exception using errcode = '22023', message = 'An effective date is required';
  end if;

  select e.* into v_employee
  from public.employees e
  where e.id = p_employee_id;

  if v_employee.id is null then
    raise exception using errcode = 'P0002', message = 'Employee not found';
  end if;
  if v_employee.status = 'terminated' then
    raise exception using errcode = '23514', message = 'A terminated employee cannot receive a work schedule';
  end if;
  if auth.uid() is null
    or not private.has_permission(v_employee.organization_id, 'attendance.manage_policies')
  then
    raise exception using errcode = '42501', message = 'Not authorized to assign this employee''s work schedule';
  end if;

  select ws.* into v_schedule
  from public.work_schedules ws
  where ws.id = p_schedule_id;

  if v_schedule.id is null
    or v_schedule.organization_id <> v_employee.organization_id
    or not v_schedule.is_active
  then
    raise exception using errcode = '22023', message = 'Choose an active schedule from the employee''s organization';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_employee.id::text, 0));

  select sa.* into v_current
  from public.schedule_assignments sa
  where sa.employee_id = v_employee.id
    and sa.end_date is null
  for update;

  if v_current.id is not null and v_current.schedule_id = v_schedule.id then
    return v_current;
  end if;

  if v_current.id is not null and p_start_date < v_current.start_date then
    raise exception using errcode = '22023',
      message = 'The new schedule cannot start before the current schedule assignment';
  end if;

  if v_current.id is not null and p_start_date = v_current.start_date then
    update public.schedule_assignments
    set schedule_id = v_schedule.id
    where id = v_current.id
    returning * into v_result;
  else
    if v_current.id is not null then
      update public.schedule_assignments
      set end_date = p_start_date - 1
      where id = v_current.id;
    end if;

    insert into public.schedule_assignments (
      organization_id,
      employee_id,
      schedule_id,
      start_date
    ) values (
      v_employee.organization_id,
      v_employee.id,
      v_schedule.id,
      p_start_date
    )
    returning * into v_result;
  end if;

  perform private.log_audit_event(
    v_employee.organization_id,
    'EMPLOYEE_SCHEDULE_ASSIGNED',
    'schedule_assignment',
    v_result.id,
    to_jsonb(v_current),
    to_jsonb(v_result)
  );

  return v_result;
end;
$$;

-- Client table access is read-only; every schedule mutation goes through an
-- audited RPC. RLS still decides which schedule and assignment rows are
-- visible after these explicit Data API grants make the tables reachable.
revoke all on table public.work_schedules from anon, authenticated;
revoke all on table public.schedule_shifts from anon, authenticated;
revoke all on table public.schedule_assignments from anon, authenticated;
grant select on table public.work_schedules to authenticated;
grant select on table public.schedule_shifts to authenticated;
grant select on table public.schedule_assignments to authenticated;

-- These existing leave tables are read by the employee and administrator
-- experiences and were created before newer Supabase projects stopped
-- exposing public tables automatically. Keep the intent explicit.
grant select on table public.leave_policies to authenticated;
grant select on table public.leave_policy_assignments to authenticated;
grant select, insert on table public.leave_ledger to authenticated;

revoke all on function private.prepare_work_schedule_default() from public, anon, authenticated;
revoke all on function private.provision_employee_defaults(uuid, uuid) from public, anon, authenticated;
revoke all on function private.provision_organization_defaults(uuid, uuid) from public, anon, authenticated;
revoke all on function private.provision_employee_defaults_trigger() from public, anon, authenticated;
revoke all on function private.provision_schedule_default_trigger() from public, anon, authenticated;
revoke all on function private.provision_leave_policy_default_trigger() from public, anon, authenticated;

revoke all on function public.create_work_schedule(uuid, text, text, boolean, smallint[], time, time, integer)
  from public, anon, authenticated;
grant execute on function public.create_work_schedule(uuid, text, text, boolean, smallint[], time, time, integer)
  to authenticated;

revoke all on function public.assign_employee_schedule(uuid, uuid, date)
  from public, anon, authenticated;
grant execute on function public.assign_employee_schedule(uuid, uuid, date)
  to authenticated;
