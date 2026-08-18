-- Halomanage — schedules and attendance
-- Ref: PRODUCT_BLUEPRINT.md "Attendance"; ARCHITECTURE.md "Attendance sign-in
-- and sign-out" + "Attendance SQL and protected clock operations".
--
-- Attendance is persistent database state, never Supabase Presence (Presence
-- reflects connected-client state and is fine for "who's online right now"
-- dashboards, not for the attendance system of record). Clock timestamps are
-- always server-set (now()) inside SECURITY INVOKER RPCs — never a
-- client-writable column — and corrections are additive rows
-- (attendance_adjustments), never an in-place UPDATE of history.

create table public.work_schedules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.work_schedules enable row level security;
create index work_schedules_org_idx on public.work_schedules(organization_id);

create table public.schedule_shifts (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.work_schedules(id) on delete cascade,
  -- 0 = Sunday .. 6 = Saturday
  day_of_week smallint not null check (day_of_week between 0 and 6),
  start_time time not null,
  end_time time not null,
  break_minutes integer not null default 0,
  check (end_time > start_time)
);
alter table public.schedule_shifts enable row level security;
create index schedule_shifts_schedule_idx on public.schedule_shifts(schedule_id);

create table public.schedule_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  schedule_id uuid not null references public.work_schedules(id) on delete restrict,
  start_date date not null,
  end_date date,
  created_at timestamptz not null default now(),
  check (end_date is null or end_date >= start_date)
);
alter table public.schedule_assignments enable row level security;
create index schedule_assignments_employee_idx on public.schedule_assignments(employee_id, start_date desc);
create unique index schedule_assignments_one_open
  on public.schedule_assignments(employee_id) where end_date is null;

create table public.holidays (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  location_id uuid references public.locations(id) on delete cascade,
  name text not null,
  observed_on date not null,
  is_paid boolean not null default true
);
alter table public.holidays enable row level security;
create index holidays_org_idx on public.holidays(organization_id, observed_on);

create table public.attendance_policies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  is_default boolean not null default false,
  grace_period_minutes integer not null default 0,
  rounding_minutes integer not null default 0,
  overtime_requires_approval boolean not null default true,
  allow_mobile_clock boolean not null default true,
  allow_geofencing boolean not null default false,
  auto_clock_out_after_hours numeric(4,1),
  created_at timestamptz not null default now()
);
alter table public.attendance_policies enable row level security;
create index attendance_policies_org_idx on public.attendance_policies(organization_id);

-- The attendance record. One row per employee per open/closed session
-- (usually one per work day, but overnight shifts can cross midnight).
create table public.attendance_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  work_date date not null,
  clock_in_at timestamptz not null,
  clock_out_at timestamptz,
  scheduled_start_at timestamptz,
  scheduled_end_at timestamptz,
  status text not null default 'open'
    check (status in ('open', 'closed', 'corrected', 'auto_closed')),
  clock_in_source text not null default 'web' check (clock_in_source in ('web', 'mobile', 'kiosk', 'admin')),
  clock_out_source text check (clock_out_source in ('web', 'mobile', 'kiosk', 'admin', 'auto')),
  clock_in_location jsonb,
  clock_out_location jsonb,
  created_at timestamptz not null default now()
);
alter table public.attendance_sessions enable row level security;
create index attendance_employee_date_idx on public.attendance_sessions(employee_id, work_date desc);
create index attendance_org_date_idx on public.attendance_sessions(organization_id, work_date desc);
-- Only one open session per employee — enforced by the database, not a
-- disabled frontend button.
create unique index attendance_one_open_session
  on public.attendance_sessions(employee_id)
  where clock_out_at is null;

-- Immutable event log backing each session — every clock action and every
-- applied correction is appended here and never edited.
create table public.attendance_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  session_id uuid not null references public.attendance_sessions(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  event_type text not null
    check (event_type in ('clock_in', 'clock_out', 'break_start', 'break_end', 'adjustment_applied', 'auto_clock_out')),
  occurred_at timestamptz not null default now(),
  source text not null default 'web',
  device_metadata jsonb,
  location jsonb,
  recorded_by uuid references auth.users(id)
);
alter table public.attendance_events enable row level security;
create index attendance_events_session_idx on public.attendance_events(session_id, occurred_at);
create index attendance_events_employee_idx on public.attendance_events(employee_id, occurred_at desc);

-- Corrections are requested, approved/rejected, and applied — the original
-- value is preserved forever (ARCHITECTURE.md rule: "never silently
-- overwrite a clock punch").
create table public.attendance_adjustments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  session_id uuid not null references public.attendance_sessions(id) on delete cascade,
  field text not null check (field in ('clock_in_at', 'clock_out_at')),
  original_value timestamptz,
  requested_value timestamptz not null,
  reason text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by uuid not null references auth.users(id),
  requested_at timestamptz not null default now(),
  decided_by uuid references auth.users(id),
  decided_at timestamptz,
  decision_note text
);
alter table public.attendance_adjustments enable row level security;
create index attendance_adjustments_session_idx on public.attendance_adjustments(session_id);
create index attendance_adjustments_org_status_idx on public.attendance_adjustments(organization_id, status);

-- ---------------------------------------------------------------------------
-- RPCs — the only way attendance_sessions rows are ever created/mutated.
--
-- These are SECURITY DEFINER, not INVOKER: there is deliberately no
-- INSERT/UPDATE policy on attendance_sessions/attendance_events/
-- attendance_adjustments for the `authenticated` role (see RLS policies
-- below), so the manual authorization checks inside each function body are
-- the *only* gate on a write — which is the point: a client can only ever
-- reach these tables through the exact business rules encoded here.
-- ---------------------------------------------------------------------------

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
  select e.* into v_employee
  from public.employees e
  where e.user_id = (select auth.uid())
    and e.status = 'active';

  if v_employee.id is null then
    raise exception 'No active employee record for the current user';
  end if;

  if exists (
    select 1 from public.attendance_sessions s
    where s.employee_id = v_employee.id and s.clock_out_at is null
  ) then
    raise exception 'Employee is already clocked in';
  end if;

  insert into public.attendance_sessions (
    organization_id, employee_id, work_date, clock_in_at, clock_in_source, clock_in_location
  )
  values (
    v_employee.organization_id, v_employee.id, (now() at time zone coalesce(
      (select o.timezone from public.organizations o where o.id = v_employee.organization_id), 'UTC'
    ))::date,
    now(), coalesce(p_source, 'web'), p_location
  )
  returning * into v_session;

  insert into public.attendance_events (
    organization_id, session_id, employee_id, event_type, occurred_at, source, location, recorded_by
  )
  values (
    v_employee.organization_id, v_session.id, v_employee.id, 'clock_in', v_session.clock_in_at,
    coalesce(p_source, 'web'), p_location, auth.uid()
  );

  return v_session;
end;
$$;

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
  select e.* into v_employee
  from public.employees e
  where e.user_id = (select auth.uid());

  if v_employee.id is null then
    raise exception 'No employee record for the current user';
  end if;

  select s.* into v_session
  from public.attendance_sessions s
  where s.employee_id = v_employee.id and s.clock_out_at is null
  for update;

  if v_session.id is null then
    raise exception 'Employee is not currently clocked in';
  end if;

  update public.attendance_sessions
  set clock_out_at = now(), clock_out_source = coalesce(p_source, 'web'),
      clock_out_location = p_location, status = 'closed'
  where id = v_session.id
  returning * into v_session;

  insert into public.attendance_events (
    organization_id, session_id, employee_id, event_type, occurred_at, source, location, recorded_by
  )
  values (
    v_employee.organization_id, v_session.id, v_employee.id, 'clock_out', v_session.clock_out_at,
    coalesce(p_source, 'web'), p_location, auth.uid()
  );

  return v_session;
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
  v_requester_employee_id uuid := private.current_employee_id();
  v_original timestamptz;
  v_row public.attendance_adjustments;
begin
  select * into v_session from public.attendance_sessions where id = p_session_id;
  if v_session.id is null then
    raise exception 'Attendance session not found';
  end if;

  if p_field not in ('clock_in_at', 'clock_out_at') then
    raise exception 'Invalid field %', p_field;
  end if;

  if v_session.employee_id != v_requester_employee_id
     and not private.has_permission(v_session.organization_id, 'attendance.adjust_team')
  then
    raise exception 'Not authorized to request a correction on this session';
  end if;

  v_original := case p_field when 'clock_in_at' then v_session.clock_in_at else v_session.clock_out_at end;

  insert into public.attendance_adjustments (
    organization_id, employee_id, session_id, field, original_value, requested_value, reason, requested_by
  )
  values (
    v_session.organization_id, v_session.employee_id, p_session_id, p_field, v_original,
    p_requested_value, p_reason, auth.uid()
  )
  returning * into v_row;

  perform private.log_audit_event(
    v_session.organization_id, 'ATTENDANCE_ADJUSTMENT_REQUESTED', 'attendance_adjustment', v_row.id,
    null, to_jsonb(v_row)
  );

  return v_row;
end;
$$;

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
begin
  select * into v_adj from public.attendance_adjustments where id = p_adjustment_id for update;
  if v_adj.id is null then
    raise exception 'Adjustment not found';
  end if;
  if v_adj.status != 'pending' then
    raise exception 'Adjustment has already been decided';
  end if;

  if not (
    private.in_management_scope(v_adj.employee_id) and private.has_permission(v_adj.organization_id, 'attendance.adjust_team')
  ) and not private.has_permission(v_adj.organization_id, 'attendance.read_org') then
    raise exception 'Not authorized to decide this adjustment';
  end if;

  update public.attendance_adjustments
  set status = case when p_approve then 'approved' else 'rejected' end,
      decided_by = auth.uid(), decided_at = now(), decision_note = p_note
  where id = p_adjustment_id
  returning * into v_adj;

  if p_approve then
    if v_adj.field = 'clock_in_at' then
      update public.attendance_sessions set clock_in_at = v_adj.requested_value, status = 'corrected'
      where id = v_adj.session_id;
    else
      update public.attendance_sessions set clock_out_at = v_adj.requested_value, status = 'corrected'
      where id = v_adj.session_id;
    end if;

    insert into public.attendance_events (
      organization_id, session_id, employee_id, event_type, occurred_at, source, recorded_by
    )
    values (v_adj.organization_id, v_adj.session_id, v_adj.employee_id, 'adjustment_applied', now(), 'admin', auth.uid());
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
-- RLS policies
-- ---------------------------------------------------------------------------

create policy "org members read schedules" on public.work_schedules for select to authenticated
  using (private.is_org_member(organization_id));
create policy "admins manage schedules" on public.work_schedules for all to authenticated
  using (private.has_permission(organization_id, 'attendance.manage_policies'))
  with check (private.has_permission(organization_id, 'attendance.manage_policies'));

create policy "org members read shifts" on public.schedule_shifts for select to authenticated
  using (private.is_org_member((select organization_id from public.work_schedules w where w.id = schedule_id)));
create policy "admins manage shifts" on public.schedule_shifts for all to authenticated
  using (private.has_permission((select organization_id from public.work_schedules w where w.id = schedule_id), 'attendance.manage_policies'))
  with check (private.has_permission((select organization_id from public.work_schedules w where w.id = schedule_id), 'attendance.manage_policies'));

create policy "read own schedule assignment" on public.schedule_assignments for select to authenticated
  using (employee_id = private.current_employee_id());
create policy "read team schedule assignments" on public.schedule_assignments for select to authenticated
  using (private.has_permission(organization_id, 'attendance.read_team') and private.in_management_scope(employee_id));
create policy "admins manage schedule assignments" on public.schedule_assignments for all to authenticated
  using (private.has_permission(organization_id, 'attendance.manage_policies'))
  with check (private.has_permission(organization_id, 'attendance.manage_policies'));

create policy "org members read holidays" on public.holidays for select to authenticated
  using (private.is_org_member(organization_id));
create policy "admins manage holidays" on public.holidays for all to authenticated
  using (private.has_permission(organization_id, 'attendance.manage_policies'))
  with check (private.has_permission(organization_id, 'attendance.manage_policies'));

create policy "org members read attendance policies" on public.attendance_policies for select to authenticated
  using (private.is_org_member(organization_id));
create policy "admins manage attendance policies" on public.attendance_policies for all to authenticated
  using (private.has_permission(organization_id, 'attendance.manage_policies'))
  with check (private.has_permission(organization_id, 'attendance.manage_policies'));

create policy "read own attendance" on public.attendance_sessions for select to authenticated
  using (employee_id = private.current_employee_id());
create policy "read team attendance" on public.attendance_sessions for select to authenticated
  using (private.has_permission(organization_id, 'attendance.read_team') and private.in_management_scope(employee_id));
create policy "read org attendance" on public.attendance_sessions for select to authenticated
  using (private.has_permission(organization_id, 'attendance.read_org'));
-- No direct insert/update/delete policy on attendance_sessions: rows are
-- only ever written by clock_in()/clock_out()/decide_attendance_adjustment()
-- (all SECURITY INVOKER, so they still run under the caller's RLS/grants,
-- but the table itself grants no direct write path around them).

create policy "read own attendance events" on public.attendance_events for select to authenticated
  using (employee_id = private.current_employee_id());
create policy "read team attendance events" on public.attendance_events for select to authenticated
  using (private.has_permission(organization_id, 'attendance.read_team') and private.in_management_scope(employee_id));
create policy "read org attendance events" on public.attendance_events for select to authenticated
  using (private.has_permission(organization_id, 'attendance.read_org'));

create policy "read own adjustments" on public.attendance_adjustments for select to authenticated
  using (employee_id = private.current_employee_id());
create policy "read team adjustments" on public.attendance_adjustments for select to authenticated
  using (private.has_permission(organization_id, 'attendance.adjust_team') and private.in_management_scope(employee_id));
create policy "read org adjustments" on public.attendance_adjustments for select to authenticated
  using (private.has_permission(organization_id, 'attendance.read_org'));
-- Writes to attendance_adjustments go only through
-- request_attendance_adjustment()/decide_attendance_adjustment().

-- PostgreSQL grants EXECUTE to PUBLIC by default on new functions; lock
-- these down to authenticated app users only (ARCHITECTURE.md rule: "revoke
-- unnecessary function execution grants"). anon can't usefully call them
-- anyway (auth.uid() is null → "no employee record" exception), but least
-- privilege is enforced explicitly rather than incidentally.
revoke execute on function public.clock_in(jsonb, text) from public;
revoke execute on function public.clock_out(jsonb, text) from public;
revoke execute on function public.request_attendance_adjustment(uuid, text, timestamptz, text) from public;
revoke execute on function public.decide_attendance_adjustment(uuid, boolean, text) from public;
grant execute on function public.clock_in(jsonb, text) to authenticated;
grant execute on function public.clock_out(jsonb, text) to authenticated;
grant execute on function public.request_attendance_adjustment(uuid, text, timestamptz, text) to authenticated;
grant execute on function public.decide_attendance_adjustment(uuid, boolean, text) to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.attendance_sessions;
  end if;
end $$;
