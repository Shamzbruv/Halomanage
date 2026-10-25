-- Attendance review periods and immutable approved-hour exports. No pay calculation.
-- RPC-only writes, tenant/scoped reads, independent employee/manager sign-off.
create table public.attendance_periods (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id),
 name text not null check (length(trim(name)) between 1 and 120),
 period_start date not null, period_end date not null,
 status text not null default 'open' check (status in ('open','locked')),
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
 locked_by uuid references auth.users(id), locked_at timestamptz,
 check (period_end >= period_start and period_end - period_start <= 61)
);
create index attendance_periods_org_dates on public.attendance_periods(organization_id,period_start,period_end);
alter table public.attendance_periods enable row level security;
create table public.attendance_timesheets (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id),
 period_id uuid not null references public.attendance_periods(id),
 employee_id uuid not null references public.employees(id),
 employee_name text not null, employee_number text not null,
 status text not null default 'draft' check (status in ('draft','submitted','approved','rejected')),
 revision integer not null default 0, snapshot jsonb,
 submitted_by uuid references auth.users(id), submitted_at timestamptz,
 decided_by uuid references auth.users(id), decided_at timestamptz, decision_note text,
 unique(period_id,employee_id)
);
create index attendance_timesheets_employee on public.attendance_timesheets(employee_id,period_id);
create index attendance_timesheets_org on public.attendance_timesheets(organization_id,status);
alter table public.attendance_timesheets enable row level security;
create policy "scoped timesheet reads" on public.attendance_timesheets for select to authenticated
 using (employee_id = private.current_employee_id() or private.can_view_attendance(organization_id,employee_id));
create policy "member review periods" on public.attendance_periods for select to authenticated
 using (organization_id = (select organization_id from public.employees where id = private.current_employee_id()));
revoke all on public.attendance_periods, public.attendance_timesheets from anon, authenticated;
grant select on public.attendance_periods, public.attendance_timesheets to authenticated;

-- Serialize source mutations and sign-offs per tenant, including the final lock.
create function private.attendance_period_mutex(p_org uuid) returns void language sql volatile
set search_path = '' as $$ select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_org::text, 25015832)); $$;

create function private.timesheet_snapshot(p_employee uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_sessions jsonb; v_leave jsonb; v_regular int; v_ot int; v_paid int; v_unpaid int;
 v_deduct int; v_issues int; v_makeup int;
begin
 select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'date',s.work_date,'in',s.clock_in_at,'out',s.clock_out_at,
  'worked',s.worked_minutes,'overtime',s.overtime_minutes,'overtime_status',s.overtime_status,
  'breaks',s.break_minutes,'makeup',s.makeup_minutes,'needs_review',s.needs_review) order by s.work_date,s.id),'[]'),
  coalesce(sum(greatest(0,s.worked_minutes-s.overtime_minutes-s.makeup_minutes)),0),
  coalesce(sum(case when s.overtime_status in ('approved','not_required') then s.overtime_minutes else 0 end),0),
  coalesce(sum(s.makeup_minutes),0),
  count(*) filter (where s.clock_out_at is null or s.needs_review or s.overtime_status = 'pending')
 into v_sessions,v_regular,v_ot,v_makeup,v_issues
 from public.attendance_sessions s where s.employee_id=p_employee and s.work_date between p_from and p_to;
 select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'date',d.work_date,'fraction',d.day_fraction,'paid',lt.is_paid,
  'minutes',round(greatest(0,extract(epoch from (sh.end_at-sh.start_at))/60-sh.break_minutes)*d.day_fraction)::int)
  order by d.work_date,d.id),'[]'),
 coalesce(sum(case when lt.is_paid then round(greatest(0,extract(epoch from (sh.end_at-sh.start_at))/60-sh.break_minutes)*d.day_fraction) else 0 end),0),
 coalesce(sum(case when not lt.is_paid then round(greatest(0,extract(epoch from (sh.end_at-sh.start_at))/60-sh.break_minutes)*d.day_fraction) else 0 end),0)
 into v_leave,v_paid,v_unpaid from public.leave_request_days d
 join public.leave_requests r on r.id=d.leave_request_id and r.employee_id=p_employee and r.status='approved'
 join public.leave_types lt on lt.id=r.leave_type_id
 left join lateral private.scheduled_shift(p_employee,d.work_date) sh on true
 where d.work_date between p_from and p_to;
 v_issues := v_issues + (select count(*) from public.attendance_adjustments a join public.attendance_sessions s on s.id=a.session_id
  where a.employee_id=p_employee and a.status='pending' and s.work_date between p_from and p_to);
 select v_issues + count(*) filter (where v.status='pending' or (v.status='make_up' and v.makeup_credited_minutes<v.overrun_minutes)),
  coalesce(sum(case when v.status='deduct_pay' then v.overrun_minutes else 0 end),0)
 into v_issues,v_deduct from public.attendance_violations v where v.employee_id=p_employee and v.work_date between p_from and p_to;
 -- No inventing hours for leave without a schedule, or approving work overlapping leave.
 v_issues := v_issues + (select count(*) from (
  select d.work_date from public.leave_request_days d join public.leave_requests r on r.id=d.leave_request_id
  left join lateral private.scheduled_shift(p_employee,d.work_date) sh on true
  where r.employee_id=p_employee and r.status='approved' and d.work_date between p_from and p_to
  group by d.work_date,sh.start_at,sh.end_at,sh.break_minutes
  having sh.start_at is null or
   sum(round(greatest(0,extract(epoch from (sh.end_at-sh.start_at))/60-sh.break_minutes)*d.day_fraction))
    + coalesce((select sum(s.worked_minutes) from public.attendance_sessions s where s.employee_id=p_employee and s.work_date=d.work_date),0)
    > greatest(0,extract(epoch from (sh.end_at-sh.start_at))/60-sh.break_minutes)
 ) conflicts);
 return jsonb_build_object('sessions',v_sessions,'leave',v_leave,'regular_minutes',v_regular,'overtime_minutes',v_ot,
  'paid_leave_minutes',v_paid,'unpaid_leave_minutes',v_unpaid,'deducted_minutes',v_deduct,'makeup_minutes',v_makeup,'issues',v_issues);
end; $$;

create function public.create_attendance_period(p_organization_id uuid,p_name text,p_from date,p_to date)
returns public.attendance_periods language plpgsql security definer set search_path = '' as $$
declare p public.attendance_periods;
begin
 if auth.uid() is null or not private.has_permission(p_organization_id,'attendance.adjust_org') then raise exception 'Not authorized to create review periods'; end if;
 perform private.assert_step_up(p_organization_id);
 perform private.attendance_period_mutex(p_organization_id);
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>61 then raise exception 'Choose a period of 1–62 days'; end if;
 if exists(select 1 from public.attendance_periods where organization_id=p_organization_id and period_start<=p_to and period_end>=p_from) then
  raise exception 'This period overlaps an existing attendance review period'; end if;
 insert into public.attendance_periods(organization_id,name,period_start,period_end,created_by)
 values(p_organization_id,trim(p_name),p_from,p_to,auth.uid()) returning * into p;
 insert into public.attendance_timesheets(organization_id,period_id,employee_id,employee_name,employee_number)
 select p.organization_id,p.id,e.id,private.employee_display_name(e.id),e.employee_number from public.employees e
 where e.organization_id=p.organization_id and (e.status<>'prehire' and coalesce(e.hire_date,p_from)<=p_to
  and coalesce(e.termination_date,p_to)>=p_from or exists(select 1 from public.attendance_sessions s where s.employee_id=e.id and s.work_date between p_from and p_to));
 if not found then raise exception 'No employees are eligible for this period'; end if;
 perform private.log_audit_event(p.organization_id,'ATTENDANCE_PERIOD_CREATED','attendance_period',p.id,null,to_jsonb(p));
 return p;
end; $$;

create function public.preview_attendance_timesheet(p_timesheet_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.attendance_timesheets; p public.attendance_periods;
begin
 select * into t from public.attendance_timesheets where id=p_timesheet_id;
 if auth.uid() is null or t.id is null or not(t.employee_id=private.current_employee_id() or private.can_view_attendance(t.organization_id,t.employee_id)) then raise exception 'Timesheet not available'; end if;
 select * into p from public.attendance_periods where id=t.period_id;
 if p.status='locked' then return t.snapshot; end if;
 return private.timesheet_snapshot(t.employee_id,p.period_start,p.period_end);
end; $$;

create function public.act_on_attendance_timesheet(p_timesheet_id uuid,p_action text,p_note text default null)
returns public.attendance_timesheets language plpgsql security definer set search_path = '' as $$
declare t public.attendance_timesheets; old_t public.attendance_timesheets; p public.attendance_periods; v_snapshot jsonb;
begin
 select * into t from public.attendance_timesheets where id=p_timesheet_id;
 if auth.uid() is null or t.id is null then raise exception 'Timesheet not available'; end if;
 perform private.attendance_period_mutex(t.organization_id);
 select * into t from public.attendance_timesheets where id=p_timesheet_id for update;
 select * into p from public.attendance_periods where id=t.period_id for update;
 if p.status='locked' then raise exception 'This period is locked; HR must reopen it with a reason first'; end if;
 old_t:=t;
 if p_action in ('submit','withdraw') then
  if t.employee_id<>private.current_employee_id() then raise exception 'Only the employee can sign or withdraw their timesheet'; end if;
  if p_action='withdraw' then
   if t.status<>'submitted' then raise exception 'Only a submitted timesheet can be withdrawn'; end if;
   t.status:='draft'; t.submitted_by:=null; t.submitted_at:=null;
  else
   if t.status not in ('draft','rejected') then raise exception 'Withdraw or return the timesheet before resubmitting'; end if;
   if p.period_end>=private.org_today(p.organization_id) then raise exception 'The period must end before it can be signed'; end if;
   v_snapshot:=private.timesheet_snapshot(t.employee_id,p.period_start,p.period_end);
   if (v_snapshot->>'issues')::int>0 then raise exception 'Resolve missing clock-outs, pending corrections, overtime, break decisions or leave conflicts before submitting'; end if;
   t.snapshot:=v_snapshot; t.status:='submitted'; t.revision:=t.revision+1; t.submitted_by:=auth.uid(); t.submitted_at:=now();
   t.decided_by:=null; t.decided_at:=null; t.decision_note:=null;
  end if;
 elsif p_action in ('approve','reject') then
  if t.employee_id=private.current_employee_id() or not private.can_adjust_attendance(t.organization_id,t.employee_id) then raise exception 'An independent authorized reviewer is required'; end if;
  perform private.assert_step_up(t.organization_id);
  if p_action='reject' then
   if t.status not in ('submitted','approved') or nullif(trim(p_note),'') is null then raise exception 'A submitted/approved timesheet and return reason are required'; end if;
   t.status:='rejected';
  else
   if t.status<>'submitted' then raise exception 'The employee must sign the timesheet first'; end if;
   v_snapshot:=private.timesheet_snapshot(t.employee_id,p.period_start,p.period_end);
   if v_snapshot is distinct from t.snapshot then raise exception 'Attendance changed after employee sign-off; return it for a new signature'; end if;
   t.status:='approved';
  end if;
  t.decided_by:=auth.uid(); t.decided_at:=now(); t.decision_note:=nullif(trim(p_note),'');
 else raise exception 'Unknown timesheet action'; end if;
 update public.attendance_timesheets set status=t.status,revision=t.revision,snapshot=t.snapshot,submitted_by=t.submitted_by,
  submitted_at=t.submitted_at,decided_by=t.decided_by,decided_at=t.decided_at,decision_note=t.decision_note where id=t.id;
 perform private.log_audit_event(t.organization_id,'TIMESHEET_'||upper(p_action),'attendance_timesheet',t.id,to_jsonb(old_t),to_jsonb(t));
 return t;
end; $$;

create function public.set_attendance_period_lock(p_period_id uuid,p_locked boolean,p_note text default null)
returns public.attendance_periods language plpgsql security definer set search_path = '' as $$
declare p public.attendance_periods; t public.attendance_timesheets;
begin
 select * into p from public.attendance_periods where id=p_period_id;
 if auth.uid() is null or p.id is null or not private.has_permission(p.organization_id,'attendance.adjust_org') then raise exception 'Not authorized to lock review periods'; end if;
 perform private.assert_step_up(p.organization_id); perform private.attendance_period_mutex(p.organization_id);
 select * into p from public.attendance_periods where id=p_period_id for update;
 if p_locked is null or (p.status='locked')=p_locked then raise exception 'Period is already in that state'; end if;
 if p_locked then
  if p.period_end>=private.org_today(p.organization_id) then raise exception 'The period has not ended'; end if;
  for t in select * from public.attendance_timesheets where period_id=p.id loop
   if t.status<>'approved' or t.snapshot is distinct from private.timesheet_snapshot(t.employee_id,p.period_start,p.period_end) then
    raise exception 'Every employee must have a current, independently approved timesheet'; end if;
  end loop;
  -- Catch hires/backdated records added after the roster was created.
  if exists(select 1 from public.attendance_sessions s where s.organization_id=p.organization_id and s.work_date between p.period_start and p.period_end
    and not exists(select 1 from public.attendance_timesheets x where x.period_id=p.id and x.employee_id=s.employee_id)) then
   raise exception 'An employee with attendance is missing from this roster; add them before locking'; end if;
 else
  if nullif(trim(p_note),'') is null then raise exception 'A reason is required to reopen a period'; end if;
  perform private.log_audit_event(p.organization_id,'TIMESHEET_APPROVALS_SUPERSEDED','attendance_period',p.id,
   (select jsonb_agg(to_jsonb(x)) from public.attendance_timesheets x where period_id=p.id),jsonb_build_object('reason',trim(p_note)));
  update public.attendance_timesheets set status='draft',submitted_by=null,submitted_at=null,decided_by=null,decided_at=null,decision_note=null where period_id=p.id;
 end if;
 update public.attendance_periods set status=case when p_locked then 'locked' else 'open' end,
  locked_by=case when p_locked then auth.uid() end,locked_at=case when p_locked then now() end where id=p.id returning * into p;
 perform private.log_audit_event(p.organization_id,case when p_locked then 'ATTENDANCE_PERIOD_LOCKED' else 'ATTENDANCE_PERIOD_REOPENED' end,'attendance_period',p.id,null,jsonb_build_object('reason',p_note));
 return p;
end; $$;

create function public.export_attendance_period(p_period_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.attendance_periods; v_rows jsonb;
begin
 select * into p from public.attendance_periods where id=p_period_id;
 if auth.uid() is null or p.id is null or not private.has_permission(p.organization_id,'payroll.export') then raise exception 'Not authorized to export approved attendance'; end if;
 perform private.assert_step_up(p.organization_id); perform private.attendance_period_mutex(p.organization_id);
 select * into p from public.attendance_periods where id=p_period_id;
 if p.status<>'locked' then raise exception 'Lock the approved review period before exporting'; end if;
 select jsonb_agg(jsonb_build_object('employee_number',t.employee_number,'employee_name',t.employee_name,'period_start',p.period_start,'period_end',p.period_end,
  'revision',t.revision,'regular_minutes',t.snapshot->'regular_minutes','overtime_minutes',t.snapshot->'overtime_minutes',
  'paid_leave_minutes',t.snapshot->'paid_leave_minutes','unpaid_leave_minutes',t.snapshot->'unpaid_leave_minutes',
  'deducted_minutes',t.snapshot->'deducted_minutes','makeup_minutes',t.snapshot->'makeup_minutes') order by t.employee_number)
 into v_rows from public.attendance_timesheets t where t.period_id=p.id and t.status='approved';
 perform private.log_audit_event(p.organization_id,'ATTENDANCE_HOURS_EXPORTED','attendance_period',p.id,null,jsonb_build_object('rows',jsonb_array_length(v_rows)));
 return v_rows;
end; $$;

-- Protect old AND new dates on source changes. Checks also apply to service writes.
create function private.guard_locked_attendance_sources() returns trigger
language plpgsql security definer set search_path = '' as $$
declare j jsonb; v_emp uuid; v_org uuid; v_from date; v_to date; v_session uuid; v_req uuid;
begin
 if tg_op='UPDATE' and new is not distinct from old then return new; end if;
 for j in select x from jsonb_array_elements(case when tg_op='INSERT' then jsonb_build_array(to_jsonb(new)) when tg_op='DELETE' then jsonb_build_array(to_jsonb(old)) else jsonb_build_array(to_jsonb(old),to_jsonb(new)) end) x loop
  v_emp:=null; v_org:=null; v_from:=null; v_to:=null;
  if tg_table_name in ('attendance_sessions','attendance_violations') then
   v_emp:=(j->>'employee_id')::uuid; v_org:=(j->>'organization_id')::uuid; v_from:=(j->>'work_date')::date; v_to:=v_from;
  elsif tg_table_name in ('attendance_breaks','attendance_adjustments') then
   v_session:=(j->>'session_id')::uuid;
   select s.employee_id,s.organization_id,s.work_date,s.work_date into v_emp,v_org,v_from,v_to from public.attendance_sessions s where id=v_session;
  else
   if tg_table_name='leave_request_days' then
    v_req:=(j->>'leave_request_id')::uuid;
    select r.employee_id,r.organization_id into v_emp,v_org from public.leave_requests r where id=v_req;
    v_from:=(j->>'work_date')::date; v_to:=v_from;
   else
    v_emp:=(j->>'employee_id')::uuid; v_org:=(j->>'organization_id')::uuid; v_from:=(j->>'start_date')::date; v_to:=(j->>'end_date')::date;
   end if;
  end if;
  if v_org is not null then
   perform private.attendance_period_mutex(v_org);
   if exists(select 1 from public.attendance_periods p where p.organization_id=v_org and p.status='locked' and p.period_start<=v_to and p.period_end>=v_from) then
    raise exception 'Attendance period is locked. HR must reopen it with a reason before changing its records'; end if;
  end if;
 end loop;
 if tg_op='DELETE' then return old; end if; return new;
end; $$;
do $$ declare n text; begin
 foreach n in array array['attendance_sessions','attendance_breaks','attendance_adjustments','attendance_violations','leave_requests','leave_request_days'] loop
 execute format('create trigger guard_locked_period before insert or update or delete on public.%I for each row execute function private.guard_locked_attendance_sources()',n);
 end loop;
end $$;

-- Department policy groups: employee compensation override > department > default.
create table public.attendance_policy_groups (
 org_unit_id uuid primary key references public.org_units(id),
 organization_id uuid not null references public.organizations(id),
 policy_id uuid not null references public.attendance_policies(id)
);
create index attendance_policy_groups_org on public.attendance_policy_groups(organization_id);
create index attendance_policy_groups_policy on public.attendance_policy_groups(policy_id);
alter table public.attendance_policy_groups enable row level security;
create policy "policy managers read group rules" on public.attendance_policy_groups for select to authenticated
 using (private.has_permission(organization_id,'attendance.manage_policies'));
revoke all on public.attendance_policy_groups from anon,authenticated;
grant select on public.attendance_policy_groups to authenticated;
create function public.set_department_attendance_policy(p_org_unit_id uuid,p_policy_id uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
 select organization_id into v_org from public.org_units where id=p_org_unit_id;
 if auth.uid() is null or v_org is null or not private.has_permission(v_org,'attendance.manage_policies') then raise exception 'Not authorized to assign attendance policies'; end if;
 perform private.assert_step_up(v_org);
 if p_policy_id is not null and not exists(select 1 from public.attendance_policies where id=p_policy_id and organization_id=v_org) then raise exception 'Choose a policy from this organization'; end if;
 if p_policy_id is null then delete from public.attendance_policy_groups where org_unit_id=p_org_unit_id;
 else insert into public.attendance_policy_groups(org_unit_id,organization_id,policy_id) values(p_org_unit_id,v_org,p_policy_id)
  on conflict(org_unit_id) do update set policy_id=excluded.policy_id; end if;
 perform private.log_audit_event(v_org,'DEPARTMENT_ATTENDANCE_POLICY_SET','org_unit',p_org_unit_id,null,jsonb_build_object('policy_id',p_policy_id));
end; $$;
create function public.create_attendance_policy(p_organization_id uuid,p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$ declare v_id uuid;
begin
 if auth.uid() is null or not private.has_permission(p_organization_id,'attendance.manage_policies') then raise exception 'Not authorized to create attendance policies'; end if;
 if nullif(trim(p_name),'') is null or length(p_name)>120 then raise exception 'Enter a policy name of 1–120 characters'; end if;
 perform private.assert_step_up(p_organization_id);
 insert into public.attendance_policies(organization_id,name) values(p_organization_id,trim(p_name)) returning id into v_id;
 return v_id;
end; $$;
create or replace function private.employee_attendance_policy(p_employee_id uuid)
returns public.attendance_policies language sql stable security definer set search_path = '' as $$
 select ap.* from public.employees e
 left join lateral (select c.time_policy_id from public.employee_compensation c where c.employee_id=e.id
  and c.start_date<=private.org_today(e.organization_id) and (c.end_date is null or c.end_date>=private.org_today(e.organization_id)) order by c.start_date desc limit 1) c on true
 left join lateral (select g.policy_id from public.employee_assignments a join public.attendance_policy_groups g on g.org_unit_id=a.org_unit_id and g.organization_id=e.organization_id
  where a.employee_id=e.id and a.is_primary and a.start_date<=private.org_today(e.organization_id)
   and (a.end_date is null or a.end_date>=private.org_today(e.organization_id)) order by a.start_date desc limit 1) g on true
 join public.attendance_policies ap on ap.organization_id=e.organization_id
 where e.id=p_employee_id order by (ap.id=c.time_policy_id) desc nulls last,(ap.id=g.policy_id) desc nulls last,ap.is_default desc,ap.created_at limit 1;
$$;
-- Never inherit PUBLIC's default EXECUTE on these privileged entry points.
revoke all on function public.create_attendance_period(uuid,text,date,date),public.preview_attendance_timesheet(uuid),
 public.act_on_attendance_timesheet(uuid,text,text),public.set_attendance_period_lock(uuid,boolean,text),public.export_attendance_period(uuid),
 public.set_department_attendance_policy(uuid,uuid),public.create_attendance_policy(uuid,text) from public,anon;
grant execute on function public.create_attendance_period(uuid,text,date,date),public.preview_attendance_timesheet(uuid),
 public.act_on_attendance_timesheet(uuid,text,text),public.set_attendance_period_lock(uuid,boolean,text),public.export_attendance_period(uuid),
 public.set_department_attendance_policy(uuid,uuid),public.create_attendance_policy(uuid,text) to authenticated;

-- HR can add a missed hire, or explicitly exclude someone with no time/leave.
create function public.update_attendance_period_roster(p_period_id uuid,p_employee_id uuid,p_include boolean,p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare p public.attendance_periods; e public.employees;
begin
 select * into p from public.attendance_periods where id=p_period_id;
 if auth.uid() is null or p.id is null or not private.has_permission(p.organization_id,'attendance.adjust_org') then raise exception 'Not authorized to edit this roster'; end if;
 perform private.assert_step_up(p.organization_id); perform private.attendance_period_mutex(p.organization_id);
 select * into p from public.attendance_periods where id=p_period_id for update;
 if p.status<>'open' then raise exception 'Reopen the period before changing its roster'; end if;
 if nullif(trim(p_reason),'') is null or p_include is null then raise exception 'A roster change reason is required'; end if;
 select * into e from public.employees where id=p_employee_id and organization_id=p.organization_id;
 if e.id is null then raise exception 'Employee not found in this organization'; end if;
 if p_include then
  insert into public.attendance_timesheets(organization_id,period_id,employee_id,employee_name,employee_number)
  values(p.organization_id,p.id,e.id,private.employee_display_name(e.id),e.employee_number) on conflict(period_id,employee_id) do nothing;
 else
  if exists(select 1 from public.attendance_sessions s where s.employee_id=e.id and s.work_date between p.period_start and p.period_end)
   or exists(select 1 from public.leave_requests r where r.employee_id=e.id and r.status='approved' and r.start_date<=p.period_end and r.end_date>=p.period_start)
   or exists(select 1 from public.attendance_timesheets t where t.period_id=p.id and t.employee_id=e.id and t.status in ('submitted','approved')) then
   raise exception 'Cannot exclude an employee with attendance, approved leave or a signed timesheet'; end if;
  delete from public.attendance_timesheets where period_id=p.id and employee_id=e.id;
  if not exists(select 1 from public.attendance_timesheets where period_id=p.id) then raise exception 'A period needs at least one employee'; end if;
 end if;
 perform private.log_audit_event(p.organization_id,'ATTENDANCE_ROSTER_CHANGED','attendance_period',p.id,null,jsonb_build_object('employee_id',e.id,'included',p_include,'reason',trim(p_reason)));
end; $$;
revoke all on function public.update_attendance_period_roster(uuid,uuid,boolean,text) from public,anon;
grant execute on function public.update_attendance_period_roster(uuid,uuid,boolean,text) to authenticated;

create function public.can_review_attendance_timesheet(p_timesheet_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.attendance_timesheets t where t.id=p_timesheet_id and auth.uid() is not null
  and t.employee_id<>private.current_employee_id() and private.can_adjust_attendance(t.organization_id,t.employee_id));
$$;
revoke all on function public.can_review_attendance_timesheet(uuid) from public,anon;
grant execute on function public.can_review_attendance_timesheet(uuid) to authenticated;
