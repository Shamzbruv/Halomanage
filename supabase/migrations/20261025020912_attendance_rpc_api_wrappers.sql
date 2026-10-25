-- Keep privileged implementations outside the exposed API schema. Public RPCs
-- are invokers; the internal implementations retain their explicit auth, tenant,
-- management-scope and MFA checks. Only this new internal schema is granted,
-- never the existing private helpers. Do not expose attendance_internal in PostgREST.
create schema attendance_internal;
revoke all on schema attendance_internal from public,anon;
grant usage on schema attendance_internal to authenticated;

alter function public.create_attendance_period(uuid,text,date,date) set schema attendance_internal;
revoke all on function attendance_internal.create_attendance_period(uuid,text,date,date) from public,anon,authenticated;
grant execute on function attendance_internal.create_attendance_period(uuid,text,date,date) to authenticated;
create function public.create_attendance_period(p_organization_id uuid,p_name text,p_from date,p_to date) returns public.attendance_periods
language sql security invoker set search_path = '' as $$
 select * from attendance_internal.create_attendance_period(p_organization_id,p_name,p_from,p_to);
$$;
revoke all on function public.create_attendance_period(uuid,text,date,date) from public,anon;
grant execute on function public.create_attendance_period(uuid,text,date,date) to authenticated;

alter function public.preview_attendance_timesheet(uuid) set schema attendance_internal;
revoke all on function attendance_internal.preview_attendance_timesheet(uuid) from public,anon,authenticated;
grant execute on function attendance_internal.preview_attendance_timesheet(uuid) to authenticated;
create function public.preview_attendance_timesheet(p_timesheet_id uuid) returns jsonb
language sql security invoker set search_path = '' as $$
 select attendance_internal.preview_attendance_timesheet(p_timesheet_id);
$$;
revoke all on function public.preview_attendance_timesheet(uuid) from public,anon;
grant execute on function public.preview_attendance_timesheet(uuid) to authenticated;

alter function public.act_on_attendance_timesheet(uuid,text,text) set schema attendance_internal;
revoke all on function attendance_internal.act_on_attendance_timesheet(uuid,text,text) from public,anon,authenticated;
grant execute on function attendance_internal.act_on_attendance_timesheet(uuid,text,text) to authenticated;
create function public.act_on_attendance_timesheet(p_timesheet_id uuid,p_action text,p_note text default null) returns public.attendance_timesheets
language sql security invoker set search_path = '' as $$
 select * from attendance_internal.act_on_attendance_timesheet(p_timesheet_id,p_action,p_note);
$$;
revoke all on function public.act_on_attendance_timesheet(uuid,text,text) from public,anon;
grant execute on function public.act_on_attendance_timesheet(uuid,text,text) to authenticated;

alter function public.set_attendance_period_lock(uuid,boolean,text) set schema attendance_internal;
revoke all on function attendance_internal.set_attendance_period_lock(uuid,boolean,text) from public,anon,authenticated;
grant execute on function attendance_internal.set_attendance_period_lock(uuid,boolean,text) to authenticated;
create function public.set_attendance_period_lock(p_period_id uuid,p_locked boolean,p_note text default null) returns public.attendance_periods
language sql security invoker set search_path = '' as $$
 select * from attendance_internal.set_attendance_period_lock(p_period_id,p_locked,p_note);
$$;
revoke all on function public.set_attendance_period_lock(uuid,boolean,text) from public,anon;
grant execute on function public.set_attendance_period_lock(uuid,boolean,text) to authenticated;

alter function public.export_attendance_period(uuid) set schema attendance_internal;
revoke all on function attendance_internal.export_attendance_period(uuid) from public,anon,authenticated;
grant execute on function attendance_internal.export_attendance_period(uuid) to authenticated;
create function public.export_attendance_period(p_period_id uuid) returns jsonb
language sql security invoker set search_path = '' as $$
 select attendance_internal.export_attendance_period(p_period_id);
$$;
revoke all on function public.export_attendance_period(uuid) from public,anon;
grant execute on function public.export_attendance_period(uuid) to authenticated;

alter function public.set_department_attendance_policy(uuid,uuid) set schema attendance_internal;
revoke all on function attendance_internal.set_department_attendance_policy(uuid,uuid) from public,anon,authenticated;
grant execute on function attendance_internal.set_department_attendance_policy(uuid,uuid) to authenticated;
create function public.set_department_attendance_policy(p_org_unit_id uuid,p_policy_id uuid default null) returns void
language sql security invoker set search_path = '' as $$
 select attendance_internal.set_department_attendance_policy(p_org_unit_id,p_policy_id);
$$;
revoke all on function public.set_department_attendance_policy(uuid,uuid) from public,anon;
grant execute on function public.set_department_attendance_policy(uuid,uuid) to authenticated;

alter function public.create_attendance_policy(uuid,text) set schema attendance_internal;
revoke all on function attendance_internal.create_attendance_policy(uuid,text) from public,anon,authenticated;
grant execute on function attendance_internal.create_attendance_policy(uuid,text) to authenticated;
create function public.create_attendance_policy(p_organization_id uuid,p_name text) returns uuid
language sql security invoker set search_path = '' as $$
 select attendance_internal.create_attendance_policy(p_organization_id,p_name);
$$;
revoke all on function public.create_attendance_policy(uuid,text) from public,anon;
grant execute on function public.create_attendance_policy(uuid,text) to authenticated;

alter function public.update_attendance_period_roster(uuid,uuid,boolean,text) set schema attendance_internal;
revoke all on function attendance_internal.update_attendance_period_roster(uuid,uuid,boolean,text) from public,anon,authenticated;
grant execute on function attendance_internal.update_attendance_period_roster(uuid,uuid,boolean,text) to authenticated;
create function public.update_attendance_period_roster(p_period_id uuid,p_employee_id uuid,p_include boolean,p_reason text) returns void
language sql security invoker set search_path = '' as $$
 select attendance_internal.update_attendance_period_roster(p_period_id,p_employee_id,p_include,p_reason);
$$;
revoke all on function public.update_attendance_period_roster(uuid,uuid,boolean,text) from public,anon;
grant execute on function public.update_attendance_period_roster(uuid,uuid,boolean,text) to authenticated;

alter function public.can_review_attendance_timesheet(uuid) set schema attendance_internal;
revoke all on function attendance_internal.can_review_attendance_timesheet(uuid) from public,anon,authenticated;
grant execute on function attendance_internal.can_review_attendance_timesheet(uuid) to authenticated;
create function public.can_review_attendance_timesheet(p_timesheet_id uuid) returns boolean
language sql security invoker set search_path = '' as $$
 select attendance_internal.can_review_attendance_timesheet(p_timesheet_id);
$$;
revoke all on function public.can_review_attendance_timesheet(uuid) from public,anon;
grant execute on function public.can_review_attendance_timesheet(uuid) to authenticated;
