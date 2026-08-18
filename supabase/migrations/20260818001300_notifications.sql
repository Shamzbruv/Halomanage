-- Halomanage — notifications (in-app now; external delivery via Edge Function)
-- Ref: PRODUCT_BLUEPRINT.md "Notifications"; ARCHITECTURE.md "Notifications".
--
-- Two layers, as the architecture doc specifies: this table + Realtime is
-- the in-app layer (fully Supabase-native). Email/SMS/push is a *separate*
-- concern — notification_delivery_attempts tracks whether the
-- send-notifications Edge Function got a row out the door, so a temporary
-- provider outage never loses the underlying notification.

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  employee_id uuid references public.employees(id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  link_url text,
  data jsonb not null default '{}'::jsonb,
  is_read boolean not null default false,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.notifications enable row level security;
create index notifications_recipient_idx on public.notifications(recipient_user_id, is_read, created_at desc);
create index notifications_org_idx on public.notifications(organization_id);

create table public.notification_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  notification_type text not null,
  channel text not null check (channel in ('in_app', 'email', 'sms', 'push')),
  enabled boolean not null default true,
  unique (user_id, organization_id, notification_type, channel)
);
alter table public.notification_preferences enable row level security;

create table public.notification_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications(id) on delete cascade,
  channel text not null check (channel in ('email', 'sms', 'push')),
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  provider text,
  provider_response jsonb,
  attempted_at timestamptz not null default now()
);
alter table public.notification_delivery_attempts enable row level security;
create index notification_delivery_notification_idx on public.notification_delivery_attempts(notification_id);

-- Used by triggers/RPCs across every module to raise a notification without
-- needing an INSERT policy for authenticated on this table (see below —
-- there is none; every notification is system-generated).
create or replace function private.create_notification(
  p_organization_id uuid,
  p_recipient_user_id uuid,
  p_employee_id uuid,
  p_type text,
  p_title text,
  p_body text default null,
  p_link_url text default null,
  p_data jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_enabled boolean;
begin
  select coalesce(np.enabled, true) into v_enabled
  from public.notification_preferences np
  where np.user_id = p_recipient_user_id and np.organization_id = p_organization_id
    and np.notification_type = p_type and np.channel = 'in_app';

  if v_enabled is distinct from false then
    insert into public.notifications (
      organization_id, recipient_user_id, employee_id, type, title, body, link_url, data
    )
    values (p_organization_id, p_recipient_user_id, p_employee_id, p_type, p_title, p_body, p_link_url, p_data)
    returning id into v_id;
  end if;

  return v_id;
end;
$$;

create or replace function public.mark_notification_read(p_id uuid)
returns public.notifications
language sql
security invoker
set search_path = ''
as $$
  update public.notifications set is_read = true, read_at = now()
  where id = p_id and recipient_user_id = (select auth.uid())
  returning *;
$$;

create or replace function public.mark_all_notifications_read()
returns setof public.notifications
language sql
security invoker
set search_path = ''
as $$
  update public.notifications set is_read = true, read_at = now()
  where recipient_user_id = (select auth.uid()) and is_read = false
  returning *;
$$;

revoke execute on function public.mark_notification_read(uuid) from public;
revoke execute on function public.mark_all_notifications_read() from public;
grant execute on function public.mark_notification_read(uuid) to authenticated;
grant execute on function public.mark_all_notifications_read() to authenticated;

create policy "read own notifications" on public.notifications for select to authenticated
  using (recipient_user_id = (select auth.uid()));
-- mark_notification_read/mark_all_notifications_read are SECURITY INVOKER,
-- so they need an UPDATE policy scoped to the caller's own notifications —
-- unlike the SECURITY DEFINER write-only RPCs elsewhere, "can I mark my own
-- notification read" is safe to express directly as RLS.
create policy "update own notifications" on public.notifications for update to authenticated
  using (recipient_user_id = (select auth.uid()))
  with check (recipient_user_id = (select auth.uid()));

create policy "manage own notification preferences" on public.notification_preferences for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "read own delivery attempts" on public.notification_delivery_attempts for select to authenticated
  using (notification_id in (select id from public.notifications where recipient_user_id = (select auth.uid())));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Representative triggers wiring real events to notifications. Not every
-- automation example in PRODUCT_BLUEPRINT.md is wired yet (certification
-- expiry, appraisal-due reminders, etc. are time-based and belong in
-- scheduled Cron jobs, not row triggers) — see docs/ROADMAP.md.
-- ---------------------------------------------------------------------------

-- Plain (non-trigger) function so both the INSERT trigger (initial
-- submission) and the UPDATE trigger (advanced to the next approver) can
-- call the same logic directly with an explicit request id, rather than
-- trying to invoke a trigger function outside of a trigger context.
create or replace function private.notify_pending_leave_approver(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.leave_requests;
  v_approver_user uuid;
  v_employee public.employees;
begin
  select * into v_request from public.leave_requests where id = p_request_id;
  if v_request.id is null or v_request.status not in ('pending_supervisor', 'pending_manager') then
    return;
  end if;

  select approver_user_id into v_approver_user
  from public.leave_approvals
  where leave_request_id = p_request_id and status = 'pending'
  order by sequence asc limit 1;

  select * into v_employee from public.employees where id = v_request.employee_id;

  if v_approver_user is not null then
    perform private.create_notification(
      v_request.organization_id, v_approver_user, v_request.employee_id, 'leave.requested',
      v_employee.first_name || ' ' || v_employee.last_name || ' requested ' || v_request.total_days || ' day(s) leave',
      'Awaiting your decision', '/leave/' || v_request.id, jsonb_build_object('leave_request_id', v_request.id)
    );
  end if;
end;
$$;

-- Note: there is deliberately no AFTER INSERT trigger on leave_requests
-- calling this. submit_leave() (20260818000700_leave.sql) inserts the
-- leave_requests row *before* it inserts the corresponding leave_approvals
-- rows (it needs the request id first) — an AFTER INSERT trigger on
-- leave_requests would therefore fire before any approval row exists to
-- notify about. submit_leave() calls
-- private.notify_pending_leave_approver() itself, explicitly, once the
-- approval chain is actually in place. The AFTER UPDATE trigger below has
-- no such ordering hazard: by the time a request's status changes to the
-- next pending stage, that stage's leave_approvals row was already created
-- back in submit_leave().
create or replace function private.notify_leave_decided()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee_user uuid;
begin
  if new.status in ('approved', 'rejected') and old.status is distinct from new.status then
    select user_id into v_employee_user from public.employees where id = new.employee_id;
    if v_employee_user is not null then
      perform private.create_notification(
        new.organization_id, v_employee_user, new.employee_id,
        case new.status when 'approved' then 'leave.approved' else 'leave.rejected' end,
        'Your leave request was ' || new.status,
        null, '/leave/' || new.id, jsonb_build_object('leave_request_id', new.id)
      );
    end if;
  elsif new.status in ('pending_supervisor', 'pending_manager') and old.status is distinct from new.status then
    perform private.notify_pending_leave_approver(new.id);
  end if;
  return new;
end;
$$;

create trigger leave_requests_notify_decided
  after update on public.leave_requests
  for each row execute function private.notify_leave_decided();

create or replace function private.notify_onboarding_task_assigned()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.assigned_to_user_id is not null then
    perform private.create_notification(
      new.organization_id, new.assigned_to_user_id, new.employee_id, 'onboarding.task_assigned',
      new.title, new.description, '/onboarding/tasks/' || new.id, jsonb_build_object('task_id', new.id)
    );
  end if;
  return new;
end;
$$;

create trigger onboarding_tasks_notify_assigned
  after insert on public.onboarding_tasks
  for each row execute function private.notify_onboarding_task_assigned();
