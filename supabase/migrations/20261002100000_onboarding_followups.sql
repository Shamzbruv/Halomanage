-- Halomanage — onboarding follow-ups after the employee-setup release
--
-- 1. Timezone: the onboarding SQL from 20260910100000 used Postgres
--    current_date / ::date, which are UTC on Supabase. For a Jamaica
--    organization (UTC-5) a run started at 8pm was dated tomorrow, and a
--    task due today showed overdue from 7pm. Everything here now uses the
--    organization's own timezone — the database-side equivalent of
--    web/lib/timezone.ts's todayIn().
-- 2. HR and IT steps resolve to a real person. Previously only employee /
--    supervisor / manager steps had an assignee; HR/IT steps were
--    completable by any onboarding manager but sat on nobody's dashboard.
--    Resolution order: the step's own named person → the organization's
--    responsible person for that kind of step → unassigned (any onboarding
--    manager can still complete it). HR can also reassign one task on one
--    run, which then stays where they put it.
-- 3. Someone assigned an onboarding step for another employee can see
--    whose onboarding it is, without being granted read access to that
--    employee's record.

-- ---------------------------------------------------------------------------
-- 1. Organization-local dates
-- ---------------------------------------------------------------------------

create or replace function private.org_local_date(p_organization_id uuid, p_at timestamptz)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select case when p_at is null then null else (p_at at time zone coalesce(
    (select nullif(btrim(o.timezone), '') from public.organizations o where o.id = p_organization_id),
    'America/Jamaica'
  ))::date end;
$$;

create or replace function private.org_today(p_organization_id uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select private.org_local_date(p_organization_id, now());
$$;

create or replace function private.onboarding_anchor_date(
  p_anchor text,
  p_employee public.employees,
  p_run_start date
)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select case p_anchor
    when 'run_start' then p_run_start
    when 'hire_date' then p_employee.hire_date
    when 'probation_end_date' then p_employee.probation_end_date
    when 'invitation_date' then (
      select private.org_local_date(p_employee.organization_id, coalesce(u.invited_at, u.created_at))
      from auth.users u where u.id = p_employee.user_id
    )
  end;
$$;

create or replace view public.onboarding_progress_v
  with (security_invoker = true)
as
select
  r.id as run_id,
  r.organization_id,
  r.employee_id,
  r.status,
  count(t.id) as total_tasks,
  count(t.id) filter (where t.status in ('completed', 'skipped')) as completed_tasks,
  count(t.id) filter (
    where t.status not in ('completed', 'skipped')
      and r.status = 'in_progress'
      and t.due_date < private.org_today(r.organization_id)
  ) as overdue_tasks,
  round(
    (count(t.id) filter (where t.status in ('completed', 'skipped')))::numeric
    / nullif(count(t.id), 0) * 100, 1
  ) as percent_complete
from public.onboarding_runs r
left join public.onboarding_tasks t on t.run_id = r.id
group by r.id, r.organization_id, r.employee_id, r.status;

-- ---------------------------------------------------------------------------
-- 2. Responsible people for HR / IT steps
-- ---------------------------------------------------------------------------

create table public.onboarding_responsibilities (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  assignee_type text not null check (assignee_type in ('hr', 'it')),
  employee_id uuid not null references public.employees(id) on delete cascade,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  primary key (organization_id, assignee_type)
);
alter table public.onboarding_responsibilities enable row level security;

create policy "onboarding managers read responsibilities" on public.onboarding_responsibilities
  for select to authenticated
  using (
    private.has_permission(organization_id, 'onboarding.manage_templates')
    or private.has_permission(organization_id, 'onboarding.manage_team')
    or private.has_permission(organization_id, 'employee.manage')
  );
-- Writes only through set_onboarding_responsible().
grant select on public.onboarding_responsibilities to authenticated;

alter table public.onboarding_template_steps
  add column if not exists assignee_employee_id uuid references public.employees(id) on delete set null;

comment on column public.onboarding_template_steps.assignee_employee_id is
  'Optional named person for this step (HR/IT steps). Overrides the organization''s responsible person for the step''s assignee_type.';

alter table public.onboarding_tasks
  add column if not exists assignee_employee_id uuid references public.employees(id) on delete set null,
  add column if not exists assignment_locked boolean not null default false;

comment on column public.onboarding_tasks.assignee_employee_id is
  'The person responsible for this task (the onboardee, their supervisor/manager, or the named HR/IT owner).';
comment on column public.onboarding_tasks.assignment_locked is
  'Set when HR reassigns a task by hand; automatic re-resolution then leaves it alone.';

-- Who should own a step for this employee right now (employee id, not
-- user id — the person may not have an account yet).
create or replace function private.onboarding_assignee_employee(
  p_employee public.employees,
  p_assignee_type text,
  p_step_assignee uuid
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case p_assignee_type
    when 'employee' then p_employee.id
    when 'supervisor' then (select a.supervisor_employee_id from public.employee_assignments a where a.employee_id = p_employee.id and a.end_date is null)
    when 'manager' then (select a.manager_employee_id from public.employee_assignments a where a.employee_id = p_employee.id and a.end_date is null)
    else coalesce(
      (select e.id from public.employees e where e.id = p_step_assignee and e.organization_id = p_employee.organization_id and e.status <> 'terminated'),
      (select r.employee_id from public.onboarding_responsibilities r
        join public.employees e on e.id = r.employee_id and e.status <> 'terminated'
        where r.organization_id = p_employee.organization_id and r.assignee_type = p_assignee_type)
    )
  end;
$$;

create or replace function private.instantiate_onboarding_run(
  p_employee_id uuid,
  p_template_id uuid,
  p_actor uuid
)
returns public.onboarding_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  v_version public.onboarding_template_versions;
  v_run public.onboarding_runs;
  v_run_start date;
  step record;
  v_owner uuid;
begin
  select * into v_employee from public.employees where id = p_employee_id;
  if v_employee.id is null then
    raise exception 'Employee not found';
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
  values (v_employee.organization_id, p_employee_id, v_version.id, p_actor)
  returning * into v_run;

  v_run_start := private.org_local_date(v_employee.organization_id, v_run.started_at);

  for step in
    select * from public.onboarding_template_steps
    where template_version_id = v_version.id order by sequence asc
  loop
    v_owner := private.onboarding_assignee_employee(v_employee, step.assignee_type, step.assignee_employee_id);

    insert into public.onboarding_tasks (
      run_id, template_step_id, organization_id, employee_id, title, description, step_type,
      assignee_type, assignee_employee_id, assigned_to_user_id, sequence, due_date, required,
      dependency_step_ids, requires_signature, due_anchor, due_offset_days, phase
    )
    values (
      v_run.id, step.id, v_employee.organization_id, p_employee_id, step.title, step.description, step.step_type,
      step.assignee_type, v_owner, (select e.user_id from public.employees e where e.id = v_owner), step.sequence,
      private.onboarding_anchor_date(step.due_anchor, v_employee, v_run_start) + step.due_offset_days,
      step.required, step.dependency_step_ids, step.requires_signature,
      step.due_anchor, step.due_offset_days, step.phase
    );
  end loop;

  perform private.log_audit_event(
    v_employee.organization_id, 'ONBOARDING_STARTED', 'onboarding_run', v_run.id, null,
    to_jsonb(v_run) || jsonb_build_object('template_id', v_version.template_id, 'version_number', v_version.version_number)
  );

  return v_run;
end;
$$;

-- Re-resolves every open task that concerns this employee — as onboardee,
-- as supervisor/manager of the onboardee, or as the named owner — so tasks
-- follow reporting-line changes and pick up accounts created later.
-- Hand-reassigned tasks keep their person (only their account is refreshed).
create or replace function private.resolve_onboarding_assignees(p_employee_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with candidates as (
    select t.id, t.assignee_type, t.assignee_employee_id, t.assignment_locked, e as onboardee,
      tmpl.assignee_employee_id as step_assignee
    from public.onboarding_tasks t
    join public.onboarding_runs r on r.id = t.run_id and r.status = 'in_progress'
    join public.employees e on e.id = t.employee_id
    left join public.onboarding_template_steps tmpl on tmpl.id = t.template_step_id
    left join public.employee_assignments a on a.employee_id = e.id and a.end_date is null
    where t.status not in ('completed', 'skipped')
      and (
        t.employee_id = p_employee_id
        or t.assignee_employee_id = p_employee_id
        or a.supervisor_employee_id = p_employee_id
        or a.manager_employee_id = p_employee_id
      )
  ),
  resolved as (
    select c.id,
      case
        when c.assignment_locked then c.assignee_employee_id
        when c.assignee_type in ('hr', 'it') and c.assignee_employee_id is not null then c.assignee_employee_id
        else private.onboarding_assignee_employee(c.onboardee, c.assignee_type, c.step_assignee)
      end as owner
    from candidates c
  ),
  owners as (
    select resolved.id, resolved.owner, e.user_id
    from resolved
    join public.employees e on e.id = resolved.owner
  )
  update public.onboarding_tasks t
  set assignee_employee_id = owners.owner,
      assigned_to_user_id = coalesce(owners.user_id, t.assigned_to_user_id)
  from owners
  where t.id = owners.id
    and (t.assignee_employee_id is distinct from owners.owner
         or (owners.user_id is not null and t.assigned_to_user_id is distinct from owners.user_id));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function private.recompute_onboarding_due_dates(p_employee_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.onboarding_tasks t
  set due_date = private.onboarding_anchor_date(t.due_anchor, e, private.org_local_date(r.organization_id, r.started_at)) + t.due_offset_days
  from public.onboarding_runs r, public.employees e
  where t.employee_id = p_employee_id
    and r.id = t.run_id
    and e.id = t.employee_id
    and r.status = 'in_progress'
    and t.status not in ('completed', 'skipped')
    and t.due_offset_days is not null
    and t.due_date is distinct from (
      private.onboarding_anchor_date(t.due_anchor, e, private.org_local_date(r.organization_id, r.started_at)) + t.due_offset_days
    );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.set_onboarding_responsible(
  p_organization_id uuid,
  p_assignee_type text,
  p_employee_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_assigned integer := 0;
begin
  if not private.has_permission(p_organization_id, 'onboarding.manage_templates')
     and not private.has_permission(p_organization_id, 'employee.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to set onboarding responsibilities';
  end if;
  if p_assignee_type not in ('hr', 'it') then
    raise exception using errcode = '22023', message = 'Only HR and IT steps have an organization-wide owner';
  end if;

  if p_employee_id is null then
    delete from public.onboarding_responsibilities
    where organization_id = p_organization_id and assignee_type = p_assignee_type;
  else
    if not exists (
      select 1 from public.employees e
      where e.id = p_employee_id and e.organization_id = p_organization_id and e.status <> 'terminated'
    ) then
      raise exception using errcode = '23514', message = 'Choose a current employee of this organization';
    end if;

    insert into public.onboarding_responsibilities (organization_id, assignee_type, employee_id, updated_by)
    values (p_organization_id, p_assignee_type, p_employee_id, auth.uid())
    on conflict (organization_id, assignee_type) do update
    set employee_id = excluded.employee_id, updated_by = excluded.updated_by, updated_at = now();

    -- Open steps of this kind that nobody owns yet go to the new owner;
    -- steps with a named person or a hand reassignment stay put.
    update public.onboarding_tasks t
    set assignee_employee_id = p_employee_id,
        assigned_to_user_id = (select e.user_id from public.employees e where e.id = p_employee_id)
    from public.onboarding_runs r
    where r.id = t.run_id
      and r.status = 'in_progress'
      and t.organization_id = p_organization_id
      and t.assignee_type = p_assignee_type
      and t.status not in ('completed', 'skipped')
      and not t.assignment_locked
      and t.assignee_employee_id is null;
    get diagnostics v_assigned = row_count;
  end if;

  perform private.log_audit_event(
    p_organization_id, 'ONBOARDING_RESPONSIBILITY_SET', 'organization', p_organization_id, null,
    jsonb_build_object('assignee_type', p_assignee_type, 'employee_id', p_employee_id, 'open_tasks_assigned', v_assigned)
  );
  return v_assigned;
end;
$$;

revoke execute on function public.set_onboarding_responsible(uuid, text, uuid) from public, anon;
grant execute on function public.set_onboarding_responsible(uuid, text, uuid) to authenticated;

create or replace function public.reassign_onboarding_task(p_task_id uuid, p_employee_id uuid)
returns public.onboarding_tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.onboarding_tasks;
  v_assignee public.employees;
begin
  select * into v_task from public.onboarding_tasks where id = p_task_id for update;
  if v_task.id is null then
    raise exception 'Onboarding task not found';
  end if;
  if not private.has_permission(v_task.organization_id, 'onboarding.manage_team')
     and not private.has_permission(v_task.organization_id, 'employee.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to reassign onboarding tasks';
  end if;
  if v_task.status in ('completed', 'skipped') then
    raise exception using errcode = '23514', message = 'This step is already closed';
  end if;
  select * into v_assignee from public.employees
  where id = p_employee_id and organization_id = v_task.organization_id and status <> 'terminated';
  if v_assignee.id is null then
    raise exception using errcode = '23514', message = 'Choose a current employee of this organization';
  end if;

  update public.onboarding_tasks
  set assignee_employee_id = v_assignee.id,
      assigned_to_user_id = v_assignee.user_id,
      assignment_locked = true
  where id = p_task_id
  returning * into v_task;

  perform private.log_audit_event(
    v_task.organization_id, 'ONBOARDING_TASK_REASSIGNED', 'onboarding_task', v_task.id, null,
    jsonb_build_object('title', v_task.title, 'employee_id', v_task.employee_id, 'assignee_employee_id', v_assignee.id)
  );
  return v_task;
end;
$$;

revoke execute on function public.reassign_onboarding_task(uuid, uuid) from public, anon;
grant execute on function public.reassign_onboarding_task(uuid, uuid) to authenticated;

-- Steps now carry an optional named owner; forked versions keep it.
create or replace function private.clone_onboarding_steps(p_from_version uuid, p_to_version uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.onboarding_template_steps (
    template_version_id, title, description, step_type, assignee_type, sequence, due_offset_days,
    required, dependency_step_ids, form_schema, document_template_id, requires_signature,
    due_anchor, phase, source_step_id, assignee_employee_id
  )
  select p_to_version, s.title, s.description, s.step_type, s.assignee_type, s.sequence, s.due_offset_days,
         s.required, '{}', s.form_schema, s.document_template_id, s.requires_signature,
         s.due_anchor, s.phase, s.id, s.assignee_employee_id
  from public.onboarding_template_steps s
  where s.template_version_id = p_from_version;

  update public.onboarding_template_steps n
  set dependency_step_ids = coalesce((
    select array_agg(m.id)
    from public.onboarding_template_steps old_step
    cross join lateral unnest(old_step.dependency_step_ids) as dep(step_id)
    join public.onboarding_template_steps m
      on m.template_version_id = p_to_version and m.source_step_id = dep.step_id
    where old_step.id = n.source_step_id
  ), '{}')
  where n.template_version_id = p_to_version;
end;
$$;

drop function if exists public.save_onboarding_template_step(uuid, uuid, text, text, text, text, text, integer, boolean, text, uuid[]);

create or replace function public.save_onboarding_template_step(
  p_template_id uuid,
  p_step_id uuid,
  p_title text,
  p_description text,
  p_step_type text,
  p_assignee_type text,
  p_due_anchor text,
  p_due_offset_days integer,
  p_required boolean,
  p_phase text default null,
  p_dependency_step_ids uuid[] default '{}',
  p_assignee_employee_id uuid default null
)
returns public.onboarding_template_steps
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_template public.onboarding_templates;
  v_version uuid;
  v_step_id uuid;
  v_dependencies uuid[];
  v_owner uuid;
  v_step public.onboarding_template_steps;
begin
  v_template := private.require_template_manager(p_template_id);
  if nullif(btrim(coalesce(p_title, '')), '') is null then
    raise exception using errcode = '22023', message = 'A step needs a title';
  end if;

  -- A named owner only makes sense for HR/IT steps; employee, supervisor
  -- and manager steps always follow the onboardee's own reporting line.
  v_owner := case when p_assignee_type in ('hr', 'it') then p_assignee_employee_id end;
  if v_owner is not null and not exists (
    select 1 from public.employees e where e.id = v_owner and e.organization_id = v_template.organization_id
  ) then
    raise exception using errcode = '23514', message = 'Choose an employee of this organization';
  end if;

  v_version := private.ensure_editable_onboarding_version(p_template_id);

  if p_step_id is not null then
    v_step_id := private.map_onboarding_step(p_step_id, v_version);
    if v_step_id is null then
      raise exception 'That step is not part of this template';
    end if;
  end if;

  select coalesce(array_agg(mapped), '{}') into v_dependencies
  from (
    select private.map_onboarding_step(d, v_version) as mapped
    from unnest(coalesce(p_dependency_step_ids, '{}')) as d
  ) m
  where mapped is not null and mapped is distinct from v_step_id;

  if v_step_id is null then
    insert into public.onboarding_template_steps (
      template_version_id, title, description, step_type, assignee_type, sequence,
      due_anchor, due_offset_days, required, phase, dependency_step_ids, assignee_employee_id
    ) values (
      v_version, btrim(p_title), nullif(btrim(coalesce(p_description, '')), ''), p_step_type, p_assignee_type,
      coalesce((select max(sequence) from public.onboarding_template_steps where template_version_id = v_version), 0) + 1,
      coalesce(p_due_anchor, 'run_start'), coalesce(p_due_offset_days, 0), coalesce(p_required, true), p_phase, v_dependencies, v_owner
    )
    returning * into v_step;
  else
    update public.onboarding_template_steps
    set title = btrim(p_title),
        description = nullif(btrim(coalesce(p_description, '')), ''),
        step_type = p_step_type,
        assignee_type = p_assignee_type,
        due_anchor = coalesce(p_due_anchor, 'run_start'),
        due_offset_days = coalesce(p_due_offset_days, 0),
        required = coalesce(p_required, true),
        phase = p_phase,
        dependency_step_ids = v_dependencies,
        assignee_employee_id = v_owner
    where id = v_step_id
    returning * into v_step;
  end if;

  perform private.log_audit_event(
    v_template.organization_id, 'ONBOARDING_TEMPLATE_STEP_SAVED', 'onboarding_template', p_template_id, null,
    jsonb_build_object('step_id', v_step.id, 'title', v_step.title)
  );
  return v_step;
end;
$$;

revoke execute on function public.save_onboarding_template_step(uuid, uuid, text, text, text, text, text, integer, boolean, text, uuid[], uuid) from public, anon;
grant execute on function public.save_onboarding_template_step(uuid, uuid, text, text, text, text, text, integer, boolean, text, uuid[], uuid) to authenticated;

-- Invitation linking: identical to 20260910100000 except the fallback
-- hire date is the organization's today, not UTC's.
create or replace function public.link_invited_employee_account(
  p_employee_id uuid,
  p_user_id uuid,
  p_invited_by uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  v_setup public.employee_access_setup;
  v_role public.app_role;
  v_custom_role_id uuid;
  v_run public.onboarding_runs;
begin
  select * into v_employee
  from public.employees
  where id = p_employee_id
  for update;

  if v_employee.id is null then
    raise exception using errcode = 'P0002', message = 'Employee not found';
  end if;
  if v_employee.user_id is not null and v_employee.user_id <> p_user_id then
    raise exception using errcode = '23505', message = 'Employee already has a different account';
  end if;

  update public.employees
  set user_id = p_user_id,
      status = case when status = 'prehire' then 'active' else status end,
      hire_date = case when status = 'prehire' and hire_date is null then private.org_today(organization_id) else hire_date end
  where id = p_employee_id;

  select * into v_setup from public.employee_access_setup where employee_id = p_employee_id for update;

  v_custom_role_id := case
    when v_setup.pending_custom_role_id is not null and exists (
      select 1 from public.organization_roles r
      where r.id = v_setup.pending_custom_role_id and r.organization_id = v_employee.organization_id and r.is_active
    ) then v_setup.pending_custom_role_id
  end;
  v_role := case when v_custom_role_id is null then coalesce(v_setup.pending_role, 'employee') end;

  if not exists (
    select 1 from public.role_assignments
    where organization_id = v_employee.organization_id
      and user_id = p_user_id
      and scope_type = 'organization'
      and valid_from <= now()
      and (valid_until is null or valid_until > now())
  ) then
    insert into public.role_assignments (organization_id, user_id, role, custom_role_id, granted_by)
    values (v_employee.organization_id, p_user_id, v_role, v_custom_role_id, coalesce(v_setup.configured_by, p_invited_by));
  end if;

  if v_setup.employee_id is not null then
    update public.employee_access_setup set applied_at = now() where employee_id = p_employee_id;
  end if;

  if v_setup.onboarding_template_id is not null and not exists (
    select 1 from public.onboarding_runs where employee_id = p_employee_id and status = 'in_progress'
  ) then
    v_run := private.instantiate_onboarding_run(
      p_employee_id, v_setup.onboarding_template_id, coalesce(p_invited_by, v_setup.onboarding_selected_by)
    );
  end if;

  perform private.resolve_onboarding_assignees(p_employee_id);
  perform private.recompute_onboarding_due_dates(p_employee_id);

  perform private.log_audit_event(
    v_employee.organization_id, 'EMPLOYEE_INVITED', 'employee', v_employee.id,
    null, jsonb_build_object(
      'user_id', p_user_id, 'work_email', v_employee.work_email, 'invited_by', p_invited_by,
      'role', v_role, 'custom_role_id', v_custom_role_id, 'onboarding_run_id', v_run.id
    )
  );
end;
$$;

revoke execute on function public.link_invited_employee_account(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.link_invited_employee_account(uuid, uuid, uuid)
  to service_role;

-- Backfill: existing open employee/supervisor/manager tasks learn who
-- owns them (HR/IT tasks get an owner once one is set for the organization).
update public.onboarding_tasks t
set assignee_employee_id = private.onboarding_assignee_employee(e, t.assignee_type, null)
from public.employees e
where e.id = t.employee_id
  and t.assignee_employee_id is null
  and t.assignee_type in ('employee', 'supervisor', 'manager');

-- ---------------------------------------------------------------------------
-- 3. Whose onboarding is this task for?
-- ---------------------------------------------------------------------------

-- An IT person assigned "Prepare equipment" for a new hire can see the
-- task (RLS: assigned_to_user_id) but usually not the new hire's employee
-- record or run. This returns, for each run with a step assigned to the
-- caller, only that run's status and the onboardee's name and number —
-- nothing more.
create or replace function public.list_my_onboarding_subjects()
returns table (run_id uuid, run_status text, employee_id uuid, display_name text, employee_number text)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct r.id, r.status, e.id,
    coalesce(nullif(btrim(e.preferred_name), ''), e.first_name) || ' ' || e.last_name,
    e.employee_number
  from public.onboarding_tasks t
  join public.onboarding_runs r on r.id = t.run_id
  join public.employees e on e.id = t.employee_id
  where t.assigned_to_user_id = (select auth.uid());
$$;

revoke execute on function public.list_my_onboarding_subjects() from public, anon;
grant execute on function public.list_my_onboarding_subjects() to authenticated;
