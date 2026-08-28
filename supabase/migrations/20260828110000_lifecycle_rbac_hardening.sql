-- Halomanage — lifecycle and RBAC hardening
--
-- Forward-only corrections for employee lifecycle authorization. Sensitive
-- writes are exposed through narrow, audited RPCs; role_assignments remains
-- directly readable under RLS but is no longer directly writable by an
-- authenticated Data API client.

-- A login is only an active employee identity while the employee is not
-- terminated and still has at least one currently-valid organization role.
-- This helper is used by self-service RLS policies throughout the schema.
create or replace function private.current_employee_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.id
  from public.employees e
  where e.user_id = (select auth.uid())
    and e.status <> 'terminated'
    and exists (
      select 1
      from public.role_assignments ra
      where ra.organization_id = e.organization_id
        and ra.user_id = e.user_id
        and ra.valid_from <= now()
        and (ra.valid_until is null or ra.valid_until > now())
    )
  limit 1;
$$;

-- Employees may change only the documented self-service fields. Identity,
-- employment, account-linkage and creation facts remain HR controlled even
-- if a client calls the Data API directly instead of using the profile form.
create or replace function private.enforce_employee_protected_columns()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or private.has_permission(new.organization_id, 'employee.manage') then
    return new;
  end if;

  if new.organization_id is distinct from old.organization_id
    or new.user_id is distinct from old.user_id
    or new.employee_number is distinct from old.employee_number
    or new.external_payroll_id is distinct from old.external_payroll_id
    or new.first_name is distinct from old.first_name
    or new.last_name is distinct from old.last_name
    or new.work_email is distinct from old.work_email
    or new.status is distinct from old.status
    or new.hire_date is distinct from old.hire_date
    or new.probation_end_date is distinct from old.probation_end_date
    or new.termination_date is distinct from old.termination_date
    or new.termination_reason is distinct from old.termination_reason
    or new.created_at is distinct from old.created_at
  then
    raise exception using errcode = '42501', message = 'Only an HR administrator can change identity or employment fields';
  end if;

  return new;
end;
$$;

-- NULL assignees represent HR/system-owned tasks. `NULL != auth.uid()` is
-- not true in SQL, so the previous checks accidentally let any authenticated
-- caller complete such a task. IS DISTINCT FROM is deliberately null-safe.
create or replace function public.complete_onboarding_task(
  p_task_id uuid,
  p_completion_data jsonb default null
)
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
  select * into v_task
  from public.onboarding_tasks
  where id = p_task_id
  for update;

  if v_task.id is null then
    raise exception 'Onboarding task not found';
  end if;
  if v_task.status = 'completed' then
    return v_task;
  end if;

  if v_task.assigned_to_user_id is distinct from (select auth.uid())
     and not private.has_permission(v_task.organization_id, 'onboarding.manage_team')
  then
    raise exception using errcode = '42501', message = 'Not authorized to complete this task';
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
  set status = 'completed',
      completed_at = now(),
      completed_by = auth.uid(),
      completion_data = p_completion_data,
      signed_at = case when v_task.requires_signature then now() else signed_at end
  where id = p_task_id
  returning * into v_task;

  select count(*) into v_remaining
  from public.onboarding_tasks
  where run_id = v_task.run_id and required and status != 'completed';

  if v_remaining = 0 then
    update public.onboarding_runs
    set status = 'completed', completed_at = now()
    where id = v_task.run_id;
  end if;

  perform private.log_audit_event(
    v_task.organization_id, 'ONBOARDING_TASK_COMPLETED', 'onboarding_task',
    v_task.id, null, to_jsonb(v_task)
  );
  return v_task;
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
  select * into v_task
  from public.offboarding_tasks
  where id = p_task_id
  for update;

  if v_task.id is null then
    raise exception 'Offboarding task not found';
  end if;
  if v_task.status = 'completed' then
    return v_task;
  end if;

  if v_task.assigned_to_user_id is distinct from (select auth.uid())
     and not private.has_permission(v_task.organization_id, 'employee.manage')
  then
    raise exception using errcode = '42501', message = 'Not authorized to complete this task';
  end if;

  update public.offboarding_tasks
  set status = 'completed', completed_at = now(), completed_by = auth.uid()
  where id = p_task_id
  returning * into v_task;

  select count(*) into v_remaining
  from public.offboarding_tasks
  where run_id = v_task.run_id and required and status != 'completed';

  if v_remaining = 0 then
    update public.offboarding_runs
    set status = 'completed', completed_at = now()
    where id = v_task.run_id;
  end if;

  perform private.log_audit_event(
    v_task.organization_id, 'OFFBOARDING_TASK_COMPLETED', 'offboarding_task',
    v_task.id, null, to_jsonb(v_task)
  );
  return v_task;
end;
$$;

-- Direct role writes bypass the invariants below. Keep RLS-scoped reads for
-- the current member and roles.manage holders, but route every mutation
-- through set_member_role().
drop policy if exists "admins manage role assignments" on public.role_assignments;
drop policy if exists "role managers read role assignments" on public.role_assignments;
create policy "role managers read role assignments"
  on public.role_assignments for select to authenticated
  using (private.has_permission(organization_id, 'roles.manage'));

revoke insert, update, delete on table public.role_assignments from authenticated;
grant select on table public.role_assignments to authenticated;

create or replace function public.set_member_role(
  p_employee_id uuid,
  p_role public.app_role,
  p_valid_until timestamptz default null
)
returns public.role_assignments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_now timestamptz := clock_timestamp();
  v_employee public.employees;
  v_assignment public.role_assignments;
  v_old_roles jsonb;
  v_target_is_admin boolean;
  v_other_admin_exists boolean;
begin
  if v_actor is null then
    raise exception using errcode = '42501', message = 'You must be signed in to manage roles';
  end if;

  select * into v_employee
  from public.employees
  where id = p_employee_id
  for update;

  if v_employee.id is null then
    raise exception 'Employee not found';
  end if;
  if not private.has_permission(v_employee.organization_id, 'roles.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to manage roles for this organization';
  end if;
  if v_employee.user_id is null then
    raise exception using errcode = '23514', message = 'The employee must have a linked account before a role can be assigned';
  end if;
  if v_employee.status = 'terminated' then
    raise exception using errcode = '23514', message = 'A terminated employee cannot receive an active role';
  end if;
  if p_valid_until is not null and p_valid_until <= v_now then
    raise exception using errcode = '22023', message = 'Role expiry must be in the future';
  end if;
  if exists (
    select 1 from public.role_assignments ra
    where ra.user_id = v_employee.user_id
      and ra.organization_id <> v_employee.organization_id
      and ra.valid_from <= v_now
      and (ra.valid_until is null or ra.valid_until > v_now)
  ) then
    raise exception using errcode = '23514', message = 'The linked account has an active role in another organization';
  end if;

  -- Serialize role replacement and last-admin checks per organization.
  perform pg_advisory_xact_lock(hashtextextended(v_employee.organization_id::text, 73));

  select exists (
    select 1 from public.role_assignments ra
    where ra.organization_id = v_employee.organization_id
      and ra.user_id = v_employee.user_id
      and ra.role = 'admin'
      and ra.valid_from <= v_now
      and (ra.valid_until is null or ra.valid_until > v_now)
  ) into v_target_is_admin;

  if v_target_is_admin and (p_role <> 'admin' or p_valid_until is not null) then
    select exists (
      select 1
      from public.role_assignments ra
      join public.employees e
        on e.organization_id = ra.organization_id and e.user_id = ra.user_id
      where ra.organization_id = v_employee.organization_id
        and ra.user_id <> v_employee.user_id
        and ra.role = 'admin'
        and ra.valid_from <= v_now
        and (ra.valid_until is null or ra.valid_until > v_now)
        and e.status <> 'terminated'
    ) into v_other_admin_exists;

    if not v_other_admin_exists then
      raise exception using errcode = '23514', message = 'The last active administrator cannot be demoted or scheduled to expire';
    end if;
  end if;

  select coalesce(jsonb_agg(to_jsonb(ra) order by ra.created_at), '[]'::jsonb)
  into v_old_roles
  from public.role_assignments ra
  where ra.organization_id = v_employee.organization_id
    and ra.user_id = v_employee.user_id
    and (ra.valid_until is null or ra.valid_until > v_now);

  update public.role_assignments
  set valid_until = v_now
  where organization_id = v_employee.organization_id
    and user_id = v_employee.user_id
    and valid_from <= v_now
    and (valid_until is null or valid_until > v_now);

  -- A future scheduled grant must not reactivate after this replacement.
  delete from public.role_assignments
  where organization_id = v_employee.organization_id
    and user_id = v_employee.user_id
    and valid_from > v_now;

  insert into public.role_assignments (
    organization_id, user_id, role, scope_type, scope_id,
    valid_from, valid_until, granted_by
  ) values (
    v_employee.organization_id, v_employee.user_id, p_role,
    'organization', null, v_now, p_valid_until, v_actor
  )
  returning * into v_assignment;

  perform private.log_audit_event(
    v_employee.organization_id, 'MEMBER_ROLE_CHANGED', 'employee', v_employee.id,
    jsonb_build_object('roles', v_old_roles),
    jsonb_build_object('role_assignment', to_jsonb(v_assignment))
  );
  return v_assignment;
end;
$$;

revoke execute on function public.set_member_role(uuid, public.app_role, timestamptz) from public, anon;
grant execute on function public.set_member_role(uuid, public.app_role, timestamptz) to authenticated;

create or replace function public.terminate_employee(
  p_employee_id uuid,
  p_termination_date date default current_date,
  p_reason text default null
)
returns public.employees
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_now timestamptz := clock_timestamp();
  v_employee public.employees;
  v_old_employee public.employees;
  v_other_admin_exists boolean;
  v_target_is_admin boolean;
  v_assignments_closed integer := 0;
  v_roles_expired integer := 0;
  v_future_roles_cancelled integer := 0;
  v_onboarding_cancelled integer := 0;
  v_appraisals_cancelled integer := 0;
begin
  if v_actor is null then
    raise exception using errcode = '42501', message = 'You must be signed in to terminate an employee';
  end if;

  select * into v_employee
  from public.employees
  where id = p_employee_id
  for update;

  if v_employee.id is null then
    raise exception 'Employee not found';
  end if;
  if not private.has_permission(v_employee.organization_id, 'employee.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to terminate this employee';
  end if;
  if v_employee.user_id = v_actor then
    raise exception using errcode = '23514', message = 'You cannot terminate your own employee account';
  end if;
  if v_employee.status = 'terminated' then
    raise exception using errcode = '23514', message = 'Employee is already terminated';
  end if;
  if p_termination_date is null or p_termination_date > current_date then
    raise exception using errcode = '22023', message = 'Termination date must be today or earlier';
  end if;
  if v_employee.hire_date is not null and p_termination_date < v_employee.hire_date then
    raise exception using errcode = '22023', message = 'Termination date cannot be before the hire date';
  end if;
  if exists (
    select 1 from public.employee_assignments ea
    where ea.employee_id = v_employee.id
      and ea.end_date is null
      and ea.start_date > p_termination_date
  ) then
    raise exception using errcode = '22023', message = 'Termination date cannot be before the current assignment start date';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_employee.organization_id::text, 73));

  select exists (
    select 1 from public.role_assignments ra
    where ra.organization_id = v_employee.organization_id
      and ra.user_id = v_employee.user_id
      and ra.role = 'admin'
      and ra.valid_from <= v_now
      and (ra.valid_until is null or ra.valid_until > v_now)
  ) into v_target_is_admin;

  if v_target_is_admin then
    select exists (
      select 1
      from public.role_assignments ra
      join public.employees e
        on e.organization_id = ra.organization_id and e.user_id = ra.user_id
      where ra.organization_id = v_employee.organization_id
        and ra.user_id <> v_employee.user_id
        and ra.role = 'admin'
        and ra.valid_from <= v_now
        and (ra.valid_until is null or ra.valid_until > v_now)
        and e.status <> 'terminated'
    ) into v_other_admin_exists;

    if not v_other_admin_exists then
      raise exception using errcode = '23514', message = 'The last active administrator cannot be terminated';
    end if;
  end if;

  v_old_employee := v_employee;

  update public.employees
  set status = 'terminated',
      termination_date = p_termination_date,
      termination_reason = nullif(btrim(p_reason), '')
  where id = v_employee.id
  returning * into v_employee;

  -- Updating status launches the default offboarding template through the
  -- existing employees_auto_offboarding trigger. Keep any already-open run
  -- aligned with the recorded final work date.
  update public.offboarding_runs
  set final_work_date = p_termination_date
  where employee_id = v_employee.id and status = 'in_progress';

  update public.employee_assignments
  set end_date = p_termination_date
  where employee_id = v_employee.id and end_date is null;
  get diagnostics v_assignments_closed = row_count;

  update public.role_assignments
  set valid_until = v_now
  where organization_id = v_employee.organization_id
    and user_id = v_employee.user_id
    and valid_from <= v_now
    and (valid_until is null or valid_until > v_now);
  get diagnostics v_roles_expired = row_count;

  delete from public.role_assignments
  where organization_id = v_employee.organization_id
    and user_id = v_employee.user_id
    and valid_from > v_now;
  get diagnostics v_future_roles_cancelled = row_count;

  update public.onboarding_tasks
  set status = 'skipped',
      completed_at = v_now,
      completed_by = v_actor,
      completion_data = coalesce(completion_data, '{}'::jsonb)
        || jsonb_build_object('skipped_reason', 'employee_terminated')
  where employee_id = v_employee.id
    and status in ('pending', 'in_progress', 'blocked')
    and run_id in (
      select id from public.onboarding_runs
      where employee_id = v_employee.id and status = 'in_progress'
    );

  update public.onboarding_runs
  set status = 'cancelled', completed_at = v_now
  where employee_id = v_employee.id and status = 'in_progress';
  get diagnostics v_onboarding_cancelled = row_count;

  update public.appraisal_reviewers
  set status = 'skipped'
  where status = 'pending'
    and instance_id in (
      select id from public.appraisal_instances
      where employee_id = v_employee.id
        and status not in ('complete', 'cancelled')
    );

  update public.appraisal_instances
  set status = 'cancelled'
  where employee_id = v_employee.id
    and status not in ('complete', 'cancelled');
  get diagnostics v_appraisals_cancelled = row_count;

  perform private.log_audit_event(
    v_employee.organization_id, 'EMPLOYEE_TERMINATED', 'employee', v_employee.id,
    to_jsonb(v_old_employee),
    to_jsonb(v_employee) || jsonb_build_object(
      'assignments_closed', v_assignments_closed,
      'active_roles_expired', v_roles_expired,
      'future_roles_cancelled', v_future_roles_cancelled,
      'onboarding_runs_cancelled', v_onboarding_cancelled,
      'appraisal_instances_cancelled', v_appraisals_cancelled
    )
  );
  return v_employee;
end;
$$;

revoke execute on function public.terminate_employee(uuid, date, text) from public, anon;
grant execute on function public.terminate_employee(uuid, date, text) to authenticated;

-- Never interpret deliberate offboarding as a recoverable partial signup.
create or replace function public.repair_current_workspace(
  p_first_name text default null,
  p_last_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_employee public.employees;
  v_role public.role_assignments;
  v_email text;
  v_first_name text;
  v_last_name text;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'You must be signed in to repair a workspace';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 2));
  select * into v_employee
  from public.employees
  where user_id = v_user_id
  limit 1;

  if v_employee.id is not null and v_employee.status = 'terminated' then
    raise exception using errcode = '42501', message = 'A terminated employee account cannot repair or restore workspace access';
  end if;

  select * into v_role
  from public.role_assignments
  where user_id = v_user_id
    and valid_from <= now()
    and (valid_until is null or valid_until > now())
  order by case role when 'admin' then 1 when 'manager' then 2 when 'supervisor' then 3 else 4 end
  limit 1;

  if v_employee.id is null and v_role.id is null then
    return jsonb_build_object('repaired', false, 'reason', 'no_partial_membership');
  end if;
  if v_employee.id is not null and v_role.id is not null
     and v_employee.organization_id <> v_role.organization_id then
    raise exception using errcode = '23514', message = 'Employee and role organization do not match';
  end if;

  if v_employee.id is not null and v_role.id is null then
    insert into public.role_assignments (organization_id, user_id, role)
    values (v_employee.organization_id, v_user_id, 'employee')
    returning * into v_role;
  elsif v_employee.id is null and v_role.id is not null then
    select u.email,
      coalesce(nullif(btrim(p_first_name), ''), nullif(btrim(u.raw_user_meta_data->>'first_name'), ''), 'Team'),
      coalesce(nullif(btrim(p_last_name), ''), nullif(btrim(u.raw_user_meta_data->>'last_name'), ''), 'Member')
    into v_email, v_first_name, v_last_name
    from auth.users u
    where u.id = v_user_id;

    insert into public.employees (
      organization_id, user_id, employee_number, first_name, last_name,
      work_email, status, hire_date
    ) values (
      v_role.organization_id, v_user_id,
      'EMP-' || upper(left(replace(gen_random_uuid()::text, '-', ''), 8)),
      left(v_first_name, 80), left(v_last_name, 80), v_email, 'active', current_date
    ) returning * into v_employee;
  end if;

  if v_role.role = 'admin' then
    perform private.seed_organization_starter_workspace(
      v_employee.organization_id, v_employee.id, v_user_id
    );
  end if;

  perform private.log_audit_event(
    v_employee.organization_id, 'WORKSPACE_MEMBERSHIP_REPAIRED', 'employee',
    v_employee.id, null, jsonb_build_object('role', v_role.role)
  );
  return jsonb_build_object('repaired', true, 'organization_id', v_employee.organization_id);
end;
$$;

revoke execute on function public.repair_current_workspace(text, text) from public, anon;
grant execute on function public.repair_current_workspace(text, text) to authenticated;

