-- Halomanage — offboarding (reuses the onboarding template/run/task pattern)
-- Ref: PRODUCT_BLUEPRINT.md "Offboarding"; ARCHITECTURE.md offboarding notes.
--
-- Former employees are deactivated (employees.status = 'terminated'), never
-- deleted, so payroll-import history, audit trail and reporting stay valid.

create table public.offboarding_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.offboarding_templates enable row level security;
create index offboarding_templates_org_idx on public.offboarding_templates(organization_id);

create table public.offboarding_template_steps (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.offboarding_templates(id) on delete cascade,
  title text not null,
  description text,
  assignee_type text not null default 'hr' check (assignee_type in ('employee', 'supervisor', 'manager', 'hr', 'it')),
  sequence integer not null,
  due_offset_days integer not null default 0,
  required boolean not null default true,
  unique (template_id, sequence)
);
alter table public.offboarding_template_steps enable row level security;

create table public.offboarding_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  template_id uuid not null references public.offboarding_templates(id) on delete restrict,
  final_work_date date,
  status text not null default 'in_progress' check (status in ('in_progress', 'completed', 'cancelled')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_by uuid references auth.users(id)
);
alter table public.offboarding_runs enable row level security;
create index offboarding_runs_employee_idx on public.offboarding_runs(employee_id);
create unique index offboarding_runs_one_open on public.offboarding_runs(employee_id) where status = 'in_progress';

create table public.offboarding_tasks (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.offboarding_runs(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  title text not null,
  description text,
  assignee_type text not null,
  assigned_to_user_id uuid references auth.users(id),
  sequence integer not null,
  due_date date,
  required boolean not null default true,
  status text not null default 'pending' check (status in ('pending', 'completed', 'skipped')),
  completed_at timestamptz,
  completed_by uuid references auth.users(id)
);
alter table public.offboarding_tasks enable row level security;
create index offboarding_tasks_run_idx on public.offboarding_tasks(run_id, sequence);
create index offboarding_tasks_employee_idx on public.offboarding_tasks(employee_id, status);

create or replace function private.instantiate_offboarding(p_employee_id uuid, p_template_id uuid default null, p_final_work_date date default null)
returns public.offboarding_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  v_template public.offboarding_templates;
  v_run public.offboarding_runs;
  v_supervisor_user uuid;
  v_manager_user uuid;
  step record;
begin
  select * into v_employee from public.employees where id = p_employee_id;
  if v_employee.id is null then
    raise exception 'Employee not found';
  end if;

  if exists (select 1 from public.offboarding_runs where employee_id = p_employee_id and status = 'in_progress') then
    return (select r from public.offboarding_runs r where employee_id = p_employee_id and status = 'in_progress' limit 1);
  end if;

  select * into v_template from public.offboarding_templates t
  where t.organization_id = v_employee.organization_id
    and (p_template_id is null or t.id = p_template_id)
    and (p_template_id is not null or t.is_default)
  limit 1;

  if v_template.id is null then
    return null; -- no offboarding template configured for this org yet — nothing to instantiate
  end if;

  insert into public.offboarding_runs (organization_id, employee_id, template_id, final_work_date, created_by)
  values (v_employee.organization_id, p_employee_id, v_template.id, p_final_work_date, auth.uid())
  returning * into v_run;

  select supervisor_employee_id, manager_employee_id
  into v_supervisor_user, v_manager_user
  from public.employee_assignments where employee_id = p_employee_id and end_date is null;

  for step in select * from public.offboarding_template_steps where template_id = v_template.id order by sequence asc
  loop
    insert into public.offboarding_tasks (
      run_id, organization_id, employee_id, title, description, assignee_type, assigned_to_user_id,
      sequence, due_date, required
    )
    values (
      v_run.id, v_employee.organization_id, p_employee_id, step.title, step.description, step.assignee_type,
      case step.assignee_type
        when 'employee' then v_employee.user_id
        when 'supervisor' then (select user_id from public.employees where id = v_supervisor_user)
        when 'manager' then (select user_id from public.employees where id = v_manager_user)
        else null
      end,
      step.sequence, (current_date + step.due_offset_days), step.required
    );
  end loop;

  perform private.log_audit_event(v_employee.organization_id, 'OFFBOARDING_STARTED', 'offboarding_run', v_run.id, null, to_jsonb(v_run));

  return v_run;
end;
$$;

create or replace function public.start_offboarding(p_employee_id uuid, p_template_id uuid default null, p_final_work_date date default null)
returns public.offboarding_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.employees where id = p_employee_id;
  if not private.has_permission(v_org, 'employee.manage') then
    raise exception 'Not authorized to start offboarding';
  end if;
  return private.instantiate_offboarding(p_employee_id, p_template_id, p_final_work_date);
end;
$$;

create or replace function public.complete_offboarding_task(p_task_id uuid)
returns public.offboarding_tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.offboarding_tasks;
  v_remaining integer;
begin
  select * into v_task from public.offboarding_tasks where id = p_task_id for update;
  if v_task.id is null then
    raise exception 'Offboarding task not found';
  end if;

  if v_task.assigned_to_user_id != (select auth.uid())
     and not private.has_permission(v_task.organization_id, 'employee.manage')
  then
    raise exception 'Not authorized to complete this task';
  end if;

  update public.offboarding_tasks set status = 'completed', completed_at = now(), completed_by = auth.uid()
  where id = p_task_id
  returning * into v_task;

  select count(*) into v_remaining from public.offboarding_tasks
  where run_id = v_task.run_id and required and status != 'completed';

  if v_remaining = 0 then
    update public.offboarding_runs set status = 'completed', completed_at = now() where id = v_task.run_id;
  end if;

  perform private.log_audit_event(v_task.organization_id, 'OFFBOARDING_TASK_COMPLETED', 'offboarding_task', v_task.id, null, to_jsonb(v_task));

  return v_task;
end;
$$;

-- Entering "terminated" status automatically launches the org's default
-- offboarding checklist (PRODUCT_BLUEPRINT.md automation example:
-- "Termination entered → offboarding checklist launched"). Silent no-op if
-- the org hasn't configured a default template yet.
create or replace function private.employee_status_offboarding_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'terminated' and (old.status is distinct from 'terminated') then
    perform private.instantiate_offboarding(new.id, null, new.termination_date);
  end if;
  return new;
end;
$$;

create trigger employees_auto_offboarding
  after update on public.employees
  for each row execute function private.employee_status_offboarding_trigger();

revoke execute on function public.start_offboarding(uuid, uuid, date) from public;
revoke execute on function public.complete_offboarding_task(uuid) from public;
grant execute on function public.start_offboarding(uuid, uuid, date) to authenticated;
grant execute on function public.complete_offboarding_task(uuid) to authenticated;

create policy "org members read offboarding templates" on public.offboarding_templates for select to authenticated
  using (private.is_org_member(organization_id));
create policy "admins manage offboarding templates" on public.offboarding_templates for all to authenticated
  using (private.has_permission(organization_id, 'onboarding.manage_templates'))
  with check (private.has_permission(organization_id, 'onboarding.manage_templates'));

create policy "org members read offboarding steps" on public.offboarding_template_steps for select to authenticated
  using (private.is_org_member((select organization_id from public.offboarding_templates t where t.id = template_id)));
create policy "admins manage offboarding steps" on public.offboarding_template_steps for all to authenticated
  using (private.has_permission((select organization_id from public.offboarding_templates t where t.id = template_id), 'onboarding.manage_templates'))
  with check (private.has_permission((select organization_id from public.offboarding_templates t where t.id = template_id), 'onboarding.manage_templates'));

create policy "read own offboarding runs" on public.offboarding_runs for select to authenticated
  using (employee_id = private.current_employee_id());
create policy "hr read offboarding runs" on public.offboarding_runs for select to authenticated
  using (private.has_permission(organization_id, 'employee.manage'));

create policy "read own offboarding tasks" on public.offboarding_tasks for select to authenticated
  using (employee_id = private.current_employee_id() or assigned_to_user_id = (select auth.uid()));
create policy "hr read offboarding tasks" on public.offboarding_tasks for select to authenticated
  using (private.has_permission(organization_id, 'employee.manage'));
