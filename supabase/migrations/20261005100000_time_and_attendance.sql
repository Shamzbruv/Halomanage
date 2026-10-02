-- Halomanage — Time & Attendance as an HR workflow
--
-- From the HR review of Time & Attendance (docs/ARCHITECTURE.md "Time &
-- Attendance"). The punch itself was already sound (server time, one open
-- session, immutable events, corrections as separate rows). This turns the
-- surrounding schema into working behaviour:
--
--  1. Permissions mean what they say: attendance.clock_self is enforced;
--     attendance.read_org no longer approves corrections (new
--     attendance.adjust_org does); nobody approves their own correction.
--  2. Every session snapshots the schedule that applied on its work date
--     (effective-dated assignment → that day's shift → org timezone) and the
--     policy, then classifies arrival with the grace period (on time /
--     within grace / late), early departure, breaks, net worked minutes and
--     overtime. Actual timestamps are never altered to fit policy.
--  3. Overnight shifts (22:00–06:00) are valid; a punch after midnight
--     belongs to the shift that started the evening before.
--  4. Breaks: start_break()/end_break(); worked time = elapsed − unpaid
--     break according to the policy's break_deduction.
--  5. Missing clock-outs: an open session past the policy threshold is
--     flagged for review (or auto-closed if the policy says so — clearly
--     marked, never pretending the employee clocked out).
--  6. Corrections are validated (chronology, future, correction window,
--     one pending per field), re-derive work date and schedule, notify the
--     approvers and then the employee.
--  7. Overtime is classified and, if the policy requires, approved.
--  8. Organization-local dates in the reporting views; schedule assignment
--     and employee provisioning default to the organization's today.
--  9. Day view, exceptions (late, absent, missing clock-out, early
--     departure, unscheduled work, pending overtime/corrections — aware of
--     approved leave and holidays), the employee's own overview, and an HR
--     attendance report.
-- 10. Schedules with per-day hours (incl. overnight) can be saved from the
--     admin UI.
-- Attendance classifies time; it does not calculate pay.

-- ---------------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------------

insert into public.role_permissions (organization_id, role, permission)
select null, 'admin', 'attendance.adjust_org'::public.app_permission
where not exists (
  select 1 from public.role_permissions where organization_id is null and role = 'admin' and permission = 'attendance.adjust_org'
);

-- Organizations that customized the Admin bundle keep the ability to
-- decide corrections if their admins manage attendance policy.
insert into public.role_permissions (organization_id, role, permission)
select distinct rp.organization_id, 'admin'::public.app_role, 'attendance.adjust_org'::public.app_permission
from public.role_permissions rp
where rp.organization_id is not null and rp.role = 'admin' and rp.permission = 'attendance.manage_policies'
  and not exists (
    select 1 from public.role_permissions x
    where x.organization_id = rp.organization_id and x.role = 'admin' and x.permission = 'attendance.adjust_org'
  );

create or replace function private.can_adjust_attendance(p_organization_id uuid, p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_permission(p_organization_id, 'attendance.adjust_org')
    or (private.has_permission(p_organization_id, 'attendance.adjust_team') and private.in_management_scope(p_employee_id));
$$;

create or replace function private.can_view_attendance(p_organization_id uuid, p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_permission(p_organization_id, 'attendance.read_org')
    or private.has_permission(p_organization_id, 'attendance.adjust_org')
    or ((private.has_permission(p_organization_id, 'attendance.read_team') or private.has_permission(p_organization_id, 'attendance.adjust_team'))
        and private.in_management_scope(p_employee_id));
$$;

-- ---------------------------------------------------------------------------
-- 2. Schema
-- ---------------------------------------------------------------------------

-- Overnight shifts: end_time <= start_time means the shift ends the next day.
do $$
declare
  v_name text;
begin
  for v_name in
    select c.conname from pg_constraint c
    where c.conrelid = 'public.schedule_shifts'::regclass and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%end_time > start_time%'
  loop
    execute format('alter table public.schedule_shifts drop constraint %I', v_name);
  end loop;
end $$;
alter table public.schedule_shifts
  add constraint schedule_shifts_nonzero_length check (end_time <> start_time),
  add constraint schedule_shifts_break_range check (break_minutes >= 0 and break_minutes < 1440);
create unique index if not exists schedule_shifts_one_per_day on public.schedule_shifts(schedule_id, day_of_week);

comment on column public.schedule_shifts.end_time is
  'When end_time <= start_time the shift ends on the following day (overnight shift).';

alter table public.attendance_policies
  add column if not exists break_deduction text not null default 'recorded'
    check (break_deduction in ('recorded', 'scheduled', 'none')),
  add column if not exists early_departure_grace_minutes integer not null default 0
    check (early_departure_grace_minutes between 0 and 240),
  add column if not exists correction_window_days integer not null default 30
    check (correction_window_days between 1 and 365),
  add column if not exists missing_clock_out_after_hours numeric(4,1) not null default 16
    check (missing_clock_out_after_hours > 0 and missing_clock_out_after_hours <= 48),
  add column if not exists missing_clock_out_action text not null default 'flag'
    check (missing_clock_out_action in ('flag', 'auto_close'));

update public.attendance_policies set grace_period_minutes = least(greatest(grace_period_minutes, 0), 240)
where grace_period_minutes not between 0 and 240;
alter table public.attendance_policies
  drop constraint if exists attendance_policies_grace_range,
  add constraint attendance_policies_grace_range check (grace_period_minutes between 0 and 240);

comment on column public.attendance_policies.rounding_minutes is 'Reserved — not applied. HaloManage never rounds recorded times.';
comment on column public.attendance_policies.allow_mobile_clock is 'Reserved — not enforced until clock source can be verified server-side.';
comment on column public.attendance_policies.allow_geofencing is 'Reserved — not enforced; browser location is not collected.';
comment on column public.attendance_policies.auto_clock_out_after_hours is 'Superseded by missing_clock_out_after_hours / missing_clock_out_action.';

-- Every organization has a default policy — existing ones now, new ones
-- as they're created (the starter workspace seeding then finds it).
create or replace function private.ensure_default_attendance_policy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.attendance_policies where organization_id = new.id) then
    insert into public.attendance_policies (organization_id, name, is_default, grace_period_minutes)
    values (new.id, 'Standard attendance', true, 10);
  end if;
  return null;
end;
$$;

create trigger organizations_default_attendance_policy
  after insert on public.organizations
  for each row execute function private.ensure_default_attendance_policy();

insert into public.attendance_policies (organization_id, name, is_default, grace_period_minutes)
select o.id, 'Standard attendance', true, 10
from public.organizations o
where not exists (select 1 from public.attendance_policies p where p.organization_id = o.id);
update public.attendance_policies p set is_default = true
where p.id in (
  select distinct on (organization_id) id from public.attendance_policies
  where organization_id not in (select organization_id from public.attendance_policies where is_default)
  order by organization_id, created_at
);

alter table public.attendance_sessions
  add column if not exists schedule_id uuid references public.work_schedules(id) on delete set null,
  add column if not exists schedule_assignment_id uuid references public.schedule_assignments(id) on delete set null,
  add column if not exists scheduled_break_minutes integer,
  add column if not exists policy_id uuid references public.attendance_policies(id) on delete set null,
  add column if not exists grace_period_minutes integer,
  add column if not exists break_deduction text,
  add column if not exists holiday_id uuid references public.holidays(id) on delete set null,
  add column if not exists arrival_status text check (arrival_status in ('on_time', 'within_grace', 'late', 'unscheduled')),
  add column if not exists late_minutes integer not null default 0,
  add column if not exists early_departure_minutes integer not null default 0,
  add column if not exists break_minutes integer not null default 0,
  add column if not exists worked_minutes integer,
  add column if not exists overtime_minutes integer not null default 0,
  add column if not exists overtime_status text not null default 'none'
    check (overtime_status in ('none', 'pending', 'approved', 'rejected')),
  add column if not exists overtime_decided_by uuid references auth.users(id),
  add column if not exists overtime_decided_at timestamptz,
  add column if not exists overtime_note text,
  add column if not exists needs_review boolean not null default false,
  add column if not exists review_reason text;

do $$
declare
  v_name text;
begin
  for v_name in
    select c.conname from pg_constraint c
    where c.conrelid = 'public.attendance_sessions'::regclass and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%status%open%closed%'
  loop
    execute format('alter table public.attendance_sessions drop constraint %I', v_name);
  end loop;
end $$;
alter table public.attendance_sessions
  add constraint attendance_sessions_status_check
  check (status in ('open', 'closed', 'corrected', 'auto_closed', 'missing_out'));

-- A session left open past the threshold becomes 'missing_out' (still no
-- clock-out — nothing is invented) and no longer blocks the next clock-in.
drop index if exists public.attendance_one_open_session;
create unique index attendance_one_open_session
  on public.attendance_sessions(employee_id)
  where clock_out_at is null and status = 'open';

create table public.attendance_breaks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  session_id uuid not null references public.attendance_sessions(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz,
  check (ended_at is null or ended_at >= started_at)
);
alter table public.attendance_breaks enable row level security;
create index attendance_breaks_session_idx on public.attendance_breaks(session_id);
create unique index attendance_breaks_one_open on public.attendance_breaks(session_id) where ended_at is null;
create policy "read own breaks" on public.attendance_breaks for select to authenticated
  using (employee_id = private.current_employee_id());
create policy "read scoped breaks" on public.attendance_breaks for select to authenticated
  using (private.can_view_attendance(organization_id, employee_id));
grant select on public.attendance_breaks to authenticated;

-- One pending correction per session and field.
create unique index if not exists attendance_adjustments_one_pending
  on public.attendance_adjustments(session_id, field) where status = 'pending';

-- Corrections are decided with adjust permissions; reading them org-wide
-- still only needs read_org (reading is not deciding).
drop policy if exists "read team adjustments" on public.attendance_adjustments;
create policy "read team adjustments" on public.attendance_adjustments for select to authenticated
  using (private.can_view_attendance(organization_id, employee_id));

-- Whoever can decide a team member's correction or overtime can also read
-- the record they're deciding on.
drop policy if exists "read scoped attendance" on public.attendance_sessions;
create policy "read scoped attendance" on public.attendance_sessions for select to authenticated
  using (private.can_view_attendance(organization_id, employee_id));
drop policy if exists "read scoped attendance events" on public.attendance_events;
create policy "read scoped attendance events" on public.attendance_events for select to authenticated
  using (private.can_view_attendance(organization_id, employee_id));

-- ---------------------------------------------------------------------------
-- 3. Schedule and policy resolution
-- ---------------------------------------------------------------------------

create or replace function private.org_timezone(p_organization_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select nullif(btrim(o.timezone), '') from public.organizations o where o.id = p_organization_id), 'America/Jamaica');
$$;

-- The shift an employee was scheduled for on a calendar date, from the
-- assignment effective on that date (not today's assignment).
create or replace function private.scheduled_shift(p_employee_id uuid, p_date date)
returns table (assignment_id uuid, schedule_id uuid, start_at timestamptz, end_at timestamptz, break_minutes integer)
language sql
stable
security definer
set search_path = ''
as $$
  select sa.id, sa.schedule_id,
    ((p_date + sh.start_time) at time zone private.org_timezone(sa.organization_id)),
    ((p_date + sh.end_time + case when sh.end_time <= sh.start_time then interval '1 day' else interval '0 days' end)
      at time zone private.org_timezone(sa.organization_id)),
    sh.break_minutes
  from public.schedule_assignments sa
  join public.schedule_shifts sh on sh.schedule_id = sa.schedule_id and sh.day_of_week = extract(dow from p_date)::int
  where sa.employee_id = p_employee_id
    and sa.start_date <= p_date
    and (sa.end_date is null or sa.end_date >= p_date)
  order by sa.start_date desc
  limit 1;
$$;

create or replace function private.has_schedule_on(p_employee_id uuid, p_date date)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.schedule_assignments sa
    where sa.employee_id = p_employee_id and sa.start_date <= p_date and (sa.end_date is null or sa.end_date >= p_date)
  );
$$;

-- Which work date and shift a punch belongs to. A punch after midnight
-- that falls within (or up to 2 hours after) an overnight shift that began
-- the previous evening belongs to that shift.
create or replace function private.resolve_work_shift(p_employee_id uuid, p_organization_id uuid, p_at timestamptz)
returns table (work_date date, assignment_id uuid, schedule_id uuid, start_at timestamptz, end_at timestamptz, break_minutes integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_local date := private.org_local_date(p_organization_id, p_at);
  v_prev record;
begin
  select * into v_prev from private.scheduled_shift(p_employee_id, v_local - 1) s
  where private.org_local_date(p_organization_id, s.end_at) > v_local - 1
    and p_at <= s.end_at + interval '2 hours';
  if found then
    return query select v_local - 1, v_prev.assignment_id, v_prev.schedule_id, v_prev.start_at, v_prev.end_at, v_prev.break_minutes;
    return;
  end if;
  return query
    select v_local, s.assignment_id, s.schedule_id, s.start_at, s.end_at, s.break_minutes
    from (select 1) one
    left join private.scheduled_shift(p_employee_id, v_local) s on true;
end;
$$;

-- The employee's time policy: the one on their current compensation
-- record if set, otherwise the organization default.
create or replace function private.employee_attendance_policy(p_employee_id uuid)
returns public.attendance_policies
language sql
stable
security definer
set search_path = ''
as $$
  select ap.*
  from public.employees e
  left join lateral (
    select c.time_policy_id from public.employee_compensation c
    where c.employee_id = e.id and c.start_date <= private.org_today(e.organization_id)
      and (c.end_date is null or c.end_date >= private.org_today(e.organization_id))
    order by c.start_date desc limit 1
  ) c on true
  join public.attendance_policies ap on ap.organization_id = e.organization_id
    and (c.time_policy_id is null or ap.id = c.time_policy_id)
  where e.id = p_employee_id
  order by (ap.id = c.time_policy_id) desc nulls last, ap.is_default desc, ap.created_at
  limit 1;
$$;

create or replace function private.holiday_on(p_employee_id uuid, p_date date)
returns public.holidays
language sql
stable
security definer
set search_path = ''
as $$
  select h.*
  from public.employees e
  join public.holidays h on h.organization_id = e.organization_id and h.observed_on = p_date
  left join public.employee_assignments a on a.employee_id = e.id and a.end_date is null
  where e.id = p_employee_id and (h.location_id is null or h.location_id = a.location_id)
  order by h.location_id nulls last
  limit 1;
$$;

create or replace function private.approved_leave_on(p_employee_id uuid, p_date date)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select lt.name
  from public.leave_requests r
  join public.leave_types lt on lt.id = r.leave_type_id
  where r.employee_id = p_employee_id and r.status = 'approved' and p_date between r.start_date and r.end_date
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- 4. Classification
-- ---------------------------------------------------------------------------

-- Derives everything about a session from its actual punches, its breaks
-- and its schedule/policy snapshot. p_resnapshot takes a fresh schedule
-- snapshot (at clock-in, and whenever the work date changes, e.g. after a
-- correction); otherwise the snapshot taken at the punch is kept, so later
-- schedule edits never change the meaning of past attendance.
create or replace function private.recompute_attendance_session(p_session_id uuid, p_resnapshot boolean default false)
returns public.attendance_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.attendance_sessions;
  r record;
  p public.attendance_policies;
  v_start timestamptz;
  v_end timestamptz;
  v_sched_break integer;
  v_grace integer;
  v_deduction_mode text;
  v_breaks integer;
  v_deduct integer;
  v_elapsed integer;
  v_worked integer;
  v_sched_net integer;
  v_arrival text;
  v_late integer := 0;
  v_early integer := 0;
  v_ot integer := 0;
  v_ot_status text;
  v_holiday public.holidays;
begin
  select * into s from public.attendance_sessions where id = p_session_id for update;
  if s.id is null then
    return null;
  end if;

  select * into r from private.resolve_work_shift(s.employee_id, s.organization_id, s.clock_in_at);
  p := private.employee_attendance_policy(s.employee_id);

  if p_resnapshot or s.arrival_status is null or r.work_date is distinct from s.work_date then
    v_start := r.start_at;
    v_end := r.end_at;
    v_sched_break := r.break_minutes;
    v_grace := coalesce(p.grace_period_minutes, 0);
    v_deduction_mode := coalesce(p.break_deduction, 'recorded');
    s.schedule_assignment_id := r.assignment_id;
    s.schedule_id := r.schedule_id;
    s.policy_id := p.id;
    s.work_date := r.work_date;
  else
    v_start := s.scheduled_start_at;
    v_end := s.scheduled_end_at;
    v_sched_break := s.scheduled_break_minutes;
    v_grace := coalesce(s.grace_period_minutes, coalesce(p.grace_period_minutes, 0));
    v_deduction_mode := coalesce(s.break_deduction, coalesce(p.break_deduction, 'recorded'));
  end if;

  select coalesce(sum(floor(extract(epoch from (b.ended_at - b.started_at)) / 60)), 0)::integer into v_breaks
  from public.attendance_breaks b where b.session_id = s.id and b.ended_at is not null;

  if v_start is null then
    v_arrival := 'unscheduled';
  elsif s.clock_in_at <= v_start then
    v_arrival := 'on_time';
  elsif s.clock_in_at <= v_start + make_interval(mins => v_grace) then
    v_arrival := 'within_grace';
  else
    v_arrival := 'late';
    v_late := ceil(extract(epoch from (s.clock_in_at - v_start)) / 60)::integer;
  end if;

  v_deduct := case v_deduction_mode
    when 'none' then 0
    when 'scheduled' then greatest(v_breaks, coalesce(v_sched_break, 0))
    else v_breaks
  end;

  if s.clock_out_at is not null then
    v_elapsed := floor(extract(epoch from (s.clock_out_at - s.clock_in_at)) / 60)::integer;
    v_worked := greatest(0, v_elapsed - least(v_deduct, v_elapsed));
    if v_end is not null and s.clock_out_at < v_end - make_interval(mins => coalesce(p.early_departure_grace_minutes, 0)) then
      v_early := ceil(extract(epoch from (v_end - s.clock_out_at)) / 60)::integer;
    end if;
    if v_start is not null then
      v_sched_net := floor(extract(epoch from (v_end - v_start)) / 60)::integer
        - case v_deduction_mode when 'none' then 0 else coalesce(v_sched_break, 0) end;
      v_ot := greatest(0, v_worked - greatest(v_sched_net, 0));
    elsif private.has_schedule_on(s.employee_id, s.work_date) then
      -- Worked on a day the schedule has no shift (a rest day).
      v_ot := v_worked;
    end if;
  end if;

  v_ot_status := case
    when v_ot = 0 then 'none'
    when s.overtime_status in ('approved', 'rejected') and s.overtime_minutes = v_ot then s.overtime_status
    when coalesce(p.overtime_requires_approval, true) then 'pending'
    else 'approved'
  end;

  v_holiday := private.holiday_on(s.employee_id, s.work_date);

  update public.attendance_sessions
  set work_date = s.work_date,
      schedule_assignment_id = s.schedule_assignment_id,
      schedule_id = s.schedule_id,
      policy_id = s.policy_id,
      scheduled_start_at = v_start,
      scheduled_end_at = v_end,
      scheduled_break_minutes = v_sched_break,
      grace_period_minutes = v_grace,
      break_deduction = v_deduction_mode,
      holiday_id = v_holiday.id,
      arrival_status = v_arrival,
      late_minutes = v_late,
      early_departure_minutes = v_early,
      break_minutes = v_breaks,
      worked_minutes = v_worked,
      overtime_minutes = v_ot,
      overtime_status = v_ot_status
  where id = s.id
  returning * into s;
  return s;
end;
$$;

-- Open sessions left past the policy threshold. 'flag' marks them
-- missing_out for review (no clock-out is invented); 'auto_close' closes
-- them at the scheduled end (or the threshold) and says so.
create or replace function private.flag_stale_attendance(p_employee_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  p public.attendance_policies;
  v_hours numeric;
  v_close timestamptz;
  v_count integer := 0;
begin
  for r in
    select s.* from public.attendance_sessions s
    where s.clock_out_at is null and s.status = 'open'
      and (p_employee_id is null or s.employee_id = p_employee_id)
  loop
    p := private.employee_attendance_policy(r.employee_id);
    v_hours := coalesce(p.missing_clock_out_after_hours, 16);
    if now() - r.clock_in_at < make_interval(secs => (v_hours * 3600)::double precision) then
      continue;
    end if;

    if coalesce(p.missing_clock_out_action, 'flag') = 'auto_close' then
      v_close := least(now(), greatest(r.clock_in_at, coalesce(r.scheduled_end_at, r.clock_in_at + make_interval(secs => (v_hours * 3600)::double precision))));
      update public.attendance_breaks set ended_at = greatest(started_at, v_close) where session_id = r.id and ended_at is null;
      update public.attendance_sessions
      set clock_out_at = v_close, clock_out_source = 'auto', status = 'auto_closed', needs_review = true,
          review_reason = 'Closed automatically — no clock-out was recorded. Check the actual end time.'
      where id = r.id;
      insert into public.attendance_events (organization_id, session_id, employee_id, event_type, occurred_at, source)
      values (r.organization_id, r.id, r.employee_id, 'auto_clock_out', v_close, 'auto');
      perform private.recompute_attendance_session(r.id, false);
    else
      update public.attendance_sessions
      set status = 'missing_out', needs_review = true,
          review_reason = 'No clock-out recorded — request a correction with the actual end time.'
      where id = r.id;
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Clock, breaks
-- ---------------------------------------------------------------------------

-- p_location and p_source are accepted for compatibility and ignored:
-- provenance is stamped by the server ('web') — a client can't declare
-- itself a kiosk — and browser location isn't collected or trusted.
create or replace function public.clock_in(p_location jsonb default null, p_source text default 'web')
returns public.attendance_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  v_session public.attendance_sessions;
begin
  select e.* into v_employee from public.employees e
  where e.user_id = (select auth.uid()) and e.status = 'active';
  if v_employee.id is null then
    raise exception using errcode = '42501', message = 'Only an active employee can clock in';
  end if;
  if not private.has_permission(v_employee.organization_id, 'attendance.clock_self') then
    raise exception using errcode = '42501', message = 'Your role doesn''t include clocking in';
  end if;

  perform private.flag_stale_attendance(v_employee.id);

  if exists (
    select 1 from public.attendance_sessions s
    where s.employee_id = v_employee.id and s.clock_out_at is null and s.status = 'open'
  ) then
    raise exception using errcode = '23505', message = 'You''re already clocked in';
  end if;

  insert into public.attendance_sessions (organization_id, employee_id, work_date, clock_in_at, clock_in_source)
  values (v_employee.organization_id, v_employee.id, private.org_today(v_employee.organization_id), now(), 'web')
  returning * into v_session;

  insert into public.attendance_events (organization_id, session_id, employee_id, event_type, occurred_at, source, recorded_by)
  values (v_employee.organization_id, v_session.id, v_employee.id, 'clock_in', v_session.clock_in_at, 'web', auth.uid());

  return private.recompute_attendance_session(v_session.id, true);
end;
$$;

-- Closing an open session doesn't require clock_self: a record that was
-- legitimately started must always be closable.
create or replace function public.clock_out(p_location jsonb default null, p_source text default 'web')
returns public.attendance_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  v_session public.attendance_sessions;
begin
  select e.* into v_employee from public.employees e where e.user_id = (select auth.uid());
  if v_employee.id is null then
    raise exception using errcode = '42501', message = 'No employee record for the current user';
  end if;

  select s.* into v_session from public.attendance_sessions s
  where s.employee_id = v_employee.id and s.clock_out_at is null and s.status = 'open'
  for update;
  if v_session.id is null then
    raise exception using errcode = '23514', message = 'You''re not clocked in';
  end if;

  update public.attendance_breaks set ended_at = now() where session_id = v_session.id and ended_at is null;
  update public.attendance_sessions
  set clock_out_at = now(), clock_out_source = 'web', status = 'closed'
  where id = v_session.id
  returning * into v_session;

  insert into public.attendance_events (organization_id, session_id, employee_id, event_type, occurred_at, source, recorded_by)
  values (v_employee.organization_id, v_session.id, v_employee.id, 'clock_out', v_session.clock_out_at, 'web', auth.uid());

  return private.recompute_attendance_session(v_session.id, false);
end;
$$;

create or replace function private.my_open_session()
returns public.attendance_sessions
language sql
stable
security definer
set search_path = ''
as $$
  select s.* from public.attendance_sessions s
  join public.employees e on e.id = s.employee_id
  where e.user_id = (select auth.uid()) and s.clock_out_at is null and s.status = 'open'
  limit 1;
$$;

create or replace function public.start_break()
returns public.attendance_breaks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.attendance_sessions := private.my_open_session();
  v_break public.attendance_breaks;
begin
  if v_session.id is null then
    raise exception using errcode = '23514', message = 'Clock in before starting a break';
  end if;
  if not private.has_permission(v_session.organization_id, 'attendance.clock_self') then
    raise exception using errcode = '42501', message = 'Your role doesn''t include recording attendance';
  end if;
  if exists (select 1 from public.attendance_breaks where session_id = v_session.id and ended_at is null) then
    raise exception using errcode = '23505', message = 'You''re already on a break';
  end if;
  insert into public.attendance_breaks (organization_id, session_id, employee_id, started_at)
  values (v_session.organization_id, v_session.id, v_session.employee_id, now())
  returning * into v_break;
  insert into public.attendance_events (organization_id, session_id, employee_id, event_type, occurred_at, source, recorded_by)
  values (v_session.organization_id, v_session.id, v_session.employee_id, 'break_start', v_break.started_at, 'web', auth.uid());
  return v_break;
end;
$$;

create or replace function public.end_break()
returns public.attendance_breaks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.attendance_sessions := private.my_open_session();
  v_break public.attendance_breaks;
begin
  if v_session.id is null then
    raise exception using errcode = '23514', message = 'You''re not clocked in';
  end if;
  update public.attendance_breaks set ended_at = now()
  where session_id = v_session.id and ended_at is null
  returning * into v_break;
  if v_break.id is null then
    raise exception using errcode = '23514', message = 'You''re not on a break';
  end if;
  insert into public.attendance_events (organization_id, session_id, employee_id, event_type, occurred_at, source, recorded_by)
  values (v_session.organization_id, v_session.id, v_session.employee_id, 'break_end', v_break.ended_at, 'web', auth.uid());
  perform private.recompute_attendance_session(v_session.id, false);
  return v_break;
end;
$$;

revoke execute on function public.start_break() from public, anon;
revoke execute on function public.end_break() from public, anon;
grant execute on function public.start_break() to authenticated;
grant execute on function public.end_break() to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Corrections
-- ---------------------------------------------------------------------------

create or replace function private.employee_display_name(p_employee_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(nullif(btrim(e.preferred_name), ''), e.first_name) || ' ' || e.last_name from public.employees e where e.id = p_employee_id;
$$;

-- The people who decide this employee's corrections: their supervisor and
-- manager (if they hold attendance.adjust_team), otherwise anyone with
-- attendance.adjust_org.
create or replace function private.attendance_approver_user_ids(p_employee_id uuid)
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_found boolean := false;
  v_user uuid;
begin
  select organization_id into v_org from public.employees where id = p_employee_id;
  for v_user in
    select distinct leader.user_id
    from public.employee_assignments a
    join public.employees leader on leader.id in (a.supervisor_employee_id, a.manager_employee_id)
    where a.employee_id = p_employee_id and a.end_date is null
      and leader.user_id is not null and leader.status <> 'terminated'
      and private.user_has_permission(v_org, leader.user_id, 'attendance.adjust_team')
  loop
    v_found := true;
    return next v_user;
  end loop;
  if not v_found then
    return query
      select distinct e.user_id from public.employees e
      where e.organization_id = v_org and e.user_id is not null and e.status <> 'terminated' and e.id <> p_employee_id
        and private.user_has_permission(v_org, e.user_id, 'attendance.adjust_org');
  end if;
end;
$$;

create or replace function public.request_attendance_adjustment(
  p_session_id uuid,
  p_field text,
  p_requested_value timestamptz,
  p_reason text
)
returns public.attendance_adjustments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.attendance_sessions;
  v_self boolean;
  p public.attendance_policies;
  v_in timestamptz;
  v_out timestamptz;
  v_row public.attendance_adjustments;
  v_user uuid;
begin
  select * into v_session from public.attendance_sessions where id = p_session_id;
  if v_session.id is null then
    raise exception 'Attendance session not found';
  end if;
  if p_field not in ('clock_in_at', 'clock_out_at') then
    raise exception using errcode = '22023', message = 'Choose the clock-in or the clock-out to correct';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception using errcode = '22023', message = 'Give a reason for the correction';
  end if;
  if p_requested_value is null then
    raise exception using errcode = '22023', message = 'Enter the correct time';
  end if;

  v_self := v_session.employee_id = private.current_employee_id();
  if not v_self and not private.can_adjust_attendance(v_session.organization_id, v_session.employee_id) then
    raise exception using errcode = '42501', message = 'Not authorized to request a correction on this record';
  end if;
  if p_field = 'clock_in_at' and v_session.clock_out_at is null and v_session.status = 'open' then
    null; -- correcting the start of the current shift is allowed
  end if;

  if p_requested_value > now() + interval '5 minutes' then
    raise exception using errcode = '22023', message = 'A corrected time can''t be in the future';
  end if;

  p := private.employee_attendance_policy(v_session.employee_id);
  if v_self and v_session.work_date < private.org_today(v_session.organization_id) - coalesce(p.correction_window_days, 30) then
    raise exception using errcode = '22023',
      message = format('Corrections can be requested up to %s days after the work day — ask HR to correct older records', coalesce(p.correction_window_days, 30));
  end if;

  v_in := case when p_field = 'clock_in_at' then p_requested_value else v_session.clock_in_at end;
  v_out := case when p_field = 'clock_out_at' then p_requested_value else v_session.clock_out_at end;
  if v_out is not null and v_out <= v_in then
    raise exception using errcode = '22023', message = 'The clock-out must be after the clock-in';
  end if;
  if v_out is not null and v_out - v_in > interval '24 hours' then
    raise exception using errcode = '22023', message = 'A single attendance record can''t be longer than 24 hours';
  end if;

  if exists (
    select 1 from public.attendance_adjustments a
    where a.session_id = p_session_id and a.field = p_field and a.status = 'pending'
  ) then
    raise exception using errcode = '23505', message = 'There''s already a pending correction for this time — wait for a decision or withdraw it';
  end if;

  insert into public.attendance_adjustments (
    organization_id, employee_id, session_id, field, original_value, requested_value, reason, requested_by
  ) values (
    v_session.organization_id, v_session.employee_id, p_session_id, p_field,
    case p_field when 'clock_in_at' then v_session.clock_in_at else v_session.clock_out_at end,
    p_requested_value, btrim(p_reason), auth.uid()
  )
  returning * into v_row;

  for v_user in select * from private.attendance_approver_user_ids(v_session.employee_id) loop
    continue when v_user = auth.uid();
    perform private.create_notification(
      v_session.organization_id, v_user, v_session.employee_id, 'attendance.correction_requested',
      private.employee_display_name(v_session.employee_id) || ' asked to correct a ' ||
        case p_field when 'clock_in_at' then 'clock-in' else 'clock-out' end || ' on ' || to_char(v_session.work_date, 'Mon DD'),
      btrim(p_reason), '/team/attendance', jsonb_build_object('adjustment_id', v_row.id)
    );
  end loop;

  perform private.log_audit_event(
    v_session.organization_id, 'ATTENDANCE_ADJUSTMENT_REQUESTED', 'attendance_adjustment', v_row.id, null, to_jsonb(v_row)
  );
  return v_row;
end;
$$;

create or replace function public.cancel_attendance_adjustment(p_adjustment_id uuid)
returns public.attendance_adjustments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_adj public.attendance_adjustments;
begin
  select * into v_adj from public.attendance_adjustments where id = p_adjustment_id for update;
  if v_adj.id is null or v_adj.requested_by is distinct from auth.uid() then
    raise exception using errcode = '42501', message = 'Only the person who asked can withdraw this correction';
  end if;
  if v_adj.status <> 'pending' then
    raise exception using errcode = '23514', message = 'This correction has already been decided';
  end if;
  update public.attendance_adjustments set status = 'cancelled', decided_at = now(), decided_by = auth.uid()
  where id = p_adjustment_id returning * into v_adj;
  perform private.log_audit_event(v_adj.organization_id, 'ATTENDANCE_ADJUSTMENT_WITHDRAWN', 'attendance_adjustment', v_adj.id, null, to_jsonb(v_adj));
  return v_adj;
end;
$$;

revoke execute on function public.cancel_attendance_adjustment(uuid) from public, anon;
grant execute on function public.cancel_attendance_adjustment(uuid) to authenticated;

create or replace function public.decide_attendance_adjustment(
  p_adjustment_id uuid,
  p_approve boolean,
  p_note text default null
)
returns public.attendance_adjustments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_adj public.attendance_adjustments;
  v_session public.attendance_sessions;
  v_in timestamptz;
  v_out timestamptz;
  v_user uuid;
begin
  select * into v_adj from public.attendance_adjustments where id = p_adjustment_id for update;
  if v_adj.id is null then
    raise exception 'Correction not found';
  end if;
  if v_adj.status <> 'pending' then
    raise exception using errcode = '23514', message = 'This correction has already been decided';
  end if;
  if not private.can_adjust_attendance(v_adj.organization_id, v_adj.employee_id) then
    raise exception using errcode = '42501', message = 'Not authorized to decide this correction';
  end if;
  if v_adj.employee_id = private.current_employee_id() or v_adj.requested_by = auth.uid() then
    raise exception using errcode = '42501', message = 'You can''t decide a correction to your own attendance';
  end if;
  if not p_approve and nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception using errcode = '22023', message = 'Explain why the correction is declined';
  end if;

  select * into v_session from public.attendance_sessions where id = v_adj.session_id for update;

  if p_approve then
    v_in := case when v_adj.field = 'clock_in_at' then v_adj.requested_value else v_session.clock_in_at end;
    v_out := case when v_adj.field = 'clock_out_at' then v_adj.requested_value else v_session.clock_out_at end;
    if v_out is not null and (v_out <= v_in or v_out - v_in > interval '24 hours') then
      raise exception using errcode = '22023', message = 'Approving this would leave the record with an impossible clock-out — it no longer fits the current times';
    end if;

    update public.attendance_sessions
    set clock_in_at = v_in,
        clock_out_at = v_out,
        status = case when v_out is null and status = 'open' then 'open' else 'corrected' end,
        needs_review = case when v_out is not null then false else needs_review end,
        review_reason = case when v_out is not null then null else review_reason end
    where id = v_session.id;

    insert into public.attendance_events (organization_id, session_id, employee_id, event_type, occurred_at, source, recorded_by)
    values (v_adj.organization_id, v_adj.session_id, v_adj.employee_id, 'adjustment_applied', now(), 'admin', auth.uid());

    -- Re-derive the work date, schedule and classification from the
    -- corrected times.
    perform private.recompute_attendance_session(v_session.id, true);
  end if;

  update public.attendance_adjustments
  set status = case when p_approve then 'approved' else 'rejected' end,
      decided_by = auth.uid(), decided_at = now(), decision_note = nullif(btrim(coalesce(p_note, '')), '')
  where id = p_adjustment_id
  returning * into v_adj;

  select user_id into v_user from public.employees where id = v_adj.employee_id;
  if v_user is not null then
    perform private.create_notification(
      v_adj.organization_id, v_user, v_adj.employee_id, 'attendance.correction_decided',
      case when p_approve then 'Your attendance correction was approved' else 'Your attendance correction was declined' end,
      v_adj.decision_note, '/time', jsonb_build_object('adjustment_id', v_adj.id)
    );
  end if;

  perform private.log_audit_event(
    v_adj.organization_id,
    case when p_approve then 'ATTENDANCE_ADJUSTMENT_APPROVED' else 'ATTENDANCE_ADJUSTMENT_REJECTED' end,
    'attendance_adjustment', v_adj.id, null, to_jsonb(v_adj)
  );
  return v_adj;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Overtime
-- ---------------------------------------------------------------------------

create or replace function public.decide_overtime(p_session_id uuid, p_approve boolean, p_note text default null)
returns public.attendance_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.attendance_sessions;
  v_user uuid;
begin
  select * into v_session from public.attendance_sessions where id = p_session_id for update;
  if v_session.id is null then
    raise exception 'Attendance record not found';
  end if;
  if not private.can_adjust_attendance(v_session.organization_id, v_session.employee_id) then
    raise exception using errcode = '42501', message = 'Not authorized to decide overtime for this employee';
  end if;
  if v_session.employee_id = private.current_employee_id() then
    raise exception using errcode = '42501', message = 'You can''t approve your own overtime';
  end if;
  if v_session.overtime_status <> 'pending' then
    raise exception using errcode = '23514', message = 'There is no overtime waiting for a decision on this record';
  end if;
  update public.attendance_sessions
  set overtime_status = case when p_approve then 'approved' else 'rejected' end,
      overtime_decided_by = auth.uid(), overtime_decided_at = now(), overtime_note = nullif(btrim(coalesce(p_note, '')), '')
  where id = p_session_id
  returning * into v_session;
  select user_id into v_user from public.employees where id = v_session.employee_id;
  if v_user is not null then
    perform private.create_notification(
      v_session.organization_id, v_user, v_session.employee_id, 'attendance.overtime_decided',
      case when p_approve then 'Your overtime was approved' else 'Your overtime was not approved' end,
      to_char(v_session.work_date, 'Mon DD') || ' · ' || v_session.overtime_minutes || ' min'
        || coalesce(' · ' || v_session.overtime_note, ''),
      '/time', jsonb_build_object('session_id', v_session.id)
    );
  end if;
  perform private.log_audit_event(
    v_session.organization_id, case when p_approve then 'OVERTIME_APPROVED' else 'OVERTIME_REJECTED' end,
    'attendance_session', v_session.id, null,
    jsonb_build_object('employee_id', v_session.employee_id, 'work_date', v_session.work_date, 'minutes', v_session.overtime_minutes)
  );
  return v_session;
end;
$$;

revoke execute on function public.decide_overtime(uuid, boolean, text) from public, anon;
grant execute on function public.decide_overtime(uuid, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Organization-local reporting views
-- ---------------------------------------------------------------------------

create or replace view public.attendance_today_v
  with (security_invoker = true)
as
select
  s.organization_id,
  s.employee_id,
  e.first_name,
  e.last_name,
  s.clock_in_at,
  s.scheduled_start_at,
  (s.arrival_status = 'late') as is_late,
  s.status,
  s.arrival_status,
  s.late_minutes,
  s.scheduled_end_at
from public.attendance_sessions s
join public.employees e on e.id = s.employee_id
where s.work_date = private.org_today(s.organization_id) and s.clock_out_at is null and s.status = 'open';

create or replace view public.attendance_summary_30d_v
  with (security_invoker = true)
as
select
  s.organization_id,
  s.employee_id,
  count(*) as sessions,
  sum(coalesce(s.worked_minutes, extract(epoch from (coalesce(s.clock_out_at, now()) - s.clock_in_at)) / 60.0)) / 60.0 as hours_worked,
  count(*) filter (where s.arrival_status = 'late') as late_count,
  count(*) filter (where s.status in ('missing_out', 'auto_closed') or (s.clock_out_at is null and s.work_date < private.org_today(s.organization_id))) as missing_clock_out_count
from public.attendance_sessions s
where s.work_date >= private.org_today(s.organization_id) - 30
group by s.organization_id, s.employee_id;

-- ---------------------------------------------------------------------------
-- 9. Day view, exceptions, employee overview, report
-- ---------------------------------------------------------------------------

-- One row per employee the caller may see, for one organization-local day:
-- what they were scheduled for and what actually happened, aware of
-- approved leave and holidays.
create or replace function public.list_attendance_day(p_organization_id uuid, p_date date default null)
returns table (
  employee_id uuid, employee_name text, employee_number text, department text,
  scheduled_start_at timestamptz, scheduled_end_at timestamptz,
  session_id uuid, clock_in_at timestamptz, clock_out_at timestamptz,
  worked_minutes integer, late_minutes integer, overtime_minutes integer, overtime_status text,
  day_status text, detail text, needs_review boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_date date := coalesce(p_date, private.org_today(p_organization_id));
begin
  if not (private.has_permission(p_organization_id, 'attendance.read_org') or private.has_permission(p_organization_id, 'attendance.adjust_org')
          or private.has_permission(p_organization_id, 'attendance.read_team') or private.has_permission(p_organization_id, 'attendance.adjust_team')) then
    raise exception using errcode = '42501', message = 'Not authorized to view team attendance';
  end if;

  return query
  select
    e.id,
    private.employee_display_name(e.id),
    e.employee_number,
    ou.name,
    sh.start_at, sh.end_at,
    s.id, s.clock_in_at, s.clock_out_at,
    s.worked_minutes, coalesce(s.late_minutes, 0), coalesce(s.overtime_minutes, 0), coalesce(s.overtime_status, 'none'),
    case
      when s.id is not null and s.status = 'missing_out' then 'missing_out'
      when s.id is not null and s.clock_out_at is null then case when s.arrival_status = 'late' then 'late' else 'working' end
      when s.id is not null then 'completed'
      when lv.leave_name is not null then 'on_leave'
      when hol.name is not null then 'holiday'
      when sh.start_at is null then case when private.has_schedule_on(e.id, v_date) then 'day_off' else 'no_schedule' end
      when now() < sh.start_at + make_interval(mins => coalesce(pol.grace_period_minutes, 0)) then 'not_started'
      else 'absent'
    end,
    case
      when lv.leave_name is not null and s.id is not null then 'Worked during approved ' || lv.leave_name
      when lv.leave_name is not null then lv.leave_name
      when hol.name is not null then hol.name
      when s.arrival_status = 'late' then s.late_minutes || ' min late'
      when s.arrival_status = 'within_grace' then 'Within grace period'
      when s.arrival_status = 'unscheduled' and s.id is not null then 'Unscheduled work'
      else null
    end,
    coalesce(s.needs_review, false)
  from public.employees e
  left join public.employee_assignments a on a.employee_id = e.id and a.end_date is null
  left join public.org_units ou on ou.id = a.org_unit_id
  left join lateral (select * from private.scheduled_shift(e.id, v_date)) sh on true
  left join lateral (
    select x.* from public.attendance_sessions x
    where x.employee_id = e.id and x.work_date = v_date
    order by x.clock_in_at desc limit 1
  ) s on true
  left join lateral (select private.approved_leave_on(e.id, v_date) as leave_name) lv on true
  left join lateral (select h.name from private.holiday_on(e.id, v_date) h) hol on true
  left join lateral (select * from private.employee_attendance_policy(e.id)) pol on true
  where e.organization_id = p_organization_id
    and e.status in ('active', 'leave', 'suspended')
    and private.can_view_attendance(p_organization_id, e.id)
  order by e.last_name, e.first_name;
end;
$$;

revoke execute on function public.list_attendance_day(uuid, date) from public, anon;
grant execute on function public.list_attendance_day(uuid, date) to authenticated;

-- Attendance exceptions across a period (at most 62 days): late, absent,
-- missing clock-out, early departure, unscheduled work, overtime awaiting
-- approval, pending corrections, work during approved leave.
create or replace function public.list_attendance_exceptions(p_organization_id uuid, p_from date, p_to date)
returns table (employee_id uuid, employee_name text, work_date date, exception_type text, detail text, session_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_today date := private.org_today(p_organization_id);
begin
  if not (private.has_permission(p_organization_id, 'attendance.read_org') or private.has_permission(p_organization_id, 'attendance.adjust_org')
          or private.has_permission(p_organization_id, 'attendance.read_team') or private.has_permission(p_organization_id, 'attendance.adjust_team')) then
    raise exception using errcode = '42501', message = 'Not authorized to view attendance exceptions';
  end if;
  if p_to < p_from or p_to - p_from > 62 then
    raise exception using errcode = '22023', message = 'Choose a period of at most 62 days';
  end if;
  perform private.flag_stale_attendance(null);

  return query
  with people as (
    select e.id, private.employee_display_name(e.id) as name
    from public.employees e
    where e.organization_id = p_organization_id and e.status in ('active', 'leave', 'suspended')
      and private.can_view_attendance(p_organization_id, e.id)
  ),
  sessions as (
    select s.*, pp.name from public.attendance_sessions s join people pp on pp.id = s.employee_id
    where s.work_date between p_from and p_to
  )
  select x.employee_id, x.name, x.work_date, 'late', x.late_minutes || ' min late', x.id from sessions x where x.arrival_status = 'late'
  union all
  select x.employee_id, x.name, x.work_date, 'missing_clock_out', coalesce(x.review_reason, 'No clock-out recorded'), x.id
    from sessions x where x.status in ('missing_out', 'auto_closed') and x.needs_review
  union all
  select x.employee_id, x.name, x.work_date, 'early_departure', x.early_departure_minutes || ' min before scheduled end', x.id
    from sessions x where x.early_departure_minutes > 0
  union all
  select x.employee_id, x.name, x.work_date, 'unscheduled_work', 'Worked on a day with no scheduled shift', x.id
    from sessions x where x.arrival_status = 'unscheduled' and private.has_schedule_on(x.employee_id, x.work_date)
  union all
  select x.employee_id, x.name, x.work_date, 'overtime_pending', x.overtime_minutes || ' min awaiting approval', x.id
    from sessions x where x.overtime_status = 'pending'
  union all
  select x.employee_id, x.name, x.work_date, 'worked_during_leave', 'Clocked in during approved ' || private.approved_leave_on(x.employee_id, x.work_date), x.id
    from sessions x where private.approved_leave_on(x.employee_id, x.work_date) is not null
  union all
  select a.employee_id, pp.name, s.work_date, 'correction_pending',
    case a.field when 'clock_in_at' then 'Clock-in' else 'Clock-out' end || ' correction waiting for a decision', a.session_id
    from public.attendance_adjustments a
    join people pp on pp.id = a.employee_id
    join public.attendance_sessions s on s.id = a.session_id
    where a.status = 'pending' and s.work_date between p_from and p_to
  union all
  select pp.id, pp.name, d::date, 'absent', 'No clock-in for a scheduled shift', null::uuid
    from people pp
    cross join generate_series(p_from::timestamp, least(p_to, v_today)::timestamp, interval '1 day') d
    cross join lateral (select * from private.scheduled_shift(pp.id, d::date)) sh
    where sh.start_at is not null
      and now() > sh.start_at + interval '1 hour'
      and private.approved_leave_on(pp.id, d::date) is null
      and (select h.id from private.holiday_on(pp.id, d::date) h) is null
      and not exists (select 1 from public.attendance_sessions s where s.employee_id = pp.id and s.work_date = d::date)
      and exists (select 1 from public.employees e where e.id = pp.id and coalesce(e.hire_date, d::date) <= d::date)
  order by 3 desc, 2;
end;
$$;

revoke execute on function public.list_attendance_exceptions(uuid, date, date) from public, anon;
grant execute on function public.list_attendance_exceptions(uuid, date, date) to authenticated;

-- The signed-in employee's attendance at a glance (organization-local
-- days and weeks; the week starts on Monday).
create or replace function public.get_my_attendance_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  v_today date;
  v_week_start date;
  v_month_start date;
  v_shift record;
  v_next jsonb;
  v_open public.attendance_sessions;
  v_on_break boolean;
  v_scheduled_week integer := 0;
  d date;
  v_s record;
  v_upcoming record;
  v_current_schedule record;
begin
  select * into v_employee from public.employees where id = private.current_employee_id();
  if v_employee.id is null then
    return null;
  end if;
  v_today := private.org_today(v_employee.organization_id);
  v_week_start := v_today - ((extract(isodow from v_today)::int) - 1);
  v_month_start := date_trunc('month', v_today)::date;

  select * into v_shift from private.scheduled_shift(v_employee.id, v_today);
  v_open := private.my_open_session();
  v_on_break := v_open.id is not null and exists (select 1 from public.attendance_breaks b where b.session_id = v_open.id and b.ended_at is null);

  for d in select generate_series(v_week_start::timestamp, (v_week_start + 6)::timestamp, interval '1 day')::date loop
    select * into v_s from private.scheduled_shift(v_employee.id, d);
    if v_s.start_at is not null then
      v_scheduled_week := v_scheduled_week + floor(extract(epoch from (v_s.end_at - v_s.start_at)) / 60)::int - coalesce(v_s.break_minutes, 0);
    end if;
  end loop;

  for d in select generate_series((v_today + 1)::timestamp, (v_today + 14)::timestamp, interval '1 day')::date loop
    select * into v_s from private.scheduled_shift(v_employee.id, d);
    if v_s.start_at is not null and private.approved_leave_on(v_employee.id, d) is null
       and (select h.id from private.holiday_on(v_employee.id, d) h) is null then
      v_next := jsonb_build_object('date', d, 'start_at', v_s.start_at, 'end_at', v_s.end_at);
      exit;
    end if;
  end loop;

  select ws.name, sa.start_date into v_current_schedule
  from public.schedule_assignments sa join public.work_schedules ws on ws.id = sa.schedule_id
  where sa.employee_id = v_employee.id and sa.start_date <= v_today and (sa.end_date is null or sa.end_date >= v_today)
  order by sa.start_date desc limit 1;

  select ws.name, sa.start_date into v_upcoming
  from public.schedule_assignments sa join public.work_schedules ws on ws.id = sa.schedule_id
  where sa.employee_id = v_employee.id and sa.start_date > v_today
  order by sa.start_date limit 1;

  return jsonb_build_object(
    'timezone', private.org_timezone(v_employee.organization_id),
    'today', v_today,
    'today_shift', case when v_shift.start_at is null then null else jsonb_build_object('start_at', v_shift.start_at, 'end_at', v_shift.end_at, 'break_minutes', v_shift.break_minutes) end,
    'today_leave', private.approved_leave_on(v_employee.id, v_today),
    'today_holiday', (select h.name from private.holiday_on(v_employee.id, v_today) h),
    'next_shift', v_next,
    'open_session', case when v_open.id is null then null else jsonb_build_object(
      'id', v_open.id, 'clock_in_at', v_open.clock_in_at, 'arrival_status', v_open.arrival_status,
      'late_minutes', v_open.late_minutes, 'scheduled_start_at', v_open.scheduled_start_at, 'scheduled_end_at', v_open.scheduled_end_at,
      'on_break', v_on_break, 'break_minutes', v_open.break_minutes) end,
    'current_schedule', case when v_current_schedule.name is null then null else jsonb_build_object('name', v_current_schedule.name, 'since', v_current_schedule.start_date) end,
    'upcoming_schedule', case when v_upcoming.name is null then null else jsonb_build_object('name', v_upcoming.name, 'starts', v_upcoming.start_date) end,
    'today_worked_minutes', coalesce((select sum(s.worked_minutes) from public.attendance_sessions s where s.employee_id = v_employee.id and s.work_date = v_today), 0),
    'week_worked_minutes', coalesce((select sum(s.worked_minutes) from public.attendance_sessions s where s.employee_id = v_employee.id and s.work_date between v_week_start and v_today), 0),
    'week_scheduled_minutes', v_scheduled_week,
    'month_worked_minutes', coalesce((select sum(s.worked_minutes) from public.attendance_sessions s where s.employee_id = v_employee.id and s.work_date between v_month_start and v_today), 0),
    'pending_corrections', (select count(*) from public.attendance_adjustments a where a.employee_id = v_employee.id and a.status = 'pending'),
    'needs_review', (select count(*) from public.attendance_sessions s where s.employee_id = v_employee.id and s.needs_review)
  );
end;
$$;

revoke execute on function public.get_my_attendance_overview() from public, anon;
grant execute on function public.get_my_attendance_overview() to authenticated;

-- HR attendance report for a period, one row per employee (data and
-- patterns — no ranking or labels).
create or replace function public.attendance_report(p_organization_id uuid, p_from date, p_to date, p_org_unit_id uuid default null)
returns table (
  employee_id uuid, employee_name text, employee_number text, department text,
  days_worked integer, worked_minutes integer, late_count integer, absent_count integer,
  missing_clock_out_count integer, early_departure_count integer,
  overtime_minutes integer, overtime_pending_minutes integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not (private.has_permission(p_organization_id, 'attendance.read_org') or private.has_permission(p_organization_id, 'attendance.adjust_org')) then
    raise exception using errcode = '42501', message = 'Not authorized to view attendance reports';
  end if;
  if p_to < p_from or p_to - p_from > 62 then
    raise exception using errcode = '22023', message = 'Choose a period of at most 62 days';
  end if;

  return query
  with exceptions as (
    select * from public.list_attendance_exceptions(p_organization_id, p_from, p_to)
  )
  select
    e.id, private.employee_display_name(e.id), e.employee_number, ou.name,
    (select count(distinct s.work_date) from public.attendance_sessions s where s.employee_id = e.id and s.work_date between p_from and p_to)::integer,
    coalesce((select sum(s.worked_minutes) from public.attendance_sessions s where s.employee_id = e.id and s.work_date between p_from and p_to), 0)::integer,
    (select count(*) from exceptions x where x.employee_id = e.id and x.exception_type = 'late')::integer,
    (select count(*) from exceptions x where x.employee_id = e.id and x.exception_type = 'absent')::integer,
    (select count(*) from exceptions x where x.employee_id = e.id and x.exception_type = 'missing_clock_out')::integer,
    (select count(*) from exceptions x where x.employee_id = e.id and x.exception_type = 'early_departure')::integer,
    coalesce((select sum(s.overtime_minutes) from public.attendance_sessions s where s.employee_id = e.id and s.work_date between p_from and p_to and s.overtime_status in ('approved', 'pending')), 0)::integer,
    coalesce((select sum(s.overtime_minutes) from public.attendance_sessions s where s.employee_id = e.id and s.work_date between p_from and p_to and s.overtime_status = 'pending'), 0)::integer
  from public.employees e
  left join public.employee_assignments a on a.employee_id = e.id and a.end_date is null
  left join public.org_units ou on ou.id = a.org_unit_id
  where e.organization_id = p_organization_id
    and e.status in ('active', 'leave', 'suspended')
    and (p_org_unit_id is null or a.org_unit_id = p_org_unit_id)
  order by e.last_name, e.first_name;
end;
$$;

revoke execute on function public.attendance_report(uuid, date, date, uuid) from public, anon;
grant execute on function public.attendance_report(uuid, date, date, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 10. Schedules
-- ---------------------------------------------------------------------------

-- Create or edit a schedule with per-day hours. p_shifts:
-- [{"day_of_week":1,"start_time":"09:00","end_time":"17:00","break_minutes":60}, …]
-- end_time <= start_time is an overnight shift. Attendance keeps the
-- snapshot taken at each punch, so editing hours never rewrites history.
create or replace function public.save_work_schedule(
  p_organization_id uuid,
  p_schedule_id uuid,
  p_name text,
  p_description text,
  p_is_default boolean,
  p_shifts jsonb
)
returns public.work_schedules
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_schedule public.work_schedules;
  v_shift jsonb;
  v_days integer[] := '{}';
  v_day integer;
  v_start time;
  v_end time;
  v_break integer;
begin
  if not private.has_permission(p_organization_id, 'attendance.manage_policies') then
    raise exception using errcode = '42501', message = 'Not authorized to manage work schedules';
  end if;
  if nullif(btrim(coalesce(p_name, '')), '') is null or char_length(btrim(p_name)) > 120 then
    raise exception using errcode = '22023', message = 'Give the schedule a name (up to 120 characters)';
  end if;
  if jsonb_typeof(p_shifts) <> 'array' or jsonb_array_length(p_shifts) = 0 then
    raise exception using errcode = '22023', message = 'Add at least one working day';
  end if;

  for v_shift in select * from jsonb_array_elements(p_shifts) loop
    v_day := (v_shift->>'day_of_week')::integer;
    v_start := (v_shift->>'start_time')::time;
    v_end := (v_shift->>'end_time')::time;
    v_break := coalesce((v_shift->>'break_minutes')::integer, 0);
    if v_day is null or v_day not between 0 and 6 or v_day = any(v_days) then
      raise exception using errcode = '22023', message = 'Each day can appear only once';
    end if;
    if v_start is null or v_end is null or v_start = v_end then
      raise exception using errcode = '22023', message = 'Each day needs different start and end times';
    end if;
    if v_break < 0 or v_break >= (case when v_end > v_start then extract(epoch from (v_end - v_start)) / 60 else extract(epoch from (v_end - v_start + interval '24 hours')) / 60 end) then
      raise exception using errcode = '22023', message = 'A break must be shorter than the shift';
    end if;
    v_days := v_days || v_day;
  end loop;

  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text, 0));
  if coalesce(p_is_default, false) then
    update public.work_schedules set is_default = false
    where organization_id = p_organization_id and is_default and id is distinct from p_schedule_id;
  end if;

  if p_schedule_id is null then
    insert into public.work_schedules (organization_id, name, description, is_active, is_default)
    values (p_organization_id, btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''), true, coalesce(p_is_default, false))
    returning * into v_schedule;
  else
    update public.work_schedules
    set name = btrim(p_name), description = nullif(btrim(coalesce(p_description, '')), ''), is_default = coalesce(p_is_default, is_default)
    where id = p_schedule_id and organization_id = p_organization_id
    returning * into v_schedule;
    if v_schedule.id is null then
      raise exception 'Schedule not found';
    end if;
    delete from public.schedule_shifts where schedule_id = v_schedule.id;
  end if;

  insert into public.schedule_shifts (schedule_id, day_of_week, start_time, end_time, break_minutes)
  select v_schedule.id, (x->>'day_of_week')::smallint, (x->>'start_time')::time, (x->>'end_time')::time, coalesce((x->>'break_minutes')::integer, 0)
  from jsonb_array_elements(p_shifts) x;

  perform private.log_audit_event(
    p_organization_id, case when p_schedule_id is null then 'WORK_SCHEDULE_CREATED' else 'WORK_SCHEDULE_UPDATED' end,
    'work_schedule', v_schedule.id, null, to_jsonb(v_schedule) || jsonb_build_object('shifts', p_shifts)
  );
  return v_schedule;
end;
$$;

revoke execute on function public.save_work_schedule(uuid, uuid, text, text, boolean, jsonb) from public, anon;
grant execute on function public.save_work_schedule(uuid, uuid, text, text, boolean, jsonb) to authenticated;

create or replace function public.set_work_schedule_active(p_schedule_id uuid, p_active boolean)
returns public.work_schedules
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_schedule public.work_schedules;
begin
  select * into v_schedule from public.work_schedules where id = p_schedule_id for update;
  if v_schedule.id is null then
    raise exception 'Schedule not found';
  end if;
  if not private.has_permission(v_schedule.organization_id, 'attendance.manage_policies') then
    raise exception using errcode = '42501', message = 'Not authorized to manage work schedules';
  end if;
  if not p_active and exists (
    select 1 from public.schedule_assignments sa where sa.schedule_id = p_schedule_id
      and (sa.end_date is null or sa.end_date >= private.org_today(v_schedule.organization_id))
  ) then
    raise exception using errcode = '23514', message = 'People are still assigned to this schedule — move them to another schedule first';
  end if;
  update public.work_schedules set is_active = p_active, is_default = case when p_active then is_default else false end
  where id = p_schedule_id returning * into v_schedule;
  perform private.log_audit_event(v_schedule.organization_id, 'WORK_SCHEDULE_ACTIVE_CHANGED', 'work_schedule', v_schedule.id, null,
    jsonb_build_object('is_active', p_active));
  return v_schedule;
end;
$$;

revoke execute on function public.set_work_schedule_active(uuid, boolean) from public, anon;
grant execute on function public.set_work_schedule_active(uuid, boolean) to authenticated;

-- Effective date defaults to the organization's today, not UTC's.
create or replace function public.assign_employee_schedule(
  p_employee_id uuid,
  p_schedule_id uuid,
  p_start_date date default null
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
  v_start date;
begin
  select e.* into v_employee from public.employees e where e.id = p_employee_id;
  if v_employee.id is null then
    raise exception using errcode = 'P0002', message = 'Employee not found';
  end if;
  if v_employee.status = 'terminated' then
    raise exception using errcode = '23514', message = 'A terminated employee cannot receive a work schedule';
  end if;
  if auth.uid() is null or not private.has_permission(v_employee.organization_id, 'attendance.manage_policies') then
    raise exception using errcode = '42501', message = 'Not authorized to assign this employee''s work schedule';
  end if;
  v_start := coalesce(p_start_date, private.org_today(v_employee.organization_id));

  select ws.* into v_schedule from public.work_schedules ws where ws.id = p_schedule_id;
  if v_schedule.id is null or v_schedule.organization_id <> v_employee.organization_id or not v_schedule.is_active then
    raise exception using errcode = '22023', message = 'Choose an active schedule from the employee''s organization';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_employee.id::text, 0));

  select sa.* into v_current from public.schedule_assignments sa
  where sa.employee_id = v_employee.id and sa.end_date is null
  for update;

  if v_current.id is not null and v_current.schedule_id = v_schedule.id then
    return v_current;
  end if;
  if v_current.id is not null and v_start < v_current.start_date then
    raise exception using errcode = '22023', message = 'The new schedule cannot start before the current schedule assignment';
  end if;

  if v_current.id is not null and v_start = v_current.start_date then
    update public.schedule_assignments set schedule_id = v_schedule.id where id = v_current.id returning * into v_result;
  else
    if v_current.id is not null then
      update public.schedule_assignments set end_date = v_start - 1 where id = v_current.id;
    end if;
    insert into public.schedule_assignments (organization_id, employee_id, schedule_id, start_date)
    values (v_employee.organization_id, v_employee.id, v_schedule.id, v_start)
    returning * into v_result;
  end if;

  perform private.log_audit_event(
    v_employee.organization_id, 'EMPLOYEE_SCHEDULE_ASSIGNED', 'schedule_assignment', v_result.id, to_jsonb(v_current), to_jsonb(v_result)
  );
  return v_result;
end;
$$;

-- Overnight shifts are allowed by the older single-pattern RPC too.
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
begin
  if p_days_of_week is null or cardinality(p_days_of_week) = 0 then
    raise exception using errcode = '22023', message = 'Choose at least one valid work day';
  end if;
  return public.save_work_schedule(
    p_organization_id, null, p_name, p_description, p_is_default,
    (select jsonb_agg(jsonb_build_object('day_of_week', d, 'start_time', p_start_time, 'end_time', p_end_time, 'break_minutes', p_break_minutes))
     from (select distinct unnest(p_days_of_week) as d) days)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Backfill, maintenance schedule
-- ---------------------------------------------------------------------------

do $$
declare
  v_id uuid;
begin
  for v_id in select id from public.attendance_sessions loop
    perform private.recompute_attendance_session(v_id, true);
  end loop;
end $$;
select private.flag_stale_attendance(null);

-- Flag forgotten clock-outs every 15 minutes even when nobody is using the
-- app (clock-in and the exception views also run it on demand).
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    if exists (select 1 from cron.job where jobname = 'halomanage-attendance-maintenance') then
      perform cron.unschedule('halomanage-attendance-maintenance');
    end if;
    perform cron.schedule('halomanage-attendance-maintenance', '*/15 * * * *', 'select private.flag_stale_attendance(null)');
  end if;
exception when others then
  raise notice 'pg_cron scheduling skipped: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- 12. New-hire defaults start on the organization's today, not UTC's
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
  v_effective_date := coalesce(v_employee.hire_date, private.org_today(v_employee.organization_id));

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

-- ---------------------------------------------------------------------------
-- 13. Attendance setup changes are audited (policies and holidays are edited
--     directly under RLS from Time & Attendance setup)
-- ---------------------------------------------------------------------------

create or replace function private.attendance_setup_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_kind text := case tg_table_name when 'holidays' then 'HOLIDAY' else 'ATTENDANCE_POLICY' end;
begin
  -- Rows removed because the whole organization is being deleted have
  -- nowhere to be audited.
  if not exists (select 1 from public.organizations o where o.id = (v_row->>'organization_id')::uuid) then
    return null;
  end if;
  perform private.log_audit_event(
    (v_row->>'organization_id')::uuid,
    v_kind || case tg_op when 'INSERT' then '_CREATED' when 'DELETE' then '_DELETED' else '_UPDATED' end,
    case tg_table_name when 'holidays' then 'holiday' else 'attendance_policy' end,
    (v_row->>'id')::uuid, v_old, v_new
  );
  return null;
end;
$$;

drop trigger if exists attendance_policies_audit on public.attendance_policies;
create trigger attendance_policies_audit
  after insert or update or delete on public.attendance_policies
  for each row execute function private.attendance_setup_audit();

drop trigger if exists holidays_audit on public.holidays;
create trigger holidays_audit
  after insert or update or delete on public.holidays
  for each row execute function private.attendance_setup_audit();
