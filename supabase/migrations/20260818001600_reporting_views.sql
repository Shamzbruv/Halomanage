-- Halomanage — reporting views
-- Ref: PRODUCT_BLUEPRINT.md "Reports worth including"; ARCHITECTURE.md
-- "Reporting" + "Use normal PostgreSQL views for many dashboards".
--
-- Every view is `security_invoker = true`. A bare view owned by a
-- privileged migration role otherwise runs with the *owner's* privileges
-- and can silently bypass the RLS that protects the underlying tables —
-- security_invoker makes each view re-apply the caller's own RLS, so a
-- Supervisor querying employee_headcount_v only ever sees counts over rows
-- their own policies already allow them to see. That's what makes these
-- views safe to expose broadly instead of needing a bespoke permission
-- check per report.

create view public.employee_headcount_v
  with (security_invoker = true)
as
select
  organization_id,
  status,
  count(*) as employee_count
from public.employees
group by organization_id, status;

create view public.attendance_today_v
  with (security_invoker = true)
as
select
  s.organization_id,
  s.employee_id,
  e.first_name,
  e.last_name,
  s.clock_in_at,
  s.scheduled_start_at,
  (s.clock_in_at is not null and s.scheduled_start_at is not null and s.clock_in_at > s.scheduled_start_at) as is_late,
  s.status
from public.attendance_sessions s
join public.employees e on e.id = s.employee_id
where s.work_date = current_date and s.clock_out_at is null;

create view public.attendance_summary_30d_v
  with (security_invoker = true)
as
select
  s.organization_id,
  s.employee_id,
  count(*) as sessions,
  sum(extract(epoch from (coalesce(s.clock_out_at, now()) - s.clock_in_at)) / 3600.0) as hours_worked,
  count(*) filter (
    where s.scheduled_start_at is not null and s.clock_in_at > s.scheduled_start_at
  ) as late_count,
  count(*) filter (where s.clock_out_at is null and s.work_date < current_date) as missing_clock_out_count
from public.attendance_sessions s
where s.work_date >= (current_date - interval '30 days')
group by s.organization_id, s.employee_id;

create view public.leave_pending_v
  with (security_invoker = true)
as
select r.*, e.first_name, e.last_name, t.name as leave_type_name
from public.leave_requests r
join public.employees e on e.id = r.employee_id
join public.leave_types t on t.id = r.leave_type_id
where r.status in ('submitted', 'pending_supervisor', 'pending_manager');

create view public.onboarding_progress_v
  with (security_invoker = true)
as
select
  r.id as run_id,
  r.organization_id,
  r.employee_id,
  r.status,
  count(t.id) as total_tasks,
  count(t.id) filter (where t.status = 'completed') as completed_tasks,
  count(t.id) filter (where t.status != 'completed' and t.due_date < current_date) as overdue_tasks,
  round(
    (count(t.id) filter (where t.status = 'completed'))::numeric
    / nullif(count(t.id), 0) * 100, 1
  ) as percent_complete
from public.onboarding_runs r
left join public.onboarding_tasks t on t.run_id = r.id
group by r.id, r.organization_id, r.employee_id, r.status;

create view public.appraisal_cycle_progress_v
  with (security_invoker = true)
as
select
  c.id as cycle_id,
  c.organization_id,
  c.name,
  count(i.id) as total_instances,
  count(i.id) filter (where i.status = 'complete') as completed_instances,
  count(i.id) filter (where i.status not in ('complete', 'cancelled')) as in_progress_instances
from public.appraisal_cycles c
left join public.appraisal_instances i on i.cycle_id = c.id
group by c.id, c.organization_id, c.name;

-- Union of everything with an expiry date so one dashboard tile can drive
-- "expiring in the next 60 days" across documents, certifications and
-- required training (PRODUCT_BLUEPRINT.md: "Food Handler Certificate
-- expires in 30 days → employee + supervisor + HR notified").
create view public.expiring_items_v
  with (security_invoker = true)
as
select organization_id, employee_id, 'document' as item_type, id as item_id, title as item_name, expires_on
from public.documents
where expires_on is not null and employee_id is not null
union all
select organization_id, employee_id, 'certification' as item_type, id as item_id, name as item_name, expires_on
from public.certifications
where expires_on is not null
union all
select organization_id, employee_id, 'training' as item_type, id as item_id,
  (select name from public.training_courses c where c.id = employee_training.course_id) as item_name, expires_on
from public.employee_training
where expires_on is not null;

create view public.payroll_import_status_v
  with (security_invoker = true)
as
select
  id, organization_id, batch_type, pay_period_start, pay_period_end, pay_date, status,
  total_rows, matched_rows, unmatched_rows, error_rows, total_net_amount, currency,
  uploaded_by, uploaded_at, approved_by, approved_at
from public.payroll_import_batches;
