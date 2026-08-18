-- Halomanage — configurable leave types, requests, approvals and ledger
-- Ref: PRODUCT_BLUEPRINT.md "Leave and 'all sorts of days'"; ARCHITECTURE.md
-- "Leave and 'all types of days'".
--
-- One employer-configurable leave_types table, never bespoke code per leave
-- type. Balances are a ledger of signed entries, never a single mutable
-- integer, so "why is my balance 12.5?" always has an answer.
--
-- Approval routing here is a concrete two-step (Supervisor, then Manager for
-- long/unpaid requests) implementation — a real, working instance of the
-- "reusable approval engine" the blueprint calls for. Generalizing this into
-- a fully configurable cross-module routing-rules table (onboarding,
-- appraisals, attendance corrections, HR requests all sharing it) is the
-- next architectural investment; see docs/ROADMAP.md.

create table public.leave_types (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  code text not null,
  color text,
  is_paid boolean not null default true,
  requires_approval boolean not null default true,
  requires_manager_approval_over_days numeric(4,1),
  requires_attachment boolean not null default false,
  attachment_after_days numeric(4,1),
  balance_tracked boolean not null default true,
  allow_half_day boolean not null default true,
  allow_hourly boolean not null default false,
  allow_negative_balance boolean not null default false,
  minimum_notice_days integer not null default 0,
  maximum_consecutive_days integer,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, code)
);
alter table public.leave_types enable row level security;
create index leave_types_org_idx on public.leave_types(organization_id);

create table public.leave_policies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  leave_type_id uuid not null references public.leave_types(id) on delete cascade,
  name text not null,
  accrual_method text not null default 'annual_grant'
    check (accrual_method in ('none', 'annual_grant', 'monthly', 'per_pay_period')),
  accrual_amount numeric(6,2) not null default 0,
  carryover_max numeric(6,2) not null default 0,
  carryover_expires_after_months integer,
  eligibility jsonb not null default '{}'::jsonb,
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.leave_policies enable row level security;
create index leave_policies_org_idx on public.leave_policies(organization_id);
create index leave_policies_type_idx on public.leave_policies(leave_type_id);

create table public.leave_policy_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  leave_policy_id uuid not null references public.leave_policies(id) on delete cascade,
  start_date date not null default current_date,
  end_date date,
  created_at timestamptz not null default now(),
  check (end_date is null or end_date >= start_date)
);
alter table public.leave_policy_assignments enable row level security;
create index leave_policy_assignments_employee_idx on public.leave_policy_assignments(employee_id);

create table public.leave_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  leave_type_id uuid not null references public.leave_types(id) on delete restrict,
  start_date date not null,
  end_date date not null,
  half_day boolean not null default false,
  total_days numeric(5,2) not null,
  reason text,
  attachment_document_id uuid,
  status text not null default 'submitted' check (status in (
    'submitted', 'pending_supervisor', 'pending_manager', 'approved',
    'rejected', 'cancelled', 'withdrawn'
  )),
  submitted_by uuid not null references auth.users(id),
  submitted_at timestamptz not null default now(),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  check (end_date >= start_date)
);
alter table public.leave_requests enable row level security;
create index leave_requests_employee_idx on public.leave_requests(employee_id, start_date desc);
create index leave_requests_org_status_idx on public.leave_requests(organization_id, status);

create table public.leave_request_days (
  id uuid primary key default gen_random_uuid(),
  leave_request_id uuid not null references public.leave_requests(id) on delete cascade,
  work_date date not null,
  day_fraction numeric(3,2) not null default 1.0 check (day_fraction in (0.5, 1.0)),
  unique (leave_request_id, work_date)
);
alter table public.leave_request_days enable row level security;
create index leave_request_days_request_idx on public.leave_request_days(leave_request_id);

create table public.leave_approvals (
  id uuid primary key default gen_random_uuid(),
  leave_request_id uuid not null references public.leave_requests(id) on delete cascade,
  sequence smallint not null,
  approver_role public.app_role not null,
  approver_user_id uuid references auth.users(id),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'skipped')),
  decided_at timestamptz,
  note text,
  unique (leave_request_id, sequence)
);
alter table public.leave_approvals enable row level security;
create index leave_approvals_request_idx on public.leave_approvals(leave_request_id);

create table public.leave_ledger (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  leave_type_id uuid not null references public.leave_types(id) on delete restrict,
  entry_type text not null check (entry_type in (
    'grant', 'accrual', 'adjustment', 'carryover', 'request_deduction', 'request_reversal', 'expiry'
  )),
  amount numeric(6,2) not null,
  related_request_id uuid references public.leave_requests(id) on delete set null,
  effective_date date not null default current_date,
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
alter table public.leave_ledger enable row level security;
create index leave_ledger_employee_type_idx on public.leave_ledger(employee_id, leave_type_id);
create index leave_ledger_org_idx on public.leave_ledger(organization_id);

comment on table public.leave_ledger is
  'Append-only balance ledger — never mutate a stored balance in place. leave_balance_v sums this per employee/leave_type.';

-- Deliberately denormalized with the leave type's name/code already joined
-- in, rather than leaving the frontend to ask PostgREST to embed
-- leave_types(...) through this view — PostgREST's automatic relationship
-- embedding is driven by real foreign-key constraints, and a GROUP BY view
-- like this one doesn't carry one, so that embedding syntax would silently
-- fail to resolve. Every reporting view in 20260818001600_reporting_views.sql
-- follows this same "join what the UI needs directly into the view" rule.
create view public.leave_balance_v
  with (security_invoker = true)
as
select
  l.organization_id,
  l.employee_id,
  l.leave_type_id,
  t.name as leave_type_name,
  t.code as leave_type_code,
  sum(l.amount) as balance
from public.leave_ledger l
join public.leave_types t on t.id = l.leave_type_id
group by l.organization_id, l.employee_id, l.leave_type_id, t.name, t.code;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function private.count_business_days(p_org_id uuid, p_start date, p_end date)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::numeric
  from generate_series(p_start, p_end, interval '1 day') as d(day)
  where extract(isodow from d.day) < 6 -- Mon..Fri
    and not exists (
      select 1 from public.holidays h
      where h.organization_id = p_org_id and h.observed_on = d.day::date
    );
$$;

-- ---------------------------------------------------------------------------
-- RPCs (SECURITY DEFINER — see attendance migration for the rationale;
-- leave_requests/leave_request_days/leave_approvals/leave_ledger grant no
-- direct client write access, only these functions do).
-- ---------------------------------------------------------------------------

create or replace function public.submit_leave(
  p_leave_type_id uuid,
  p_start_date date,
  p_end_date date,
  p_half_day boolean default false,
  p_reason text default null,
  p_attachment_document_id uuid default null
)
returns public.leave_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  v_leave_type public.leave_types;
  v_total_days numeric;
  v_current_balance numeric;
  v_request public.leave_requests;
  v_needs_manager boolean;
  v_first_status text;
  v_supervisor_id uuid;
  v_manager_id uuid;
  d date;
begin
  select * into v_employee from public.employees e where e.user_id = (select auth.uid());
  if v_employee.id is null then
    raise exception 'No employee record for the current user';
  end if;

  select * into v_leave_type from public.leave_types t
  where t.id = p_leave_type_id and t.organization_id = v_employee.organization_id and t.is_active;
  if v_leave_type.id is null then
    raise exception 'Leave type not found for this organization';
  end if;

  if p_end_date < p_start_date then
    raise exception 'end_date cannot be before start_date';
  end if;

  if p_half_day and p_start_date != p_end_date then
    raise exception 'Half-day requests must be a single date';
  end if;

  if not v_leave_type.allow_half_day and p_half_day then
    raise exception '% does not permit half-day requests', v_leave_type.name;
  end if;

  if v_leave_type.minimum_notice_days > 0
     and p_start_date < (current_date + v_leave_type.minimum_notice_days)
  then
    raise exception '% requires at least % days notice', v_leave_type.name, v_leave_type.minimum_notice_days;
  end if;

  v_total_days := private.count_business_days(v_employee.organization_id, p_start_date, p_end_date);
  if p_half_day then
    v_total_days := 0.5;
  end if;

  if v_total_days <= 0 then
    raise exception 'Selected range contains no working days';
  end if;

  if v_leave_type.maximum_consecutive_days is not null
     and v_total_days > v_leave_type.maximum_consecutive_days
  then
    raise exception '% cannot exceed % consecutive days', v_leave_type.name, v_leave_type.maximum_consecutive_days;
  end if;

  if v_leave_type.requires_attachment
     and v_leave_type.attachment_after_days is not null
     and v_total_days > v_leave_type.attachment_after_days
     and p_attachment_document_id is null
  then
    raise exception '% over % days requires a supporting document', v_leave_type.name, v_leave_type.attachment_after_days;
  end if;

  if v_leave_type.balance_tracked and not v_leave_type.allow_negative_balance then
    select coalesce(sum(amount), 0) into v_current_balance
    from public.leave_ledger where employee_id = v_employee.id and leave_type_id = p_leave_type_id;

    if v_current_balance - v_total_days < 0 then
      raise exception 'Insufficient % balance: % available, % requested', v_leave_type.name, v_current_balance, v_total_days;
    end if;
  end if;

  select supervisor_employee_id, manager_employee_id into v_supervisor_id, v_manager_id
  from public.employee_assignments where employee_id = v_employee.id and end_date is null;

  v_needs_manager := (not v_leave_type.is_paid)
    or (v_leave_type.requires_manager_approval_over_days is not null
        and v_total_days > v_leave_type.requires_manager_approval_over_days);

  v_first_status := case when v_leave_type.requires_approval then 'pending_supervisor' else 'approved' end;

  insert into public.leave_requests (
    organization_id, employee_id, leave_type_id, start_date, end_date, half_day,
    total_days, reason, attachment_document_id, status, submitted_by
  )
  values (
    v_employee.organization_id, v_employee.id, p_leave_type_id, p_start_date, p_end_date, p_half_day,
    v_total_days, p_reason, p_attachment_document_id, v_first_status, auth.uid()
  )
  returning * into v_request;

  d := p_start_date;
  while d <= p_end_date loop
    if extract(isodow from d) < 6
       and not exists (select 1 from public.holidays h where h.organization_id = v_employee.organization_id and h.observed_on = d)
    then
      insert into public.leave_request_days (leave_request_id, work_date, day_fraction)
      values (v_request.id, d, case when p_half_day then 0.5 else 1.0 end);
    end if;
    d := d + 1;
  end loop;

  if v_leave_type.requires_approval then
    if v_supervisor_id is not null then
      insert into public.leave_approvals (leave_request_id, sequence, approver_role, approver_user_id)
      values (v_request.id, 1, 'supervisor', (select user_id from public.employees where id = v_supervisor_id));
    end if;
    if v_needs_manager and v_manager_id is not null then
      insert into public.leave_approvals (leave_request_id, sequence, approver_role, approver_user_id)
      values (v_request.id, 2, 'manager', (select user_id from public.employees where id = v_manager_id));
    end if;
    if v_supervisor_id is null and (not v_needs_manager or v_manager_id is null) then
      -- No one to route to (e.g. top of the org) — auto-approve rather than
      -- create a request nobody can ever action.
      update public.leave_requests set status = 'approved', decided_at = now() where id = v_request.id
      returning * into v_request;
    end if;
  end if;

  if v_request.status = 'approved' then
    insert into public.leave_ledger (
      organization_id, employee_id, leave_type_id, entry_type, amount, related_request_id, note, created_by
    )
    values (
      v_employee.organization_id, v_employee.id, p_leave_type_id, 'request_deduction', -v_total_days,
      v_request.id, 'Auto-approved on submission', auth.uid()
    );
  end if;

  -- Notify the first pending approver now that the approval chain rows
  -- actually exist (see the note on private.notify_leave_decided() in
  -- 20260818001300_notifications.sql for why this isn't a trigger).
  -- private.notify_pending_leave_approver() is defined later in migration
  -- order (notifications.sql) — safe as a forward reference: plpgsql
  -- function bodies are resolved by name at call time, not at CREATE
  -- FUNCTION time, and every migration will have run before this function
  -- is ever invoked.
  perform private.notify_pending_leave_approver(v_request.id);

  perform private.log_audit_event(
    v_employee.organization_id, 'LEAVE_REQUESTED', 'leave_request', v_request.id, null, to_jsonb(v_request)
  );

  return v_request;
end;
$$;

create or replace function public.decide_leave_request(
  p_leave_request_id uuid,
  p_approve boolean,
  p_note text default null
)
returns public.leave_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.leave_requests;
  v_approval public.leave_approvals;
  v_next public.leave_approvals;
begin
  select * into v_request from public.leave_requests where id = p_leave_request_id for update;
  if v_request.id is null then
    raise exception 'Leave request not found';
  end if;
  if v_request.status not in ('pending_supervisor', 'pending_manager') then
    raise exception 'Leave request is not awaiting a decision';
  end if;

  select * into v_approval from public.leave_approvals
  where leave_request_id = p_leave_request_id and status = 'pending'
  order by sequence asc limit 1;

  if v_approval.id is null then
    raise exception 'No pending approval step found';
  end if;

  if v_approval.approver_user_id != (select auth.uid())
     and not private.has_permission(v_request.organization_id, 'leave.approve_unit')
  then
    raise exception 'Not authorized to decide this leave request';
  end if;

  update public.leave_approvals
  set status = case when p_approve then 'approved' else 'rejected' end, decided_at = now(), note = p_note
  where id = v_approval.id;

  if not p_approve then
    update public.leave_requests set status = 'rejected', decided_at = now() where id = p_leave_request_id
    returning * into v_request;
  else
    select * into v_next from public.leave_approvals
    where leave_request_id = p_leave_request_id and status = 'pending'
    order by sequence asc limit 1;

    if v_next.id is not null then
      update public.leave_requests
      set status = case v_next.approver_role when 'manager' then 'pending_manager' else 'pending_supervisor' end
      where id = p_leave_request_id
      returning * into v_request;
    else
      update public.leave_requests set status = 'approved', decided_at = now() where id = p_leave_request_id
      returning * into v_request;

      insert into public.leave_ledger (
        organization_id, employee_id, leave_type_id, entry_type, amount, related_request_id, created_by
      )
      values (
        v_request.organization_id, v_request.employee_id, v_request.leave_type_id,
        'request_deduction', -v_request.total_days, v_request.id, auth.uid()
      );
    end if;
  end if;

  perform private.log_audit_event(
    v_request.organization_id,
    case when p_approve then 'LEAVE_APPROVED' else 'LEAVE_REJECTED' end,
    'leave_request', v_request.id, null, to_jsonb(v_request)
  );

  return v_request;
end;
$$;

create or replace function public.cancel_leave_request(p_leave_request_id uuid)
returns public.leave_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.leave_requests;
begin
  select * into v_request from public.leave_requests where id = p_leave_request_id for update;
  if v_request.id is null then
    raise exception 'Leave request not found';
  end if;
  if v_request.employee_id != private.current_employee_id() then
    raise exception 'Not authorized to cancel this request';
  end if;
  if v_request.status not in ('submitted', 'pending_supervisor', 'pending_manager', 'approved') then
    raise exception 'This request can no longer be cancelled';
  end if;

  if v_request.status = 'approved' then
    insert into public.leave_ledger (
      organization_id, employee_id, leave_type_id, entry_type, amount, related_request_id, created_by
    )
    values (
      v_request.organization_id, v_request.employee_id, v_request.leave_type_id,
      'request_reversal', v_request.total_days, v_request.id, auth.uid()
    );
  end if;

  update public.leave_requests set status = 'cancelled' where id = p_leave_request_id returning * into v_request;

  perform private.log_audit_event(v_request.organization_id, 'LEAVE_CANCELLED', 'leave_request', v_request.id, null, to_jsonb(v_request));

  return v_request;
end;
$$;

revoke execute on function public.submit_leave(uuid, date, date, boolean, text, uuid) from public;
revoke execute on function public.decide_leave_request(uuid, boolean, text) from public;
revoke execute on function public.cancel_leave_request(uuid) from public;
grant execute on function public.submit_leave(uuid, date, date, boolean, text, uuid) to authenticated;
grant execute on function public.decide_leave_request(uuid, boolean, text) to authenticated;
grant execute on function public.cancel_leave_request(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS policies
-- ---------------------------------------------------------------------------

create policy "org members read leave types" on public.leave_types for select to authenticated
  using (private.is_org_member(organization_id));
create policy "admins manage leave types" on public.leave_types for all to authenticated
  using (private.has_permission(organization_id, 'leave.manage_policies'))
  with check (private.has_permission(organization_id, 'leave.manage_policies'));

create policy "org members read leave policies" on public.leave_policies for select to authenticated
  using (private.is_org_member(organization_id));
create policy "admins manage leave policies" on public.leave_policies for all to authenticated
  using (private.has_permission(organization_id, 'leave.manage_policies'))
  with check (private.has_permission(organization_id, 'leave.manage_policies'));

create policy "read own leave policy assignment" on public.leave_policy_assignments for select to authenticated
  using (employee_id = private.current_employee_id());
create policy "admins manage leave policy assignments" on public.leave_policy_assignments for all to authenticated
  using (private.has_permission(organization_id, 'leave.manage_policies'))
  with check (private.has_permission(organization_id, 'leave.manage_policies'));

create policy "read own leave requests" on public.leave_requests for select to authenticated
  using (employee_id = private.current_employee_id());
create policy "read team leave requests" on public.leave_requests for select to authenticated
  using (private.has_permission(organization_id, 'leave.approve_direct_reports') and private.in_management_scope(employee_id));
create policy "read org leave requests" on public.leave_requests for select to authenticated
  using (private.has_permission(organization_id, 'leave.approve_unit'));
-- Writes go only through submit_leave()/decide_leave_request()/cancel_leave_request().

create policy "read own leave request days" on public.leave_request_days for select to authenticated
  using (leave_request_id in (select id from public.leave_requests where employee_id = private.current_employee_id()));
create policy "read team leave request days" on public.leave_request_days for select to authenticated
  using (
    leave_request_id in (
      select id from public.leave_requests r
      where private.has_permission(r.organization_id, 'leave.approve_direct_reports') and private.in_management_scope(r.employee_id)
    )
  );
create policy "read org leave request days" on public.leave_request_days for select to authenticated
  using (
    leave_request_id in (
      select id from public.leave_requests r where private.has_permission(r.organization_id, 'leave.approve_unit')
    )
  );

create policy "read own leave approvals" on public.leave_approvals for select to authenticated
  using (leave_request_id in (select id from public.leave_requests where employee_id = private.current_employee_id()));
create policy "read assigned leave approvals" on public.leave_approvals for select to authenticated
  using (approver_user_id = (select auth.uid()));
create policy "read org leave approvals" on public.leave_approvals for select to authenticated
  using (
    leave_request_id in (
      select id from public.leave_requests r where private.has_permission(r.organization_id, 'leave.approve_unit')
    )
  );

create policy "read own leave ledger" on public.leave_ledger for select to authenticated
  using (employee_id = private.current_employee_id());
create policy "read team leave ledger" on public.leave_ledger for select to authenticated
  using (private.has_permission(organization_id, 'leave.approve_direct_reports') and private.in_management_scope(employee_id));
create policy "read org leave ledger" on public.leave_ledger for select to authenticated
  using (private.has_permission(organization_id, 'leave.approve_unit'));
create policy "admins adjust leave ledger" on public.leave_ledger for insert to authenticated
  with check (private.has_permission(organization_id, 'leave.manage_policies'));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.leave_requests;
  end if;
end $$;
