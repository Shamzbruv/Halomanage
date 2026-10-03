-- Lunch and break allowances, live overrun alerts, and what a manager does
-- about an overrun: excuse it, deduct the minutes from pay, or have the
-- employee make the time up.
--
-- HR sets, on the attendance policy, how long a lunch and a short break are
-- and how many of each a shift includes. Each break snapshots its allowance
-- when it starts (a later policy change never rewrites it). A break that
-- runs past its allowance (plus a small grace) becomes an attendance
-- violation that the employee and their manager both see — while it's still
-- running (pg_cron alert) and when it ends. The manager excuses it, marks
-- the minutes to be deducted from pay, or asks for them to be made up: extra
-- time worked by a due date, credited automatically and not counted as
-- overtime.

-- ---------------------------------------------------------------------------
-- 1. Policy: allowances
-- ---------------------------------------------------------------------------

alter table public.attendance_policies
  add column if not exists lunch_minutes integer not null default 60
    check (lunch_minutes between 0 and 240),
  add column if not exists lunches_per_shift integer not null default 1
    check (lunches_per_shift between 0 and 3),
  add column if not exists short_break_minutes integer not null default 15
    check (short_break_minutes between 0 and 120),
  add column if not exists short_breaks_per_shift integer not null default 2
    check (short_breaks_per_shift between 0 and 10),
  add column if not exists short_breaks_paid boolean not null default true,
  add column if not exists break_overrun_grace_minutes integer not null default 2
    check (break_overrun_grace_minutes between 0 and 30);

-- ---------------------------------------------------------------------------
-- 2. Breaks: type and allowance snapshot
-- ---------------------------------------------------------------------------

alter table public.attendance_breaks
  add column if not exists break_type text not null default 'break' check (break_type in ('break', 'lunch')),
  add column if not exists allowed_minutes integer check (allowed_minutes >= 0),
  add column if not exists grace_minutes integer not null default 0 check (grace_minutes >= 0),
  add column if not exists paid boolean,
  add column if not exists overrun_alerted_at timestamptz;

comment on column public.attendance_breaks.allowed_minutes is
  'Allowance snapshotted when the break started (0 = beyond the number allowed per shift). Null on breaks recorded before allowances existed: those count as unpaid, with no overrun.';
comment on column public.attendance_breaks.paid is
  'Snapshotted at start: a short break under a policy where short breaks are paid. Lunch is never paid.';

-- ---------------------------------------------------------------------------
-- 3. Sessions: overtime before make-up credit, and the credit itself
-- ---------------------------------------------------------------------------

alter table public.attendance_sessions
  add column if not exists overtime_base_minutes integer not null default 0,
  add column if not exists makeup_minutes integer not null default 0;

comment on column public.attendance_sessions.overtime_base_minutes is
  'Worked time beyond the scheduled net time, before any of it is credited to making up break overruns.';
comment on column public.attendance_sessions.makeup_minutes is
  'Part of overtime_base_minutes credited to make-up obligations (not overtime).';

update public.attendance_sessions set overtime_base_minutes = coalesce(overtime_minutes, 0);

-- ---------------------------------------------------------------------------
-- 4. Violations
-- ---------------------------------------------------------------------------

create table public.attendance_violations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  session_id uuid not null references public.attendance_sessions(id) on delete cascade,
  break_id uuid not null unique references public.attendance_breaks(id) on delete cascade,
  kind text not null check (kind in ('lunch_overrun', 'break_overrun', 'extra_lunch', 'extra_break')),
  work_date date not null,
  allowed_minutes integer not null,
  actual_minutes integer not null,
  overrun_minutes integer not null check (overrun_minutes > 0),
  status text not null default 'pending' check (status in ('pending', 'excused', 'deduct_pay', 'make_up', 'made_up')),
  makeup_due_date date,
  makeup_credited_minutes integer not null default 0,
  decision_note text,
  decided_by uuid references auth.users(id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  check (status not in ('make_up', 'made_up') or makeup_due_date is not null)
);
alter table public.attendance_violations enable row level security;
create index attendance_violations_org_status_idx on public.attendance_violations(organization_id, status);
create index attendance_violations_employee_idx on public.attendance_violations(employee_id, work_date desc);

create policy "read own violations" on public.attendance_violations for select to authenticated
  using (employee_id = private.current_employee_id());
create policy "read scoped violations" on public.attendance_violations for select to authenticated
  using (private.can_view_attendance(organization_id, employee_id));
-- Written only by the functions below.
revoke insert, update, delete on public.attendance_violations from anon, authenticated;
grant select on public.attendance_violations to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Rules
-- ---------------------------------------------------------------------------

-- Minutes of one finished break that are not paid working time.
--   Within the allowance (+ grace): lunch is unpaid; a short break is paid
--   if it was taken as paid.
--   Beyond it: unpaid while pending or marked "deduct from pay"; not
--   deducted when it's to be made up (the employee works it back); when
--   excused, treated like the allowance.
--   Deduction mode 'none' (all breaks paid): only unexcused overrun counts.
--   Breaks from before allowances existed (allowed null) count as unpaid.
create or replace function private.break_unpaid_minutes(
  p_type text,
  p_minutes integer,
  p_allowed integer,
  p_grace integer,
  p_paid boolean,
  p_mode text,
  p_violation_status text
)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case
    when p_allowed is null then case when p_mode = 'none' then 0 else p_minutes end
    when p_minutes <= p_allowed + coalesce(p_grace, 0) then
      case when p_mode = 'none' then 0 when p_type = 'lunch' or not coalesce(p_paid, false) then p_minutes else 0 end
    else
      (case when p_mode = 'none' then 0 when p_type = 'lunch' or not coalesce(p_paid, false) then p_allowed else 0 end)
      + case coalesce(p_violation_status, 'pending')
          when 'make_up' then 0
          when 'made_up' then 0
          when 'excused' then case when p_mode = 'none' then 0 when p_type = 'lunch' or not coalesce(p_paid, false) then p_minutes - p_allowed else 0 end
          else p_minutes - p_allowed
        end
  end;
$$;

create or replace function private.overtime_status_for(
  p_old_status text,
  p_old_minutes integer,
  p_new_minutes integer,
  p_requires_approval boolean
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when coalesce(p_new_minutes, 0) = 0 then 'none'
    when p_old_status in ('approved', 'rejected') and p_old_minutes = p_new_minutes then p_old_status
    when coalesce(p_requires_approval, true) then 'pending'
    else 'approved'
  end;
$$;

-- A finished break that ran past its allowance (+ grace) becomes a pending
-- violation, and the employee and their approvers are told. Re-evaluating
-- updates the figures without notifying again.
create or replace function private.evaluate_break(p_break_id uuid)
returns public.attendance_violations
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.attendance_breaks;
  v public.attendance_violations;
  v_work_date date;
  v_minutes integer;
  v_over integer;
  v_kind text;
  v_label text;
  v_name text;
  v_user uuid;
begin
  select * into b from public.attendance_breaks where id = p_break_id;
  if b.id is null or b.ended_at is null or b.allowed_minutes is null then
    return null;
  end if;
  v_minutes := floor(extract(epoch from (b.ended_at - b.started_at)) / 60)::integer;
  if v_minutes <= b.allowed_minutes + b.grace_minutes then
    delete from public.attendance_violations where break_id = b.id and status = 'pending';
    return null;
  end if;

  v_over := v_minutes - b.allowed_minutes;
  v_kind := case when b.allowed_minutes = 0 then 'extra_' || b.break_type else b.break_type || '_overrun' end;
  select work_date into v_work_date from public.attendance_sessions where id = b.session_id;

  select * into v from public.attendance_violations where break_id = b.id;
  if v.id is not null then
    update public.attendance_violations
    set kind = v_kind, work_date = v_work_date, allowed_minutes = b.allowed_minutes, actual_minutes = v_minutes, overrun_minutes = v_over
    where id = v.id
    returning * into v;
    return v;
  end if;

  insert into public.attendance_violations (organization_id, employee_id, session_id, break_id, kind, work_date, allowed_minutes, actual_minutes, overrun_minutes)
  values (b.organization_id, b.employee_id, b.session_id, b.id, v_kind, v_work_date, b.allowed_minutes, v_minutes, v_over)
  returning * into v;

  v_label := case b.break_type when 'lunch' then 'lunch' else 'break' end;
  v_name := private.employee_display_name(b.employee_id);
  for v_user in select * from private.attendance_approver_user_ids(b.employee_id) loop
    perform private.create_notification(
      b.organization_id, v_user, b.employee_id, 'attendance.break_overrun',
      case when b.allowed_minutes = 0 then v_name || ' took an extra ' || v_label || ' (' || v_minutes || ' min)'
           else v_name || '''s ' || v_label || ' ran ' || v_over || ' min over' end,
      'Allowed ' || b.allowed_minutes || ' min, took ' || v_minutes || ' min. Excuse it, deduct it from pay, or ask for the time to be made up.',
      '/team/attendance', jsonb_build_object('violation_id', v.id)
    );
  end loop;
  select user_id into v_user from public.employees where id = b.employee_id;
  if v_user is not null then
    perform private.create_notification(
      b.organization_id, v_user, b.employee_id, 'attendance.break_overrun',
      case when b.allowed_minutes = 0 then 'You took an extra ' || v_label else 'Your ' || v_label || ' ran ' || v_over || ' min over' end,
      'Your manager will review it — they may excuse it, deduct the time from your pay, or ask you to make it up.',
      '/time', jsonb_build_object('violation_id', v.id)
    );
  end if;
  return v;
end;
$$;

-- Credits time worked beyond the schedule to the employee's make-up
-- obligations (oldest first; only sessions that end after the overrun
-- happened, from the violation's day to its due date — time worked before
-- the long break can't make it up), marks fully credited ones made_up, and keeps each session's
-- overtime = overtime_base − credited make-up.
create or replace function private.allocate_makeup(p_employee_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_since date;
  v_capacity jsonb := '{}'::jsonb;
  v_alloc jsonb := '{}'::jsonb;
  ob record;
  ses record;
  v_need integer;
  v_avail integer;
  v_take integer;
  v_credit integer;
  v_new integer;
  v_ot integer;
  p public.attendance_policies;
begin
  if not exists (select 1 from public.attendance_violations where employee_id = p_employee_id and status in ('make_up', 'made_up'))
     and not exists (select 1 from public.attendance_sessions where employee_id = p_employee_id and makeup_minutes > 0) then
    return;
  end if;
  select private.org_today(e.organization_id) - 62 into v_since from public.employees e where e.id = p_employee_id;

  for ses in
    select s.id, s.overtime_base_minutes from public.attendance_sessions s
    where s.employee_id = p_employee_id and s.work_date >= v_since and s.clock_out_at is not null and s.overtime_base_minutes > 0
  loop
    v_capacity := v_capacity || jsonb_build_object(ses.id::text, ses.overtime_base_minutes);
  end loop;

  for ob in
    select v.*, b.ended_at as occurred_at
    from public.attendance_violations v
    join public.attendance_breaks b on b.id = v.break_id
    where v.employee_id = p_employee_id and v.status in ('make_up', 'made_up') and v.work_date >= v_since
    order by v.work_date, v.created_at, v.id
  loop
    v_need := ob.overrun_minutes;
    v_credit := 0;
    for ses in
      select s.id from public.attendance_sessions s
      where s.employee_id = p_employee_id and s.clock_out_at is not null
        and s.work_date between ob.work_date and ob.makeup_due_date
        and s.clock_out_at > ob.occurred_at
      order by s.work_date, s.clock_in_at
    loop
      exit when v_need = 0;
      v_avail := coalesce((v_capacity ->> ses.id::text)::integer, 0);
      continue when v_avail = 0;
      v_take := least(v_need, v_avail);
      v_capacity := jsonb_set(v_capacity, array[ses.id::text], to_jsonb(v_avail - v_take));
      v_alloc := jsonb_set(v_alloc, array[ses.id::text], to_jsonb(coalesce((v_alloc ->> ses.id::text)::integer, 0) + v_take), true);
      v_need := v_need - v_take;
      v_credit := v_credit + v_take;
    end loop;
    update public.attendance_violations
    set makeup_credited_minutes = v_credit,
        status = case when v_credit >= overrun_minutes then 'made_up' else 'make_up' end
    where id = ob.id;
  end loop;

  p := private.employee_attendance_policy(p_employee_id);
  for ses in
    select * from public.attendance_sessions s where s.employee_id = p_employee_id and s.work_date >= v_since
  loop
    v_new := coalesce((v_alloc ->> ses.id::text)::integer, 0);
    v_ot := greatest(0, ses.overtime_base_minutes - v_new);
    if v_new <> ses.makeup_minutes or v_ot is distinct from ses.overtime_minutes then
      update public.attendance_sessions
      set makeup_minutes = v_new,
          overtime_minutes = v_ot,
          overtime_status = private.overtime_status_for(ses.overtime_status, ses.overtime_minutes, v_ot, p.overtime_requires_approval)
      where id = ses.id;
    end if;
  end loop;
end;
$$;

-- Same derivation as before (20261005100000), now with typed breaks and
-- their allowances, and make-up credit taken out of overtime. A session
-- that has a clock-out but still has an open break (e.g. a forgotten
-- clock-out later corrected) gets the break closed at the clock-out.
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
  v_recorded_deduct integer;
  v_deduct integer;
  v_elapsed integer;
  v_worked integer;
  v_sched_net integer;
  v_arrival text;
  v_late integer := 0;
  v_early integer := 0;
  v_ot_base integer := 0;
  v_ot integer;
  v_holiday public.holidays;
  v_open_break uuid;
begin
  select * into s from public.attendance_sessions where id = p_session_id for update;
  if s.id is null then
    return null;
  end if;

  if s.clock_out_at is not null then
    for v_open_break in
      update public.attendance_breaks set ended_at = greatest(started_at, s.clock_out_at)
      where session_id = s.id and ended_at is null
      returning id
    loop
      perform private.evaluate_break(v_open_break);
    end loop;
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

  select
    coalesce(sum(m.minutes), 0)::integer,
    coalesce(sum(private.break_unpaid_minutes(b.break_type, m.minutes, b.allowed_minutes, b.grace_minutes, b.paid, v_deduction_mode, v.status)), 0)::integer
  into v_breaks, v_recorded_deduct
  from public.attendance_breaks b
  cross join lateral (select floor(extract(epoch from (b.ended_at - b.started_at)) / 60)::integer as minutes) m
  left join public.attendance_violations v on v.break_id = b.id
  where b.session_id = s.id and b.ended_at is not null;

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
    when 'scheduled' then greatest(v_recorded_deduct, coalesce(v_sched_break, 0))
    else v_recorded_deduct
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
      v_ot_base := greatest(0, v_worked - greatest(v_sched_net, 0));
    elsif private.has_schedule_on(s.employee_id, s.work_date) then
      -- Worked on a day the schedule has no shift (a rest day).
      v_ot_base := v_worked;
    end if;
  end if;

  v_ot := greatest(0, v_ot_base - least(coalesce(s.makeup_minutes, 0), v_ot_base));
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
      overtime_base_minutes = v_ot_base,
      makeup_minutes = least(coalesce(s.makeup_minutes, 0), v_ot_base),
      overtime_minutes = v_ot,
      overtime_status = private.overtime_status_for(s.overtime_status, s.overtime_minutes, v_ot, p.overtime_requires_approval)
  where id = s.id;

  update public.attendance_violations set work_date = s.work_date where session_id = s.id and work_date is distinct from s.work_date;

  perform private.allocate_makeup(s.employee_id);
  select * into s from public.attendance_sessions where id = p_session_id;
  return s;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Maintenance: forgotten clock-outs (as before) and live overrun alerts
-- ---------------------------------------------------------------------------

create or replace function private.flag_stale_attendance(p_employee_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  b record;
  p public.attendance_policies;
  v_hours numeric;
  v_close timestamptz;
  v_count integer := 0;
  v_break_id uuid;
  v_user uuid;
  v_name text;
  v_label text;
  v_over integer;
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
      update public.attendance_sessions
      set clock_out_at = v_close, clock_out_source = 'auto', status = 'auto_closed', needs_review = true,
          review_reason = 'Closed automatically — no clock-out was recorded. Check the actual end time.'
      where id = r.id;
      insert into public.attendance_events (organization_id, session_id, employee_id, event_type, occurred_at, source)
      values (r.organization_id, r.id, r.employee_id, 'auto_clock_out', v_close, 'auto');
      -- Closes any open break at the clock-out and evaluates it.
      perform private.recompute_attendance_session(r.id, false);
    else
      update public.attendance_sessions
      set status = 'missing_out', needs_review = true,
          review_reason = 'No clock-out recorded — request a correction with the actual end time.'
      where id = r.id;
    end if;
    v_count := v_count + 1;
  end loop;

  -- Someone still out past their allowance (+ grace): tell their approvers
  -- and remind them, once per break.
  for b in
    select br.* from public.attendance_breaks br
    join public.attendance_sessions s on s.id = br.session_id
    where br.ended_at is null and br.allowed_minutes is not null and br.overrun_alerted_at is null
      and s.status = 'open' and s.clock_out_at is null
      and (p_employee_id is null or br.employee_id = p_employee_id)
      and now() > br.started_at + make_interval(mins => br.allowed_minutes + br.grace_minutes)
  loop
    update public.attendance_breaks set overrun_alerted_at = now() where id = b.id;
    v_over := floor(extract(epoch from (now() - b.started_at)) / 60)::integer - b.allowed_minutes;
    v_label := case b.break_type when 'lunch' then 'lunch' else 'break' end;
    v_name := private.employee_display_name(b.employee_id);
    for v_user in select * from private.attendance_approver_user_ids(b.employee_id) loop
      perform private.create_notification(
        b.organization_id, v_user, b.employee_id, 'attendance.break_overrun',
        v_name || ' is ' || v_over || ' min over their ' || v_label,
        'Still on ' || v_label || ' (' || b.allowed_minutes || ' min allowed).',
        '/team/attendance', jsonb_build_object('break_id', b.id)
      );
    end loop;
    select user_id into v_user from public.employees where id = b.employee_id;
    if v_user is not null then
      perform private.create_notification(
        b.organization_id, v_user, b.employee_id, 'attendance.break_overrun',
        'Your ' || v_label || ' time is up',
        'You''re ' || v_over || ' min over your ' || b.allowed_minutes || '-minute ' || v_label || '. End it from the timer at the top of the page.',
        '/time', jsonb_build_object('break_id', b.id)
      );
    end if;
  end loop;

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Clock and breaks
-- ---------------------------------------------------------------------------

create or replace function public.clock_out(p_location jsonb default null, p_source text default 'web')
returns public.attendance_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  v_session public.attendance_sessions;
  v_break_id uuid;
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

  for v_break_id in
    update public.attendance_breaks set ended_at = now() where session_id = v_session.id and ended_at is null returning id
  loop
    insert into public.attendance_events (organization_id, session_id, employee_id, event_type, occurred_at, source, recorded_by)
    values (v_employee.organization_id, v_session.id, v_employee.id, 'break_end', now(), 'web', auth.uid());
    perform private.evaluate_break(v_break_id);
  end loop;

  update public.attendance_sessions
  set clock_out_at = now(), clock_out_source = 'web', status = 'closed'
  where id = v_session.id
  returning * into v_session;

  insert into public.attendance_events (organization_id, session_id, employee_id, event_type, occurred_at, source, recorded_by)
  values (v_employee.organization_id, v_session.id, v_employee.id, 'clock_out', v_session.clock_out_at, 'web', auth.uid());

  return private.recompute_attendance_session(v_session.id, false);
end;
$$;

-- A lunch or a short break. Its allowance comes from the policy; one taken
-- beyond the number allowed per shift is allowed 0 minutes, so all of it is
-- reported as extra.
drop function if exists public.start_break();
create or replace function public.start_break(p_type text default 'break')
returns public.attendance_breaks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.attendance_sessions := private.my_open_session();
  v_break public.attendance_breaks;
  p public.attendance_policies;
  v_used integer;
  v_per_shift integer;
  v_length integer;
begin
  if p_type is null or p_type not in ('break', 'lunch') then
    raise exception using errcode = '22023', message = 'Choose lunch or a break';
  end if;
  if v_session.id is null then
    raise exception using errcode = '23514', message = 'Clock in before starting a break';
  end if;
  if not private.has_permission(v_session.organization_id, 'attendance.clock_self') then
    raise exception using errcode = '42501', message = 'Your role doesn''t include recording attendance';
  end if;
  if exists (select 1 from public.attendance_breaks where session_id = v_session.id and ended_at is null) then
    raise exception using errcode = '23505', message = 'You''re already on a break';
  end if;

  p := private.employee_attendance_policy(v_session.employee_id);
  v_per_shift := case p_type when 'lunch' then coalesce(p.lunches_per_shift, 1) else coalesce(p.short_breaks_per_shift, 2) end;
  v_length := case p_type when 'lunch' then coalesce(p.lunch_minutes, 60) else coalesce(p.short_break_minutes, 15) end;
  select count(*) into v_used from public.attendance_breaks where session_id = v_session.id and break_type = p_type;

  insert into public.attendance_breaks (organization_id, session_id, employee_id, started_at, break_type, allowed_minutes, grace_minutes, paid)
  values (
    v_session.organization_id, v_session.id, v_session.employee_id, now(), p_type,
    case when v_used >= v_per_shift then 0 else v_length end,
    coalesce(p.break_overrun_grace_minutes, 2),
    p_type = 'break' and coalesce(p.short_breaks_paid, true)
  )
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
  perform private.evaluate_break(v_break.id);
  perform private.recompute_attendance_session(v_session.id, false);
  return v_break;
end;
$$;

revoke execute on function public.start_break(text) from public, anon;
grant execute on function public.start_break(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. The manager's decision
-- ---------------------------------------------------------------------------

-- excused    — no consequence; the extra time is treated like the allowance.
-- deduct_pay — the extra minutes are unpaid (excluded from worked time and
--              listed as "deducted from pay" for payroll).
-- make_up    — the employee works the minutes back by p_makeup_due_date
--              (default: the later of the break's day and today); time
--              worked beyond the schedule from the break's day to then is
--              credited automatically and isn't overtime.
-- A decision can be changed until the time has been made up (e.g. switch an
-- overdue make-up to a deduction).
create or replace function public.decide_attendance_violation(
  p_violation_id uuid,
  p_resolution text,
  p_note text default null,
  p_makeup_due_date date default null
)
returns public.attendance_violations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.attendance_violations;
  v_today date;
  v_due date;
  v_user uuid;
  v_label text;
  v_title text;
  v_body text;
begin
  select * into v from public.attendance_violations where id = p_violation_id for update;
  if v.id is null then
    raise exception using errcode = 'P0002', message = 'This break record was not found';
  end if;
  if not private.can_adjust_attendance(v.organization_id, v.employee_id) then
    raise exception using errcode = '42501', message = 'Not authorized to decide this employee''s attendance';
  end if;
  if v.employee_id = private.current_employee_id() then
    raise exception using errcode = '42501', message = 'You can''t decide your own break time';
  end if;
  if p_resolution is null or p_resolution not in ('excused', 'deduct_pay', 'make_up') then
    raise exception using errcode = '22023', message = 'Choose excuse, deduct from pay, or make up the time';
  end if;
  if v.status = 'made_up' then
    raise exception using errcode = '23514', message = 'This time has already been made up';
  end if;

  v_today := private.org_today(v.organization_id);
  if p_resolution = 'make_up' then
    v_due := coalesce(p_makeup_due_date, greatest(v.work_date, v_today));
    if v_due < v.work_date or v_due > greatest(v.work_date, v_today) + 31 then
      raise exception using errcode = '22023', message = 'Choose a make-up date between the day of the break and a month from now';
    end if;
  end if;

  update public.attendance_violations
  set status = p_resolution,
      makeup_due_date = v_due,
      makeup_credited_minutes = 0,
      decision_note = nullif(btrim(coalesce(p_note, '')), ''),
      decided_by = auth.uid(),
      decided_at = now()
  where id = v.id;

  -- Worked time and overtime follow the decision; make-up is credited here.
  perform private.recompute_attendance_session(v.session_id, false);
  select * into v from public.attendance_violations where id = p_violation_id;

  v_label := case when v.kind like '%lunch%' then 'lunch' else 'break' end;
  v_title := case p_resolution
    when 'excused' then 'Your ' || v_label || ' overrun was excused'
    when 'deduct_pay' then v.overrun_minutes || ' min will be deducted from your pay'
    else 'Please make up ' || v.overrun_minutes || ' min'
  end;
  v_body := case p_resolution
    when 'excused' then 'No further action is needed.'
    when 'deduct_pay' then 'For the ' || v_label || ' on ' || to_char(v.work_date, 'Mon DD') || ' (' || v.actual_minutes || ' min, ' || v.allowed_minutes || ' allowed).'
    else 'Work ' || v.overrun_minutes || ' extra min before or after your shift by ' || to_char(v.makeup_due_date, 'Dy Mon DD')
      || '. It''s credited automatically' || case when v.status = 'made_up' then ' — already done.' else '.' end
  end || coalesce(' Note: ' || v.decision_note, '');
  select user_id into v_user from public.employees where id = v.employee_id;
  if v_user is not null then
    perform private.create_notification(
      v.organization_id, v_user, v.employee_id, 'attendance.break_overrun_decided', v_title, v_body, '/time',
      jsonb_build_object('violation_id', v.id, 'resolution', p_resolution)
    );
  end if;

  perform private.log_audit_event(
    v.organization_id, 'ATTENDANCE_VIOLATION_DECIDED', 'attendance_violation', v.id, null, to_jsonb(v)
  );
  return v;
end;
$$;

revoke execute on function public.decide_attendance_violation(uuid, text, text, date) from public, anon;
grant execute on function public.decide_attendance_violation(uuid, text, text, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. The live clock (top bar timer, clock cards)
-- ---------------------------------------------------------------------------

-- Everything the timer needs, with the server's own time so the client can
-- correct for a wrong device clock.
create or replace function public.get_my_clock_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  p public.attendance_policies;
  v_open public.attendance_sessions;
  v_break public.attendance_breaks;
  v_mode text;
  v_unpaid integer := 0;
  v_owed integer;
  v_due date;
  v_today date;
begin
  select * into v_employee from public.employees where id = private.current_employee_id();
  if v_employee.id is null then
    return null;
  end if;
  v_today := private.org_today(v_employee.organization_id);
  p := private.employee_attendance_policy(v_employee.id);
  v_open := private.my_open_session();
  v_mode := coalesce(v_open.break_deduction, p.break_deduction, 'recorded');

  if v_open.id is not null then
    select * into v_break from public.attendance_breaks where session_id = v_open.id and ended_at is null limit 1;
    select coalesce(sum(private.break_unpaid_minutes(b.break_type, m.minutes, b.allowed_minutes, b.grace_minutes, b.paid, v_mode, v.status)), 0)::integer
    into v_unpaid
    from public.attendance_breaks b
    cross join lateral (select floor(extract(epoch from (b.ended_at - b.started_at)) / 60)::integer as minutes) m
    left join public.attendance_violations v on v.break_id = b.id
    where b.session_id = v_open.id and b.ended_at is not null;
  end if;

  select coalesce(sum(overrun_minutes - makeup_credited_minutes), 0)::integer, min(makeup_due_date)
  into v_owed, v_due
  from public.attendance_violations
  where employee_id = v_employee.id and status = 'make_up' and makeup_due_date >= v_today;

  return jsonb_build_object(
    'server_now', now(),
    'timezone', private.org_timezone(v_employee.organization_id),
    'can_clock', v_employee.status = 'active' and private.has_permission(v_employee.organization_id, 'attendance.clock_self'),
    'session', case when v_open.id is null then null else jsonb_build_object(
      'id', v_open.id, 'clock_in_at', v_open.clock_in_at,
      'scheduled_start_at', v_open.scheduled_start_at, 'scheduled_end_at', v_open.scheduled_end_at,
      'arrival_status', v_open.arrival_status, 'late_minutes', v_open.late_minutes) end,
    'current_break', case when v_break.id is null then null else jsonb_build_object(
      'id', v_break.id, 'type', v_break.break_type, 'started_at', v_break.started_at,
      'allowed_minutes', v_break.allowed_minutes, 'grace_minutes', v_break.grace_minutes, 'paid', coalesce(v_break.paid, false)) end,
    'completed_unpaid_minutes', v_unpaid,
    'deduction_mode', v_mode,
    'breaks_used', jsonb_build_object(
      'lunch', (select count(*) from public.attendance_breaks where session_id = v_open.id and break_type = 'lunch'),
      'break', (select count(*) from public.attendance_breaks where session_id = v_open.id and break_type = 'break')),
    'allowances', jsonb_build_object(
      'lunch_minutes', coalesce(p.lunch_minutes, 60), 'lunches_per_shift', coalesce(p.lunches_per_shift, 1),
      'short_break_minutes', coalesce(p.short_break_minutes, 15), 'short_breaks_per_shift', coalesce(p.short_breaks_per_shift, 2),
      'grace_minutes', coalesce(p.break_overrun_grace_minutes, 2), 'short_breaks_paid', coalesce(p.short_breaks_paid, true)),
    'makeup_owed_minutes', v_owed,
    'makeup_due_date', v_due,
    'pending_violations', (select count(*) from public.attendance_violations where employee_id = v_employee.id and status = 'pending')
  );
end;
$$;

revoke execute on function public.get_my_clock_state() from public, anon;
grant execute on function public.get_my_clock_state() to authenticated;

-- ---------------------------------------------------------------------------
-- 10. Team views and reports
-- ---------------------------------------------------------------------------

-- Day view gains who is on lunch/break right now (with their allowance) and
-- pending break overruns.
drop function if exists public.list_attendance_day(uuid, date);
create or replace function public.list_attendance_day(p_organization_id uuid, p_date date default null)
returns table (
  employee_id uuid, employee_name text, employee_number text, department text,
  scheduled_start_at timestamptz, scheduled_end_at timestamptz,
  session_id uuid, clock_in_at timestamptz, clock_out_at timestamptz,
  worked_minutes integer, late_minutes integer, overtime_minutes integer, overtime_status text,
  day_status text, detail text, needs_review boolean,
  current_break_type text, current_break_started_at timestamptz, current_break_allowed_minutes integer, current_break_grace_minutes integer,
  pending_break_overruns integer
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
    coalesce(s.needs_review, false),
    br.break_type, br.started_at, br.allowed_minutes, br.grace_minutes,
    (select count(*)::integer from public.attendance_violations v where v.employee_id = e.id and v.work_date = v_date and v.status = 'pending')
  from public.employees e
  left join public.employee_assignments a on a.employee_id = e.id and a.end_date is null
  left join public.org_units ou on ou.id = a.org_unit_id
  left join lateral (select * from private.scheduled_shift(e.id, v_date)) sh on true
  left join lateral (
    select x.* from public.attendance_sessions x
    where x.employee_id = e.id and x.work_date = v_date
    -- The live session if there is one, else the latest.
    order by (x.clock_out_at is null and x.status = 'open') desc, x.clock_in_at desc limit 1
  ) s on true
  left join lateral (
    select y.* from public.attendance_breaks y
    where y.session_id = s.id and y.ended_at is null and s.clock_out_at is null and s.status = 'open'
    limit 1
  ) br on true
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

-- Exceptions gain break overruns awaiting a decision and overdue make-up.
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
  select v.employee_id, pp.name, v.work_date, 'break_overrun',
    case v.kind
      when 'lunch_overrun' then 'Lunch ran ' || v.overrun_minutes || ' min over (' || v.actual_minutes || ' of ' || v.allowed_minutes || ' min)'
      when 'break_overrun' then 'Break ran ' || v.overrun_minutes || ' min over (' || v.actual_minutes || ' of ' || v.allowed_minutes || ' min)'
      when 'extra_lunch' then 'Extra lunch (' || v.actual_minutes || ' min)'
      else 'Extra break (' || v.actual_minutes || ' min)'
    end, v.session_id
    from public.attendance_violations v join people pp on pp.id = v.employee_id
    where v.status = 'pending' and v.work_date between p_from and p_to
  union all
  select v.employee_id, pp.name, v.work_date, 'makeup_overdue',
    'Owes ' || (v.overrun_minutes - v.makeup_credited_minutes) || ' min — make-up was due ' || to_char(v.makeup_due_date, 'Mon DD'), v.session_id
    from public.attendance_violations v join people pp on pp.id = v.employee_id
    where v.status = 'make_up' and v.makeup_due_date < v_today and v.work_date between p_from and p_to
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

-- The HR report gains break overruns, minutes deducted from pay, and
-- make-up still owed.
drop function if exists public.attendance_report(uuid, date, date, uuid);
create or replace function public.attendance_report(p_organization_id uuid, p_from date, p_to date, p_org_unit_id uuid default null)
returns table (
  employee_id uuid, employee_name text, employee_number text, department text,
  days_worked integer, worked_minutes integer, late_count integer, absent_count integer,
  missing_clock_out_count integer, early_departure_count integer,
  overtime_minutes integer, overtime_pending_minutes integer,
  break_overrun_count integer, deducted_minutes integer, makeup_owed_minutes integer
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
    coalesce((select sum(s.overtime_minutes) from public.attendance_sessions s where s.employee_id = e.id and s.work_date between p_from and p_to and s.overtime_status = 'pending'), 0)::integer,
    (select count(*) from public.attendance_violations v where v.employee_id = e.id and v.work_date between p_from and p_to)::integer,
    coalesce((select sum(v.overrun_minutes) from public.attendance_violations v where v.employee_id = e.id and v.work_date between p_from and p_to and v.status = 'deduct_pay'), 0)::integer,
    coalesce((select sum(v.overrun_minutes - v.makeup_credited_minutes) from public.attendance_violations v where v.employee_id = e.id and v.work_date between p_from and p_to and v.status = 'make_up'), 0)::integer
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
-- 11. Policy and holiday edits stay audited (trigger from 20261005100000);
--     check every 5 minutes so an overrun alert is timely.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'halomanage-attendance-maintenance') then
      perform cron.unschedule('halomanage-attendance-maintenance');
    end if;
    perform cron.schedule('halomanage-attendance-maintenance', '*/5 * * * *', 'select private.flag_stale_attendance(null)');
  end if;
exception when others then
  raise notice 'pg_cron scheduling skipped: %', sqlerrm;
end $$;
