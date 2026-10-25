-- Leave HR review: schedule-aware days, reservations, independent approvals,
-- cancellation review, private evidence, effective balances and audited setup.
create schema leave_internal;
revoke all on schema leave_internal from public,anon;
grant usage on schema leave_internal to authenticated;
alter table public.leave_types
 add column excluded_weekdays smallint[] not null default '{}' check(excluded_weekdays <@ array[0,1,2,3,4,5,6]::smallint[]),
 add column day_count_basis text not null default 'working_days' check(day_count_basis in ('working_days','calendar_days')),
 add column allow_backdated_requests boolean not null default true,
 add column backdate_limit_days int not null default 30 check(backdate_limit_days between 0 and 365),
 add column minimum_service_days int not null default 0 check(minimum_service_days between 0 and 36500);
alter table public.leave_requests
 add column day_part text not null default 'full' check(day_part in ('full','am','pm')),
 add column policy_snapshot jsonb,
 add column client_request_id uuid,
 add column cancellation_requested_at timestamptz,
 add column cancellation_reason text,
 add column cancellation_decided_at timestamptz,
 add column cancellation_decision_note text;
-- Preserve ambiguity in old half-day requests: treated as AM for new edits,
-- and no additional request may overlap their date until HR resolves it.
-- Existing requests are not rewritten, including records in locked periods.
create unique index leave_request_retry_key on public.leave_requests(employee_id,client_request_id) where client_request_id is not null;
alter table public.leave_request_days add column scheduled_minutes int check(scheduled_minutes>=0);
create table public.leave_attachments (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id),
 employee_id uuid not null references public.employees(id),
 storage_path text not null unique, file_name text not null,
 created_at timestamptz not null default now()
);
alter table public.leave_attachments enable row level security;
revoke all on public.leave_attachments from anon,authenticated;
grant select on public.leave_attachments to authenticated;

create function private.leave_reviewer_ok(p_org uuid,p_employee uuid,p_user uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select p_user is not null and exists(select 1 from public.employees e where e.user_id=p_user and e.organization_id=p_org and e.status='active' and e.id<>p_employee)
 and (private.user_has_permission(p_org,p_user,'leave.manage_policies') or
  ((private.user_has_permission(p_org,p_user,'leave.approve_direct_reports') or private.user_has_permission(p_org,p_user,'leave.approve_unit'))
   and exists(select 1 from public.management_scope m where m.organization_id=p_org and m.actor_user_id=p_user and m.employee_id=p_employee)));
$$;
create function private.can_view_leave(p_org uuid,p_employee uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select (p_employee=private.current_employee_id() or private.leave_reviewer_ok(p_org,p_employee,auth.uid()))
 and private.is_org_member(p_org);
$$;
create policy "scoped leave evidence" on public.leave_attachments for select to authenticated
 using(private.can_view_leave(organization_id,employee_id));
-- Storage paths must match both tenant and employee. Medical documents stay private.
drop policy "read leave-attachments" on storage.objects;
drop policy "upload leave-attachments" on storage.objects;
create policy "read leave-attachments" on storage.objects for select to authenticated using
 (bucket_id='leave-attachments' and exists(select 1 from public.employees e where e.id::text=split_part(name,'/',2)
  and e.organization_id::text=split_part(name,'/',1) and private.can_view_leave(e.organization_id,e.id)));
create policy "upload leave-attachments" on storage.objects for insert to authenticated with check
 (bucket_id='leave-attachments' and exists(select 1 from public.employees e where e.id=private.current_employee_id()
  and e.id::text=split_part(name,'/',2) and e.organization_id::text=split_part(name,'/',1) and e.status in ('active','leave')));
update storage.buckets set public=false,file_size_limit=10485760,allowed_mime_types=array['application/pdf','image/jpeg','image/png'] where id='leave-attachments';

create function private.leave_days(p_employee uuid,p_type uuid,p_from date,p_to date,p_half boolean)
returns table(work_date date,day_fraction numeric,scheduled_minutes int)
language sql stable security definer set search_path='' as $$
 select d::date,case when p_half then 0.5 else 1::numeric end,
 coalesce(greatest(0,extract(epoch from (s.end_at-s.start_at))/60-s.break_minutes)::int,0)
 from public.leave_types t cross join generate_series(p_from,p_to,interval '1 day') d
 left join lateral private.scheduled_shift(p_employee,d::date) s on true
 where t.id=p_type and (t.day_count_basis='calendar_days' or
  (s.start_at is not null and not(extract(dow from d)::smallint=any(t.excluded_weekdays)) and (select h.id from private.holiday_on(p_employee,d::date) h) is null));
$$;
-- A holiday follows the employee's effective primary location on that date.
create or replace function private.holiday_on(p_employee_id uuid,p_date date) returns public.holidays
language sql stable security definer set search_path='' as $$
 select h.* from public.employees e join public.holidays h on h.organization_id=e.organization_id and h.observed_on=p_date
 left join lateral(select a.location_id from public.employee_assignments a where a.employee_id=e.id and a.is_primary
  and a.start_date<=p_date and (a.end_date is null or a.end_date>=p_date) order by a.start_date desc limit 1) a on true
 where e.id=p_employee_id and (h.location_id is null or h.location_id=a.location_id) order by h.location_id nulls last limit 1;
$$;

-- Future credits cannot be spent. Pending requests reserve days rather than
-- deducting them; approved requests are already reflected in the ledger.
create or replace view public.leave_balance_v with(security_invoker=true) as
 select l.organization_id,l.employee_id,l.leave_type_id,t.name as leave_type_name,t.code as leave_type_code,
 coalesce(sum(l.amount) filter(where l.effective_date<=private.org_today(l.organization_id)),0) as balance,
 coalesce((select sum(r.total_days) from public.leave_requests r where r.employee_id=l.employee_id and r.leave_type_id=l.leave_type_id
  and r.status in ('submitted','pending_supervisor','pending_manager')),0) as reserved,
 coalesce(sum(l.amount) filter(where l.effective_date<=private.org_today(l.organization_id)),0)-coalesce((select sum(r.total_days) from public.leave_requests r
  where r.employee_id=l.employee_id and r.leave_type_id=l.leave_type_id and r.status in ('submitted','pending_supervisor','pending_manager')),0) as available_balance
 from public.leave_ledger l join public.leave_types t on t.id=l.leave_type_id
 group by l.organization_id,l.employee_id,l.leave_type_id,t.name,t.code;

create function private.leave_balance(p_employee uuid,p_type uuid,p_exclude uuid default null) returns numeric
language sql stable security definer set search_path='' as $$
 select coalesce((select sum(l.amount) from public.leave_ledger l where l.employee_id=p_employee and l.leave_type_id=p_type and l.effective_date<=private.org_today(l.organization_id)),0)
 - coalesce((select sum(r.total_days) from public.leave_requests r where r.employee_id=p_employee and r.leave_type_id=p_type and r.id is distinct from p_exclude
  and r.status in ('submitted','pending_supervisor','pending_manager')),0);
$$;
create function private.assert_leave_unlocked(p_org uuid,p_from date,p_to date) returns void language plpgsql security definer set search_path='' as $$
begin
 perform private.attendance_period_mutex(p_org);
 if exists(select 1 from public.attendance_periods p where p.organization_id=p_org and p.status='locked' and p.period_start<=p_to and p.period_end>=p_from) then
  raise exception 'An attendance period covering these dates is locked. HR must reopen it before changing leave'; end if;
end; $$;
create function private.leave_route(p_request uuid) returns void language plpgsql security definer set search_path='' as $$
declare r public.leave_requests; a public.employee_assignments; t public.leave_types; u uuid; v_first uuid; v_needs_manager boolean;
begin
 select * into r from public.leave_requests where id=p_request;
 select * into t from public.leave_types where id=r.leave_type_id;
 select * into a from public.employee_assignments where employee_id=r.employee_id and is_primary
  and start_date<=private.org_today(r.organization_id) and (end_date is null or end_date>=private.org_today(r.organization_id)) order by start_date desc limit 1;
 select user_id into u from public.employees where id=a.supervisor_employee_id;
 if not private.leave_reviewer_ok(r.organization_id,r.employee_id,u) then u:=null; end if;
 if u is null then select user_id into u from public.employees where id=a.manager_employee_id;
  if not private.leave_reviewer_ok(r.organization_id,r.employee_id,u) then u:=null; end if;
 end if;
 insert into public.leave_approvals(leave_request_id,sequence,approver_role,approver_user_id) values(r.id,1,case when u is null then 'admin'::public.app_role else 'supervisor'::public.app_role end,u);
 v_first:=u;
 v_needs_manager:=not t.is_paid or (t.requires_manager_approval_over_days is not null and r.total_days>t.requires_manager_approval_over_days);
 if v_needs_manager then
  select user_id into u from public.employees where id=a.manager_employee_id;
  if u is not distinct from v_first or not private.leave_reviewer_ok(r.organization_id,r.employee_id,u) then u:=null; end if;
  insert into public.leave_approvals(leave_request_id,sequence,approver_role,approver_user_id) values(r.id,2,case when u is null then 'admin'::public.app_role else 'manager'::public.app_role end,u);
 end if;
end; $$;

create function leave_internal.preview_leave(p_leave_type_id uuid,p_start_date date,p_end_date date,p_half_day boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e public.employees; t public.leave_types; v_days jsonb; v_total numeric; v_attachment boolean;
begin
 select * into e from public.employees where user_id=auth.uid();
 if auth.uid() is null or e.id is null or e.status not in ('active','leave') or not private.has_permission(e.organization_id,'leave.request_self') then raise exception 'Not authorized to request leave'; end if;
 select * into t from public.leave_types where id=p_leave_type_id and organization_id=e.organization_id and is_active;
 if t.id is null then raise exception 'Leave type is unavailable'; end if;
 if p_start_date is null or p_end_date is null or p_half_day is null or p_end_date<p_start_date or p_end_date-p_start_date>365 then raise exception 'Select a date range of 1–366 days'; end if;
 if p_half_day and (p_start_date<>p_end_date or not t.allow_half_day) then raise exception 'Half-day leave must be allowed and use one date'; end if;
 if e.hire_date is null and t.minimum_service_days>0 then raise exception 'HR must record your hire date before service eligibility can be checked'; end if;
 if e.hire_date is not null and (p_start_date<e.hire_date or p_start_date<e.hire_date+t.minimum_service_days) then raise exception 'The requested start date is before the employment or configured service eligibility date'; end if;
 if e.termination_date is not null and p_end_date>e.termination_date then raise exception 'Leave extends beyond the employment end date'; end if;
 if p_start_date<private.org_today(e.organization_id) and (not t.allow_backdated_requests or p_start_date<private.org_today(e.organization_id)-t.backdate_limit_days) then raise exception 'These dates are outside the backdated-request policy'; end if;
 if p_start_date<private.org_today(e.organization_id)+t.minimum_notice_days and t.minimum_notice_days>0 then raise exception 'This leave type requires at least % calendar days notice',t.minimum_notice_days; end if;
 select jsonb_agg(to_jsonb(d) order by work_date),sum(day_fraction) into v_days,v_total from private.leave_days(e.id,t.id,p_start_date,p_end_date,p_half_day) d;
 if coalesce(v_total,0)=0 then raise exception 'No scheduled working days remain after applicable holidays. Ask HR to check your schedule, or choose a calendar-day leave type'; end if;
 if t.maximum_consecutive_days is not null and v_total>t.maximum_consecutive_days then raise exception 'The request exceeds the configured consecutive-day limit'; end if;
 v_attachment:=t.requires_attachment and (t.attachment_after_days is null or v_total>t.attachment_after_days);
 return jsonb_build_object('days',v_days,'total_days',v_total,'basis',t.day_count_basis,'available',private.leave_balance(e.id,t.id),
  'balance_tracked',t.balance_tracked,'requires_attachment',v_attachment,'requires_approval',t.requires_approval,'paid',t.is_paid);
end; $$;

create function leave_internal.register_leave_attachment(p_storage_path text,p_file_name text) returns uuid
language plpgsql security definer set search_path='' as $$ declare e public.employees; v_id uuid;
begin
 select * into e from public.employees where user_id=auth.uid();
 if e.id is null or not private.has_permission(e.organization_id,'leave.request_self') then raise exception 'Not authorized to upload leave evidence'; end if;
 if split_part(p_storage_path,'/',1)<>e.organization_id::text or split_part(p_storage_path,'/',2)<>e.id::text
  or not exists(select 1 from storage.objects where bucket_id='leave-attachments' and name=p_storage_path)
  or nullif(trim(p_file_name),'') is null or length(p_file_name)>255 then raise exception 'Supporting file was not found in your private leave folder'; end if;
 insert into public.leave_attachments(organization_id,employee_id,storage_path,file_name) values(e.organization_id,e.id,p_storage_path,p_file_name) returning id into v_id;
 return v_id;
end; $$;

create function private.refresh_leave_attendance(p_request uuid) returns void language plpgsql security definer set search_path='' as $$
declare r public.leave_requests; sid uuid;
begin
 select * into r from public.leave_requests where id=p_request;
 for sid in select id from public.attendance_sessions where employee_id=r.employee_id and work_date between r.start_date and r.end_date loop
  perform private.recompute_attendance_session(sid,true);
 end loop;
end; $$;

create function leave_internal.submit_leave_request(p_leave_type_id uuid,p_start_date date,p_end_date date,p_half_day boolean default false,
 p_reason text default null,p_attachment_document_id uuid default null,p_day_part text default 'full',p_client_request_id uuid default null)
returns public.leave_requests language plpgsql security definer set search_path='' as $$
declare e public.employees; t public.leave_types; v jsonb; r public.leave_requests; d record; v_part text;
begin
 select * into e from public.employees where user_id=auth.uid();
 if e.id is null then raise exception 'Employee record unavailable'; end if;
 perform private.assert_leave_unlocked(e.organization_id,p_start_date,p_end_date);
 perform pg_advisory_xact_lock(hashtextextended(e.id::text,7));
 if p_client_request_id is not null then
  select * into r from public.leave_requests where employee_id=e.id and client_request_id=p_client_request_id;
  if r.id is not null then
   if r.leave_type_id<>p_leave_type_id or r.start_date<>p_start_date or r.end_date<>p_end_date or r.half_day<>p_half_day
    or r.reason is distinct from nullif(trim(p_reason),'') or r.attachment_document_id is distinct from p_attachment_document_id
    or r.day_part<>(case when p_half_day then p_day_part else 'full' end) then raise exception 'The retry key was already used for a different request'; end if;
   return r;
  end if;
 end if;
 v:=leave_internal.preview_leave(p_leave_type_id,p_start_date,p_end_date,p_half_day);
 select * into t from public.leave_types where id=p_leave_type_id;
 v_part:=case when p_half_day then p_day_part else 'full' end;
 if v_part is null or v_part not in ('full','am','pm') or (p_half_day and v_part='full') then raise exception 'Choose AM or PM for a half-day request'; end if;
 if length(coalesce(p_reason,''))>2000 or (p_start_date<private.org_today(e.organization_id) and nullif(trim(p_reason),'') is null) then raise exception 'Give a reason for backdated leave (maximum 2000 characters)'; end if;
 if (v->>'requires_attachment')::boolean and p_attachment_document_id is null then raise exception 'A supporting document is required by this leave policy'; end if;
 if p_attachment_document_id is not null and not exists(select 1 from public.leave_attachments x where x.id=p_attachment_document_id and x.employee_id=e.id and x.organization_id=e.organization_id) then raise exception 'The supporting document must belong to you'; end if;
 for d in select * from private.leave_days(e.id,t.id,p_start_date,p_end_date,p_half_day) loop
  if exists(select 1 from public.leave_request_days rd join public.leave_requests q on q.id=rd.leave_request_id
   where q.employee_id=e.id and q.status in ('submitted','pending_supervisor','pending_manager','approved') and rd.work_date=d.work_date
   and (not p_half_day or not q.half_day or q.policy_snapshot is null or q.day_part=v_part)) then raise exception 'Leave already covers all or the same part of %',d.work_date; end if;
 end loop;
 if t.balance_tracked and not t.allow_negative_balance and (v->>'available')::numeric<(v->>'total_days')::numeric then raise exception 'Insufficient available balance after pending reservations'; end if;
 insert into public.leave_requests(organization_id,employee_id,leave_type_id,start_date,end_date,half_day,total_days,reason,attachment_document_id,status,submitted_by,day_part,policy_snapshot,client_request_id)
 values(e.organization_id,e.id,t.id,p_start_date,p_end_date,p_half_day,(v->>'total_days')::numeric,nullif(trim(p_reason),''),p_attachment_document_id,
  case when t.requires_approval then 'pending_supervisor' else 'approved' end,auth.uid(),v_part,to_jsonb(t),p_client_request_id) returning * into r;
 insert into public.leave_request_days(leave_request_id,work_date,day_fraction,scheduled_minutes)
 select r.id,work_date,day_fraction,scheduled_minutes from private.leave_days(e.id,t.id,p_start_date,p_end_date,p_half_day);
 if t.requires_approval then perform private.leave_route(r.id); perform private.notify_pending_leave_approver(r.id);
 elsif t.balance_tracked then
  insert into public.leave_ledger(organization_id,employee_id,leave_type_id,entry_type,amount,related_request_id,created_by,effective_date,idempotency_key)
  values(e.organization_id,e.id,t.id,'request_deduction',-r.total_days,r.id,auth.uid(),private.org_today(e.organization_id),'leave:deduction:'||r.id);
 end if;
 if r.status='approved' then
  perform private.refresh_leave_attendance(r.id);
  perform private.create_notification(r.organization_id,e.user_id,e.id,'leave.approved','Your leave request was automatically approved',null,'/leave/'||r.id);
 end if;
 perform private.log_audit_event(e.organization_id,'LEAVE_REQUESTED','leave_request',r.id,null,to_jsonb(r)-'reason');
 return r;
end; $$;

create function private.can_decide_leave(p_request uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.leave_requests r join lateral(select a.* from public.leave_approvals a where a.leave_request_id=r.id and a.status='pending' order by a.sequence limit 1) a on true
  where r.id=p_request and r.status in ('pending_supervisor','pending_manager') and private.leave_reviewer_ok(r.organization_id,r.employee_id,auth.uid())
   and (a.approver_user_id=auth.uid() or private.has_permission(r.organization_id,'leave.manage_policies'))
   and not exists(select 1 from public.leave_approvals done where done.leave_request_id=r.id and done.status='approved' and done.approver_user_id=auth.uid()));
$$;
create function leave_internal.decide_leave_request(p_leave_request_id uuid,p_approve boolean,p_note text default null)
returns public.leave_requests language plpgsql security definer set search_path='' as $$
declare r public.leave_requests; a public.leave_approvals; v_balance_tracked boolean; v_allow_negative boolean;
begin
 select * into r from public.leave_requests where id=p_leave_request_id;
 if r.id is null or p_approve is null then raise exception 'Leave request unavailable'; end if;
 perform private.assert_leave_unlocked(r.organization_id,r.start_date,r.end_date);
 perform pg_advisory_xact_lock(hashtextextended(r.employee_id::text,7));
 select * into r from public.leave_requests where id=p_leave_request_id for update;
 if auth.uid() is null or not private.can_decide_leave(r.id) then raise exception 'You are not the current independent authorized approver'; end if;
 perform private.assert_step_up(r.organization_id);
 if length(coalesce(p_note,''))>2000 then raise exception 'Decision note must be 2000 characters or fewer'; end if;
 if not p_approve and nullif(trim(p_note),'') is null then raise exception 'Give a reason when rejecting leave'; end if;
 select * into a from public.leave_approvals where leave_request_id=r.id and status='pending' order by sequence limit 1 for update;
 v_balance_tracked:=coalesce((r.policy_snapshot->>'balance_tracked')::boolean,(select balance_tracked from public.leave_types where id=r.leave_type_id));
 v_allow_negative:=coalesce((r.policy_snapshot->>'allow_negative_balance')::boolean,(select allow_negative_balance from public.leave_types where id=r.leave_type_id));
 if p_approve and v_balance_tracked and not v_allow_negative and private.leave_balance(r.employee_id,r.leave_type_id,r.id)<r.total_days then raise exception 'The current balance no longer covers this request and the other pending reservations'; end if;
 -- Resolve calendar changes before approving an old request; do not silently
 -- alter what the employee submitted or charge the wrong dates.
 if p_approve and r.policy_snapshot is not null and exists(
  (select work_date,day_fraction from private.leave_days(r.employee_id,r.leave_type_id,r.start_date,r.end_date,r.half_day) except select work_date,day_fraction from public.leave_request_days where leave_request_id=r.id)
  union all
  (select work_date,day_fraction from public.leave_request_days where leave_request_id=r.id except select work_date,day_fraction from private.leave_days(r.employee_id,r.leave_type_id,r.start_date,r.end_date,r.half_day))) then
  raise exception 'The work calendar changed after submission. Return this request so the employee can submit the revised dates'; end if;
 update public.leave_approvals set status=case when p_approve then 'approved' else 'rejected' end,approver_user_id=auth.uid(),decided_at=now(),note=nullif(trim(p_note),'') where id=a.id;
 if not p_approve then
  update public.leave_approvals set status='skipped' where leave_request_id=r.id and status='pending';
  update public.leave_requests set status='rejected',decided_at=now() where id=r.id returning * into r;
 elsif exists(select 1 from public.leave_approvals where leave_request_id=r.id and status='pending') then
  update public.leave_requests set status='pending_manager' where id=r.id returning * into r;
 else
  update public.leave_requests set status='approved',decided_at=now() where id=r.id returning * into r;
  if v_balance_tracked then
   insert into public.leave_ledger(organization_id,employee_id,leave_type_id,entry_type,amount,related_request_id,created_by,effective_date,idempotency_key)
   values(r.organization_id,r.employee_id,r.leave_type_id,'request_deduction',-r.total_days,r.id,auth.uid(),private.org_today(r.organization_id),'leave:deduction:'||r.id);
  end if;
 end if;
 if r.status='approved' then perform private.refresh_leave_attendance(r.id); end if;
 perform private.log_audit_event(r.organization_id,case when p_approve then 'LEAVE_APPROVAL_RECORDED' else 'LEAVE_REJECTED' end,'leave_request',r.id,null,jsonb_build_object('status',r.status,'approval_id',a.id,'note',p_note));
 return r;
end; $$;

create function leave_internal.request_leave_cancellation(p_leave_request_id uuid,p_reason text default null)
returns public.leave_requests language plpgsql security definer set search_path='' as $$
declare r public.leave_requests;
begin
 select * into r from public.leave_requests where id=p_leave_request_id;
 if auth.uid() is null or r.id is null or r.employee_id<>private.current_employee_id() or not private.has_permission(r.organization_id,'leave.request_self') then raise exception 'Only the employee can withdraw or request cancellation'; end if;
 perform private.assert_leave_unlocked(r.organization_id,r.start_date,r.end_date);
 perform pg_advisory_xact_lock(hashtextextended(r.employee_id::text,7));
 select * into r from public.leave_requests where id=p_leave_request_id for update;
 if r.status in ('submitted','pending_supervisor','pending_manager') then
  update public.leave_approvals set status='skipped' where leave_request_id=r.id and status='pending';
  update public.leave_requests set status='withdrawn',decided_at=now() where id=r.id returning * into r;
 elsif r.status='approved' then
  if nullif(trim(p_reason),'') is null or length(p_reason)>2000 then raise exception 'Explain why approved leave should be cancelled. HR will review it before any balance is returned'; end if;
  if r.cancellation_requested_at is not null and r.cancellation_decided_at is null then raise exception 'Cancellation is already awaiting review'; end if;
  update public.leave_requests set cancellation_requested_at=now(),cancellation_reason=trim(p_reason),cancellation_decided_at=null,cancellation_decision_note=null where id=r.id returning * into r;
 else raise exception 'This request is already closed'; end if;
 perform private.log_audit_event(r.organization_id,case when r.status='withdrawn' then 'LEAVE_WITHDRAWN' else 'LEAVE_CANCELLATION_REQUESTED' end,'leave_request',r.id,null,jsonb_build_object('status',r.status));
 if r.status='withdrawn' then
  perform private.create_notification(r.organization_id,e.user_id,r.employee_id,'leave.withdrawn','A leave request was withdrawn',null,'/leave/'||r.id)
   from public.employees e where e.user_id in(select a.approver_user_id from public.leave_approvals a where a.leave_request_id=r.id)
    and private.leave_reviewer_ok(r.organization_id,r.employee_id,e.user_id);
 end if;
 perform private.notify_pending_leave_approver(r.id);
 return r;
end; $$;
create function leave_internal.decide_leave_cancellation(p_leave_request_id uuid,p_approve boolean,p_note text)
returns public.leave_requests language plpgsql security definer set search_path='' as $$
declare r public.leave_requests; v_refund numeric;
begin
 select * into r from public.leave_requests where id=p_leave_request_id;
 if auth.uid() is null or r.id is null or p_approve is null or not private.leave_reviewer_ok(r.organization_id,r.employee_id,auth.uid())
  or not (private.has_permission(r.organization_id,'leave.manage_policies') or exists(select 1 from public.leave_approvals where leave_request_id=r.id and approver_user_id=auth.uid() and status='approved')) then raise exception 'An independent HR or original authorized approver must decide cancellation'; end if;
 perform private.assert_leave_unlocked(r.organization_id,r.start_date,r.end_date);
 perform private.assert_step_up(r.organization_id);
 perform pg_advisory_xact_lock(hashtextextended(r.employee_id::text,7));
 select * into r from public.leave_requests where id=p_leave_request_id for update;
 if r.status<>'approved' or r.cancellation_requested_at is null or r.cancellation_decided_at is not null then raise exception 'No cancellation is awaiting review'; end if;
 if nullif(trim(p_note),'') is null or length(p_note)>2000 then raise exception 'Record a reason, including confirmation that the leave was not taken if its dates have passed'; end if;
 if p_approve then
  select greatest(0,-coalesce(sum(amount),0)) into v_refund from public.leave_ledger where related_request_id=r.id and entry_type in ('request_deduction','request_reversal');
  if v_refund>0 then
   insert into public.leave_ledger(organization_id,employee_id,leave_type_id,entry_type,amount,related_request_id,created_by,effective_date,note,idempotency_key)
   values(r.organization_id,r.employee_id,r.leave_type_id,'request_reversal',v_refund,r.id,auth.uid(),private.org_today(r.organization_id),p_note,'leave:reversal:'||r.id);
  end if;
 end if;
 update public.leave_requests set status=case when p_approve then 'cancelled' else 'approved' end,cancellation_decided_at=now(),cancellation_decision_note=trim(p_note) where id=r.id returning * into r;
 if p_approve then perform private.refresh_leave_attendance(r.id); end if;
 perform private.log_audit_event(r.organization_id,case when p_approve then 'LEAVE_CANCELLATION_APPROVED' else 'LEAVE_CANCELLATION_DECLINED' end,'leave_request',r.id,null,jsonb_build_object('reason',p_note,'refunded_days',coalesce(v_refund,0)));
 perform private.create_notification(r.organization_id,(select user_id from public.employees where id=r.employee_id),r.employee_id,case when p_approve then 'leave.cancelled' else 'leave.cancellation_declined' end,
  case when p_approve then 'Your leave cancellation was approved' else 'Your leave cancellation was declined' end,null,'/leave/'||r.id);
 return r;
end; $$;

create function leave_internal.reroute_leave_request(p_leave_request_id uuid,p_note text) returns void
language plpgsql security definer set search_path='' as $$ declare r public.leave_requests; a public.leave_approvals; u uuid;
begin
 select * into r from public.leave_requests where id=p_leave_request_id;
 if auth.uid() is null or r.id is null or not private.has_permission(r.organization_id,'leave.manage_policies') or nullif(trim(p_note),'') is null then raise exception 'HR permission and a rerouting reason are required'; end if;
 perform private.assert_leave_unlocked(r.organization_id,r.start_date,r.end_date); perform private.assert_step_up(r.organization_id);
 select * into r from public.leave_requests where id=r.id for update;
 if r.status not in ('pending_supervisor','pending_manager') then raise exception 'Only a pending request can be rerouted'; end if;
 -- Preserve completed decisions; let independent HR take pending steps.
 for a in select * from public.leave_approvals where leave_request_id=r.id and status='pending' loop
  update public.leave_approvals set approver_user_id=null,approver_role='admin' where id=a.id;
 end loop;
 perform private.log_audit_event(r.organization_id,'LEAVE_REROUTED_TO_HR','leave_request',r.id,null,jsonb_build_object('reason',p_note));
 perform private.notify_pending_leave_approver(r.id);
end; $$;

create or replace function private.notify_pending_leave_approver(p_request_id uuid) returns void
language plpgsql security definer set search_path='' as $$ declare r public.leave_requests; u uuid; pending_user uuid;
begin
 select * into r from public.leave_requests where id=p_request_id;
 if r.id is null then return; end if;
 if r.status in ('pending_supervisor','pending_manager') then
  select approver_user_id into pending_user from public.leave_approvals where leave_request_id=r.id and status='pending' order by sequence limit 1;
 elsif r.status='approved' and r.cancellation_requested_at is not null and r.cancellation_decided_at is null then pending_user:=null;
 else return; end if;
 for u in select e.user_id from public.employees e where e.organization_id=r.organization_id and e.user_id is not null
  and private.leave_reviewer_ok(r.organization_id,r.employee_id,e.user_id)
  and (e.user_id=pending_user or private.user_has_permission(r.organization_id,e.user_id,'leave.manage_policies') or
    (r.cancellation_requested_at is not null and exists(select 1 from public.leave_approvals a where a.leave_request_id=r.id and a.approver_user_id=e.user_id and a.status='approved'))) loop
  perform private.create_notification(r.organization_id,u,r.employee_id,
   case when r.cancellation_requested_at is not null and r.cancellation_decided_at is null then 'leave.cancellation_requested' else 'leave.requested' end,
   'A leave request needs your review','Open the request to review the dates and policy.','/leave/'||r.id,jsonb_build_object('leave_request_id',r.id));
 end loop;
end; $$;

-- Replace broad manager reads with current, same-tenant management scope.
drop policy "read team leave requests" on public.leave_requests;
drop policy "read org leave requests" on public.leave_requests;
create policy "reviewer reads leave requests" on public.leave_requests for select to authenticated using(private.can_view_leave(organization_id,employee_id));
drop policy "read team leave ledger" on public.leave_ledger;
drop policy "read org leave ledger" on public.leave_ledger;
create policy "reviewer reads leave ledger" on public.leave_ledger for select to authenticated using(private.can_view_leave(organization_id,employee_id));
drop policy "admins adjust leave ledger" on public.leave_ledger;
revoke insert,update,delete on public.leave_ledger,public.leave_requests,public.leave_approvals,public.leave_request_days from authenticated,anon;
grant select on public.leave_types,public.leave_policies,public.leave_policy_assignments,public.leave_requests,public.leave_approvals,public.leave_request_days,public.leave_ledger,public.leave_balance_v to authenticated;
-- Child policies can safely delegate to the parent: no parent policy references children.
drop policy "read own leave request days" on public.leave_request_days;
drop policy "read team leave request days" on public.leave_request_days;
drop policy "read org leave request days" on public.leave_request_days;
create policy "scoped leave days" on public.leave_request_days for select to authenticated using(exists(select 1 from public.leave_requests r where r.id=leave_request_id));
drop policy "read own leave approvals" on public.leave_approvals;
drop policy "read assigned leave approvals" on public.leave_approvals;
drop policy "read org leave approvals" on public.leave_approvals;
create policy "scoped approval history" on public.leave_approvals for select to authenticated using(exists(select 1 from public.leave_requests r where r.id=leave_request_id));

create function leave_internal.adjust_leave_balance(p_employee_id uuid,p_leave_type_id uuid,p_amount numeric,p_note text,p_effective_date date,p_key uuid)
returns uuid language plpgsql security definer set search_path='' as $$ declare e public.employees; v_id uuid;
begin
 select * into e from public.employees where id=p_employee_id;
 if auth.uid() is null or e.id is null or not private.has_permission(e.organization_id,'leave.manage_policies') then raise exception 'Not authorized to adjust leave balances'; end if;
 perform private.assert_step_up(e.organization_id); perform pg_advisory_xact_lock(hashtextextended(e.id::text,7));
 if not exists(select 1 from public.leave_types where id=p_leave_type_id and organization_id=e.organization_id and balance_tracked)
  or p_amount is null or p_amount=0 or abs(p_amount)>9999 or p_amount*2<>trunc(p_amount*2)
  or nullif(trim(p_note),'') is null or p_key is null or p_effective_date is null then raise exception 'Choose a tracked leave type, a nonzero half-day amount, effective date, unique key and adjustment reason'; end if;
 select id into v_id from public.leave_ledger where organization_id=e.organization_id and idempotency_key='leave:adjust:'||p_key;
 if v_id is not null then
  if not exists(select 1 from public.leave_ledger where id=v_id and employee_id=e.id and leave_type_id=p_leave_type_id and amount=p_amount and effective_date=p_effective_date and note=trim(p_note)) then raise exception 'Retry key already used for another adjustment'; end if;
  return v_id;
 end if;
 insert into public.leave_ledger(organization_id,employee_id,leave_type_id,entry_type,amount,effective_date,note,created_by,idempotency_key)
 values(e.organization_id,e.id,p_leave_type_id,'adjustment',p_amount,p_effective_date,trim(p_note),auth.uid(),'leave:adjust:'||p_key) returning id into v_id;
 perform private.log_audit_event(e.organization_id,'LEAVE_BALANCE_ADJUSTED','leave_ledger',v_id,null,jsonb_build_object('employee_id',e.id,'days',p_amount,'effective_date',p_effective_date,'reason',trim(p_note)));
 return v_id;
end; $$;

create function private.leave_integrity_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare j jsonb:=to_jsonb(new); v_org uuid:=(j->>'organization_id')::uuid; v_employee uuid:=(j->>'employee_id')::uuid; v_type uuid:=(j->>'leave_type_id')::uuid; v_policy uuid:=(j->>'leave_policy_id')::uuid;
begin
 if tg_op='UPDATE' and (to_jsonb(old)->>'organization_id') is distinct from (j->>'organization_id') then raise exception 'Leave records cannot be moved between organizations'; end if;
 if v_employee is not null and not exists(select 1 from public.employees where id=v_employee and organization_id=v_org) then raise exception 'Employee must belong to the same organization'; end if;
 if v_type is not null and not exists(select 1 from public.leave_types where id=v_type and organization_id=v_org) then raise exception 'Leave type must belong to the same organization'; end if;
 if v_policy is not null and not exists(select 1 from public.leave_policies where id=v_policy and organization_id=v_org) then raise exception 'Leave policy must belong to the same organization'; end if;
 if tg_table_name='leave_ledger' and (j->>'related_request_id') is not null and not exists(select 1 from public.leave_requests where id=(j->>'related_request_id')::uuid and organization_id=v_org and employee_id=v_employee and leave_type_id=v_type) then raise exception 'Leave ledger/request mismatch'; end if;
 return new;
end; $$;
do $$ declare t text; begin foreach t in array array['leave_policies','leave_policy_assignments','leave_ledger','leave_requests','leave_attachments'] loop
 execute format('create trigger leave_tenant_integrity before insert or update on public.%I for each row execute function private.leave_integrity_guard()',t); end loop; end $$;

create function private.leave_type_guard() returns trigger language plpgsql security definer set search_path='' as $$ begin
 if tg_op='UPDATE' and new.organization_id<>old.organization_id then raise exception 'Leave types cannot move between organizations'; end if;
 if nullif(trim(new.name),'') is null or length(new.name)>120 or new.code!~'^[A-Z0-9_-]{1,30}$' or new.minimum_notice_days<0
  or new.maximum_consecutive_days<=0 or new.attachment_after_days<0 or new.requires_manager_approval_over_days<0 then raise exception 'Check leave type name, code and nonnegative policy limits'; end if;
 if new.allow_hourly then raise exception 'Hourly leave is not supported. Use full or half days'; end if;
 perform private.assert_step_up(new.organization_id);
 return new;
end; $$;
create trigger leave_type_validation before insert or update on public.leave_types for each row execute function private.leave_type_guard();
create function private.leave_setup_audit() returns trigger language plpgsql security definer set search_path='' as $$ declare j jsonb;
begin
 if tg_op='DELETE' then j:=to_jsonb(old); else j:=to_jsonb(new); end if;
 if not exists(select 1 from public.organizations where id=(j->>'organization_id')::uuid) then return old; end if;
 perform private.log_audit_event((j->>'organization_id')::uuid,'LEAVE_SETUP_'||tg_op,tg_table_name,(j->>'id')::uuid,
  case when tg_op<>'INSERT' then to_jsonb(old) end,case when tg_op<>'DELETE' then to_jsonb(new) end);
 if tg_op='DELETE' then return old; end if; return new;
end; $$;
create trigger leave_type_audit after insert or update or delete on public.leave_types for each row execute function private.leave_setup_audit();
create trigger leave_policy_audit after insert or update or delete on public.leave_policies for each row execute function private.leave_setup_audit();
create trigger leave_assignment_audit after insert or update or delete on public.leave_policy_assignments for each row execute function private.leave_setup_audit();

-- Requests now have a real detail screen and permission-accurate review flags.
create function leave_internal.leave_request_permissions(p_request_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('can_decide',private.can_decide_leave(r.id),'can_cancel_review',
  r.status='approved' and r.cancellation_requested_at is not null and r.cancellation_decided_at is null
   and private.leave_reviewer_ok(r.organization_id,r.employee_id,auth.uid()) and
   (private.has_permission(r.organization_id,'leave.manage_policies') or exists(select 1 from public.leave_approvals a where a.leave_request_id=r.id and a.approver_user_id=auth.uid() and a.status='approved')),
 'can_reroute',private.has_permission(r.organization_id,'leave.manage_policies'))
 from public.leave_requests r where r.id=p_request_id and private.can_view_leave(r.organization_id,r.employee_id);
$$;
-- Keep legacy view columns stable (r.* changed when columns were added).
create or replace view public.leave_pending_v with(security_invoker=true) as
 select r.id,r.organization_id,r.employee_id,r.leave_type_id,r.start_date,r.end_date,r.half_day,r.total_days,r.reason,r.attachment_document_id,
 r.status,r.submitted_by,r.submitted_at,r.decided_at,r.created_at,e.first_name,e.last_name,t.name as leave_type_name
 from public.leave_requests r join public.employees e on e.id=r.employee_id join public.leave_types t on t.id=r.leave_type_id
 where r.status in ('submitted','pending_supervisor','pending_manager') and private.can_decide_leave(r.id);

create function private.leave_minutes(p_scheduled int,p_fraction numeric,p_part text) returns int language sql immutable set search_path='' as $$
 select case when p_fraction=0.5 and p_part='am' then floor(p_scheduled/2.0)::int
  when p_fraction=0.5 and p_part='pm' then ceil(p_scheduled/2.0)::int else round(p_scheduled*p_fraction)::int end;
$$;

create or replace function private.timesheet_snapshot(p_employee uuid, p_from date, p_to date)
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
 select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'date',d.work_date,'fraction',d.day_fraction,'paid',coalesce((r.policy_snapshot->>'is_paid')::boolean,lt.is_paid),
  'minutes',private.leave_minutes(coalesce(d.scheduled_minutes,greatest(0,extract(epoch from (sh.end_at-sh.start_at))/60-sh.break_minutes)::int),d.day_fraction,r.day_part)::int)
  order by d.work_date,d.id),'[]'),
 coalesce(sum(case when coalesce((r.policy_snapshot->>'is_paid')::boolean,lt.is_paid) then private.leave_minutes(coalesce(d.scheduled_minutes,greatest(0,extract(epoch from (sh.end_at-sh.start_at))/60-sh.break_minutes)::int),d.day_fraction,r.day_part) else 0 end),0),
 coalesce(sum(case when not coalesce((r.policy_snapshot->>'is_paid')::boolean,lt.is_paid) then private.leave_minutes(coalesce(d.scheduled_minutes,greatest(0,extract(epoch from (sh.end_at-sh.start_at))/60-sh.break_minutes)::int),d.day_fraction,r.day_part) else 0 end),0)
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
  group by d.work_date,sh.start_at,sh.end_at,sh.break_minutes,d.scheduled_minutes
  having (sh.start_at is null and d.scheduled_minutes is null) or
   sum(private.leave_minutes(coalesce(d.scheduled_minutes,greatest(0,extract(epoch from (sh.end_at-sh.start_at))/60-sh.break_minutes)::int),d.day_fraction,r.day_part))
    + coalesce((select sum(s.worked_minutes) from public.attendance_sessions s where s.employee_id=p_employee and s.work_date=d.work_date),0)
    > coalesce(d.scheduled_minutes,greatest(0,extract(epoch from (sh.end_at-sh.start_at))/60-sh.break_minutes))
 ) conflicts);
 return jsonb_build_object('sessions',v_sessions,'leave',v_leave,'regular_minutes',v_regular,'overtime_minutes',v_ot,
  'paid_leave_minutes',v_paid,'unpaid_leave_minutes',v_unpaid,'deducted_minutes',v_deduct,'makeup_minutes',v_makeup,'issues',v_issues);
end; $$;


create or replace function private.approved_leave_on(p_employee_id uuid,p_date date) returns text
language sql stable security definer set search_path='' as $$
 select string_agg(distinct t.name,', ') from public.leave_requests r join public.leave_types t on t.id=r.leave_type_id
 where r.employee_id=p_employee_id and r.status='approved' and
 ((exists(select 1 from public.leave_request_days d where d.leave_request_id=r.id and d.work_date=p_date)
   and (select coalesce(sum(d.day_fraction),0) from public.leave_request_days d join public.leave_requests x on x.id=d.leave_request_id
     where x.employee_id=p_employee_id and x.status='approved' and d.work_date=p_date)>=1)
  or (r.policy_snapshot is null and not r.half_day and p_date between r.start_date and r.end_date
   and not exists(select 1 from public.leave_request_days d where d.leave_request_id=r.id)));
$$;
create function private.leave_adjusted_shift(p_employee uuid,p_date date)
returns table(assignment_id uuid,schedule_id uuid,start_at timestamptz,end_at timestamptz,break_minutes integer)
language sql stable security definer set search_path='' as $$
 select s.assignment_id,s.schedule_id,
 case when h.part='am' then s.start_at+make_interval(mins => floor(greatest(0,extract(epoch from (s.end_at-s.start_at))/60-s.break_minutes)/2.0)::int + ceil(s.break_minutes/2.0)::int) else s.start_at end,
 case when h.part='pm' then s.start_at+make_interval(mins => floor(greatest(0,extract(epoch from (s.end_at-s.start_at))/60-s.break_minutes)/2.0)::int + ceil(s.break_minutes/2.0)::int) else s.end_at end,
 case when h.part='am' then floor(s.break_minutes/2.0)::int when h.part='pm' then ceil(s.break_minutes/2.0)::int else s.break_minutes end
 from private.scheduled_shift(p_employee,p_date) s
 left join lateral(select r.day_part as part from public.leave_requests r join public.leave_request_days d on d.leave_request_id=r.id and d.work_date=p_date
  where r.employee_id=p_employee and r.status='approved' and r.half_day and r.policy_snapshot is not null
   and private.approved_leave_on(p_employee,p_date) is null order by r.submitted_at limit 1) h on true;
$$;
create or replace function private.resolve_work_shift(p_employee_id uuid,p_organization_id uuid,p_at timestamptz)
returns table(work_date date,assignment_id uuid,schedule_id uuid,start_at timestamptz,end_at timestamptz,break_minutes integer)
language plpgsql stable security definer set search_path='' as $$
declare v_local date:=private.org_local_date(p_organization_id,p_at); v_prev record;
begin
 select * into v_prev from private.leave_adjusted_shift(p_employee_id,v_local-1) s where private.org_local_date(p_organization_id,s.end_at)>v_local-1 and p_at<=s.end_at+interval '2 hours';
 if found then return query select v_local-1,v_prev.assignment_id,v_prev.schedule_id,v_prev.start_at,v_prev.end_at,v_prev.break_minutes; return; end if;
 return query select v_local,s.assignment_id,s.schedule_id,s.start_at,s.end_at,s.break_minutes from (select 1) one left join private.leave_adjusted_shift(p_employee_id,v_local) s on true;
end; $$;
-- Approved half-days reduce expected hours in the employee's period totals.
-- Full-day leave is still handled by approved_leave_on() in existing read models.

create function leave_internal.get_leave_request(p_request_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$ declare r public.leave_requests;
begin
 select * into r from public.leave_requests where id=p_request_id;
 if r.id is null or auth.uid() is null or not private.can_view_leave(r.organization_id,r.employee_id) then raise exception 'Leave request not available in your authorized scope'; end if;
 return jsonb_build_object('request',to_jsonb(r),'employee_name',private.employee_display_name(r.employee_id),
  'leave_type',(select jsonb_build_object('name',name,'is_paid',is_paid,'day_count_basis',day_count_basis) from public.leave_types where id=r.leave_type_id),
  'days',(select coalesce(jsonb_agg(to_jsonb(d) order by work_date),'[]') from public.leave_request_days d where d.leave_request_id=r.id),
  'approvals',(select coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('approver_name',coalesce((select private.employee_display_name(e.id) from public.employees e where e.user_id=a.approver_user_id),'Independent HR reviewer')) order by sequence),'[]') from public.leave_approvals a where leave_request_id=r.id),
  'attachment',(select jsonb_build_object('path',storage_path,'name',file_name) from public.leave_attachments where id=r.attachment_document_id and employee_id=r.employee_id),
  'permissions',leave_internal.leave_request_permissions(r.id),
  'ledger',(select coalesce(jsonb_agg(jsonb_build_object('entry_type',entry_type,'amount',amount,'effective_date',effective_date) order by created_at),'[]') from public.leave_ledger where related_request_id=r.id));
end; $$;

create function leave_internal.list_leave_requests(p_organization_id uuid,p_from date,p_to date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.is_org_member(p_organization_id) or p_from is null or p_to is null or p_to<p_from or p_to-p_from>730 then raise exception 'Choose an authorized leave range of at most two years'; end if;
 return (select coalesce(jsonb_agg((to_jsonb(r)-'reason'-'cancellation_reason'-'policy_snapshot'-'attachment_document_id')||jsonb_build_object('employee_name',private.employee_display_name(r.employee_id),
  'leave_type_name',t.name,'can_decide',private.can_decide_leave(r.id),'can_cancel_review',(leave_internal.leave_request_permissions(r.id)->>'can_cancel_review')::boolean,'paid',coalesce((r.policy_snapshot->>'is_paid')::boolean,t.is_paid)) order by r.submitted_at desc),'[]')
  from public.leave_requests r join public.leave_types t on t.id=r.leave_type_id where r.organization_id=p_organization_id and r.start_date<=p_to and r.end_date>=p_from
   and private.can_view_leave(r.organization_id,r.employee_id));
end; $$;

-- Legacy entry points keep their signatures, and all public functions are
-- invokers delegating to an unexposed, permission-checked implementation.
create or replace function public.submit_leave(p_leave_type_id uuid,p_start_date date,p_end_date date,p_half_day boolean default false,p_reason text default null,p_attachment_document_id uuid default null)
returns public.leave_requests language sql security invoker set search_path='' as $$
 select * from leave_internal.submit_leave_request(p_leave_type_id,p_start_date,p_end_date,p_half_day,p_reason,p_attachment_document_id,case when p_half_day then 'am' else 'full' end,null);
$$;
create or replace function public.decide_leave_request(p_leave_request_id uuid,p_approve boolean,p_note text default null)
returns public.leave_requests language sql security invoker set search_path='' as $$ select * from leave_internal.decide_leave_request(p_leave_request_id,p_approve,p_note); $$;
create or replace function public.cancel_leave_request(p_leave_request_id uuid) returns public.leave_requests language sql security invoker set search_path='' as $$
 select * from leave_internal.request_leave_cancellation(p_leave_request_id,'Employee requested cancellation'); $$;

create function public.preview_leave(p_leave_type_id uuid,p_start_date date,p_end_date date,p_half_day boolean default false) returns jsonb language sql security invoker set search_path='' as $$ select leave_internal.preview_leave(p_leave_type_id,p_start_date,p_end_date,p_half_day); $$;
revoke all on function public.preview_leave(uuid,date,date,boolean) from public,anon;
grant execute on function public.preview_leave(uuid,date,date,boolean) to authenticated;

create function public.submit_leave_request(p_leave_type_id uuid,p_start_date date,p_end_date date,p_half_day boolean default false,p_reason text default null,p_attachment_document_id uuid default null,p_day_part text default 'full',p_client_request_id uuid default null) returns public.leave_requests language sql security invoker set search_path='' as $$ select * from leave_internal.submit_leave_request(p_leave_type_id,p_start_date,p_end_date,p_half_day,p_reason,p_attachment_document_id,p_day_part,p_client_request_id); $$;
revoke all on function public.submit_leave_request(uuid,date,date,boolean,text,uuid,text,uuid) from public,anon;
grant execute on function public.submit_leave_request(uuid,date,date,boolean,text,uuid,text,uuid) to authenticated;

create function public.register_leave_attachment(p_storage_path text,p_file_name text) returns uuid language sql security invoker set search_path='' as $$ select leave_internal.register_leave_attachment(p_storage_path,p_file_name); $$;
revoke all on function public.register_leave_attachment(text,text) from public,anon;
grant execute on function public.register_leave_attachment(text,text) to authenticated;

create function public.request_leave_cancellation(p_leave_request_id uuid,p_reason text default null) returns public.leave_requests language sql security invoker set search_path='' as $$ select * from leave_internal.request_leave_cancellation(p_leave_request_id,p_reason); $$;
revoke all on function public.request_leave_cancellation(uuid,text) from public,anon;
grant execute on function public.request_leave_cancellation(uuid,text) to authenticated;

create function public.decide_leave_cancellation(p_leave_request_id uuid,p_approve boolean,p_note text) returns public.leave_requests language sql security invoker set search_path='' as $$ select * from leave_internal.decide_leave_cancellation(p_leave_request_id,p_approve,p_note); $$;
revoke all on function public.decide_leave_cancellation(uuid,boolean,text) from public,anon;
grant execute on function public.decide_leave_cancellation(uuid,boolean,text) to authenticated;

create function public.reroute_leave_request(p_leave_request_id uuid,p_note text) returns void language sql security invoker set search_path='' as $$ select leave_internal.reroute_leave_request(p_leave_request_id,p_note); $$;
revoke all on function public.reroute_leave_request(uuid,text) from public,anon;
grant execute on function public.reroute_leave_request(uuid,text) to authenticated;

create function public.adjust_leave_balance(p_employee_id uuid,p_leave_type_id uuid,p_amount numeric,p_note text,p_effective_date date,p_key uuid) returns uuid language sql security invoker set search_path='' as $$ select leave_internal.adjust_leave_balance(p_employee_id,p_leave_type_id,p_amount,p_note,p_effective_date,p_key); $$;
revoke all on function public.adjust_leave_balance(uuid,uuid,numeric,text,date,uuid) from public,anon;
grant execute on function public.adjust_leave_balance(uuid,uuid,numeric,text,date,uuid) to authenticated;

create function public.leave_request_permissions(p_request_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select leave_internal.leave_request_permissions(p_request_id); $$;
revoke all on function public.leave_request_permissions(uuid) from public,anon;
grant execute on function public.leave_request_permissions(uuid) to authenticated;

create function public.get_leave_request(p_request_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select leave_internal.get_leave_request(p_request_id); $$;
revoke all on function public.get_leave_request(uuid) from public,anon;
grant execute on function public.get_leave_request(uuid) to authenticated;

create function public.list_leave_requests(p_organization_id uuid,p_from date,p_to date) returns jsonb language sql security invoker set search_path='' as $$ select leave_internal.list_leave_requests(p_organization_id,p_from,p_to); $$;
revoke all on function public.list_leave_requests(uuid,date,date) from public,anon;
grant execute on function public.list_leave_requests(uuid,date,date) to authenticated;

revoke all on all functions in schema leave_internal from public,anon,authenticated;
grant execute on all functions in schema leave_internal to authenticated;
revoke all on function public.submit_leave(uuid,date,date,boolean,text,uuid),public.decide_leave_request(uuid,boolean,text),public.cancel_leave_request(uuid) from public,anon;
grant execute on function public.submit_leave(uuid,date,date,boolean,text,uuid),public.decide_leave_request(uuid,boolean,text),public.cancel_leave_request(uuid) to authenticated;

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

  select * into v_shift from private.leave_adjusted_shift(v_employee.id, v_today);
  v_open := private.my_open_session();
  v_on_break := v_open.id is not null and exists (select 1 from public.attendance_breaks b where b.session_id = v_open.id and b.ended_at is null);

  for d in select generate_series(v_week_start::timestamp, (v_week_start + 6)::timestamp, interval '1 day')::date loop
    select * into v_s from private.leave_adjusted_shift(v_employee.id, d);
    if v_s.start_at is not null then
      v_scheduled_week := v_scheduled_week + floor(extract(epoch from (v_s.end_at - v_s.start_at)) / 60)::int - coalesce(v_s.break_minutes, 0);
    end if;
  end loop;

  for d in select generate_series((v_today + 1)::timestamp, (v_today + 14)::timestamp, interval '1 day')::date loop
    select * into v_s from private.leave_adjusted_shift(v_employee.id, d);
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
  left join lateral (select * from private.leave_adjusted_shift(e.id, v_date)) sh on true
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

-- Updated attendance reads also use invoker API wrappers.
alter function public.get_my_attendance_overview() set schema leave_internal;
revoke all on function leave_internal.get_my_attendance_overview() from public,anon;
grant execute on function leave_internal.get_my_attendance_overview() to authenticated;
create function public.get_my_attendance_overview() returns jsonb language sql security invoker set search_path='' as $$ select leave_internal.get_my_attendance_overview(); $$;
revoke all on function public.get_my_attendance_overview() from public,anon;
grant execute on function public.get_my_attendance_overview() to authenticated;

alter function public.list_attendance_day(uuid,date) set schema leave_internal;
revoke all on function leave_internal.list_attendance_day(uuid,date) from public,anon;
grant execute on function leave_internal.list_attendance_day(uuid,date) to authenticated;
create function public.list_attendance_day(p_organization_id uuid, p_date date default null)
returns table (
  employee_id uuid, employee_name text, employee_number text, department text,
  scheduled_start_at timestamptz, scheduled_end_at timestamptz,
  session_id uuid, clock_in_at timestamptz, clock_out_at timestamptz,
  worked_minutes integer, late_minutes integer, overtime_minutes integer, overtime_status text,
  day_status text, detail text, needs_review boolean,
  current_break_type text, current_break_started_at timestamptz, current_break_allowed_minutes integer, current_break_grace_minutes integer,
  pending_break_overruns integer
)
language sql security invoker set search_path='' as $$ select * from leave_internal.list_attendance_day(p_organization_id,p_date); $$;
revoke all on function public.list_attendance_day(uuid,date) from public,anon;
grant execute on function public.list_attendance_day(uuid,date) to authenticated;
