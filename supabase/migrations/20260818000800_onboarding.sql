-- Halomanage — employer-configured onboarding workflow engine
-- Ref: PRODUCT_BLUEPRINT.md "Your onboarding vision"; ARCHITECTURE.md
-- "Employer-configured onboarding".
--
-- Templates are versioned; a run instantiates concrete tasks from whichever
-- version was current when it started and keeps that version even if the
-- employer edits the template later — editing a future template must never
-- silently rewrite someone's in-flight onboarding.

create table public.onboarding_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  description text,
  -- optional targeting filter, e.g. {"position_ids": [...], "org_unit_ids": [...]}
  applies_to jsonb not null default '{}'::jsonb,
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
alter table public.onboarding_templates enable row level security;
create index onboarding_templates_org_idx on public.onboarding_templates(organization_id);

create table public.onboarding_template_versions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.onboarding_templates(id) on delete cascade,
  version_number integer not null,
  is_current boolean not null default false,
  published_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  unique (template_id, version_number)
);
alter table public.onboarding_template_versions enable row level security;
create unique index onboarding_template_versions_one_current
  on public.onboarding_template_versions(template_id) where is_current;

create table public.onboarding_template_steps (
  id uuid primary key default gen_random_uuid(),
  template_version_id uuid not null references public.onboarding_template_versions(id) on delete cascade,
  title text not null,
  description text,
  step_type text not null check (step_type in (
    'task', 'form', 'document_upload', 'document_review', 'acknowledgement',
    'signature', 'training', 'meeting', 'approval', 'checkpoint'
  )),
  assignee_type text not null default 'employee'
    check (assignee_type in ('employee', 'supervisor', 'manager', 'hr', 'it')),
  sequence integer not null,
  due_offset_days integer not null default 0,
  required boolean not null default true,
  dependency_step_ids uuid[] not null default '{}',
  form_schema jsonb,
  document_template_id uuid,
  requires_signature boolean not null default false,
  unique (template_version_id, sequence)
);
alter table public.onboarding_template_steps enable row level security;
create index onboarding_template_steps_version_idx on public.onboarding_template_steps(template_version_id);

create table public.onboarding_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  template_version_id uuid not null references public.onboarding_template_versions(id) on delete restrict,
  status text not null default 'in_progress' check (status in ('in_progress', 'completed', 'cancelled')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_by uuid references auth.users(id)
);
alter table public.onboarding_runs enable row level security;
create index onboarding_runs_employee_idx on public.onboarding_runs(employee_id);
create index onboarding_runs_org_status_idx on public.onboarding_runs(organization_id, status);

create table public.onboarding_tasks (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.onboarding_runs(id) on delete cascade,
  template_step_id uuid not null references public.onboarding_template_steps(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  title text not null,
  description text,
  step_type text not null,
  assignee_type text not null,
  assigned_to_user_id uuid references auth.users(id),
  sequence integer not null,
  due_date date,
  required boolean not null default true,
  dependency_step_ids uuid[] not null default '{}',
  requires_signature boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'completed', 'skipped', 'blocked')),
  completion_data jsonb,
  completed_at timestamptz,
  completed_by uuid references auth.users(id),
  signed_at timestamptz
);
alter table public.onboarding_tasks enable row level security;
create index onboarding_tasks_run_idx on public.onboarding_tasks(run_id, sequence);
create index onboarding_tasks_employee_idx on public.onboarding_tasks(employee_id, status);
create index onboarding_tasks_assignee_idx on public.onboarding_tasks(assigned_to_user_id, status);

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

create or replace function public.start_onboarding(p_employee_id uuid, p_template_id uuid default null)
returns public.onboarding_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  v_version public.onboarding_template_versions;
  v_run public.onboarding_runs;
  v_supervisor_user uuid;
  v_manager_user uuid;
  step record;
  v_assignee uuid;
begin
  select * into v_employee from public.employees where id = p_employee_id;
  if v_employee.id is null then
    raise exception 'Employee not found';
  end if;

  if not private.has_permission(v_employee.organization_id, 'onboarding.manage_team')
     and not private.has_permission(v_employee.organization_id, 'employee.manage')
  then
    raise exception 'Not authorized to start onboarding';
  end if;

  select v.* into v_version
  from public.onboarding_template_versions v
  join public.onboarding_templates t on t.id = v.template_id
  where t.organization_id = v_employee.organization_id
    and v.is_current
    and (p_template_id is null or t.id = p_template_id)
    and (p_template_id is not null or t.is_default)
  order by v.published_at desc
  limit 1;

  if v_version.id is null then
    raise exception 'No current onboarding template version found';
  end if;

  insert into public.onboarding_runs (organization_id, employee_id, template_version_id, created_by)
  values (v_employee.organization_id, p_employee_id, v_version.id, auth.uid())
  returning * into v_run;

  select supervisor_employee_id, manager_employee_id
  into v_supervisor_user, v_manager_user
  from public.employee_assignments where employee_id = p_employee_id and end_date is null;

  for step in
    select * from public.onboarding_template_steps
    where template_version_id = v_version.id order by sequence asc
  loop
    v_assignee := case step.assignee_type
      when 'employee' then v_employee.user_id
      when 'supervisor' then (select user_id from public.employees where id = v_supervisor_user)
      when 'manager' then (select user_id from public.employees where id = v_manager_user)
      else null
    end;

    insert into public.onboarding_tasks (
      run_id, template_step_id, organization_id, employee_id, title, description, step_type,
      assignee_type, assigned_to_user_id, sequence, due_date, required, dependency_step_ids, requires_signature
    )
    values (
      v_run.id, step.id, v_employee.organization_id, p_employee_id, step.title, step.description, step.step_type,
      step.assignee_type, v_assignee, step.sequence,
      (current_date + step.due_offset_days), step.required, step.dependency_step_ids, step.requires_signature
    );
  end loop;

  perform private.log_audit_event(
    v_employee.organization_id, 'ONBOARDING_STARTED', 'onboarding_run', v_run.id, null, to_jsonb(v_run)
  );

  return v_run;
end;
$$;

create or replace function public.complete_onboarding_task(p_task_id uuid, p_completion_data jsonb default null)
returns public.onboarding_tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.onboarding_tasks;
  v_incomplete_deps integer;
  v_remaining integer;
begin
  select * into v_task from public.onboarding_tasks where id = p_task_id for update;
  if v_task.id is null then
    raise exception 'Onboarding task not found';
  end if;
  if v_task.status = 'completed' then
    return v_task;
  end if;

  if v_task.assigned_to_user_id != (select auth.uid())
     and not private.has_permission(v_task.organization_id, 'onboarding.manage_team')
  then
    raise exception 'Not authorized to complete this task';
  end if;

  if array_length(v_task.dependency_step_ids, 1) > 0 then
    select count(*) into v_incomplete_deps
    from public.onboarding_tasks t
    where t.run_id = v_task.run_id
      and t.template_step_id = any(v_task.dependency_step_ids)
      and t.status != 'completed';
    if v_incomplete_deps > 0 then
      raise exception 'This task has incomplete prerequisite steps';
    end if;
  end if;

  update public.onboarding_tasks
  set status = 'completed', completed_at = now(), completed_by = auth.uid(),
      completion_data = p_completion_data,
      signed_at = case when v_task.requires_signature then now() else signed_at end
  where id = p_task_id
  returning * into v_task;

  select count(*) into v_remaining
  from public.onboarding_tasks
  where run_id = v_task.run_id and required and status != 'completed';

  if v_remaining = 0 then
    update public.onboarding_runs set status = 'completed', completed_at = now() where id = v_task.run_id;
  end if;

  perform private.log_audit_event(
    v_task.organization_id, 'ONBOARDING_TASK_COMPLETED', 'onboarding_task', v_task.id, null, to_jsonb(v_task)
  );

  return v_task;
end;
$$;

revoke execute on function public.start_onboarding(uuid, uuid) from public;
revoke execute on function public.complete_onboarding_task(uuid, jsonb) from public;
grant execute on function public.start_onboarding(uuid, uuid) to authenticated;
grant execute on function public.complete_onboarding_task(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS policies
-- ---------------------------------------------------------------------------

create policy "org members read onboarding templates" on public.onboarding_templates for select to authenticated
  using (private.is_org_member(organization_id));
create policy "admins manage onboarding templates" on public.onboarding_templates for all to authenticated
  using (private.has_permission(organization_id, 'onboarding.manage_templates'))
  with check (private.has_permission(organization_id, 'onboarding.manage_templates'));

create policy "org members read template versions" on public.onboarding_template_versions for select to authenticated
  using (private.is_org_member((select organization_id from public.onboarding_templates t where t.id = template_id)));
create policy "admins manage template versions" on public.onboarding_template_versions for all to authenticated
  using (private.has_permission((select organization_id from public.onboarding_templates t where t.id = template_id), 'onboarding.manage_templates'))
  with check (private.has_permission((select organization_id from public.onboarding_templates t where t.id = template_id), 'onboarding.manage_templates'));

create policy "org members read template steps" on public.onboarding_template_steps for select to authenticated
  using (private.is_org_member((
    select t.organization_id from public.onboarding_template_versions v
    join public.onboarding_templates t on t.id = v.template_id
    where v.id = template_version_id
  )));
create policy "admins manage template steps" on public.onboarding_template_steps for all to authenticated
  using (private.has_permission((
    select t.organization_id from public.onboarding_template_versions v
    join public.onboarding_templates t on t.id = v.template_id
    where v.id = template_version_id
  ), 'onboarding.manage_templates'))
  with check (private.has_permission((
    select t.organization_id from public.onboarding_template_versions v
    join public.onboarding_templates t on t.id = v.template_id
    where v.id = template_version_id
  ), 'onboarding.manage_templates'));

create policy "read own onboarding runs" on public.onboarding_runs for select to authenticated
  using (employee_id = private.current_employee_id());
create policy "read team onboarding runs" on public.onboarding_runs for select to authenticated
  using (private.has_permission(organization_id, 'onboarding.manage_team') and private.in_management_scope(employee_id));
create policy "hr read onboarding runs" on public.onboarding_runs for select to authenticated
  using (private.has_permission(organization_id, 'employee.manage'));
-- Writes go only through start_onboarding()/complete_onboarding_task().

create policy "read own onboarding tasks" on public.onboarding_tasks for select to authenticated
  using (employee_id = private.current_employee_id() or assigned_to_user_id = (select auth.uid()));
create policy "read team onboarding tasks" on public.onboarding_tasks for select to authenticated
  using (private.has_permission(organization_id, 'onboarding.manage_team') and private.in_management_scope(employee_id));
create policy "hr read onboarding tasks" on public.onboarding_tasks for select to authenticated
  using (private.has_permission(organization_id, 'employee.manage'));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.onboarding_tasks;
  end if;
end $$;
