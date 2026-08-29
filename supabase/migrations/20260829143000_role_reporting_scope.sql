-- Halomanage — connect role changes to explicit reporting scope.
--
-- A supervisor/manager role grants capabilities; it does not, by itself,
-- decide which employees are visible. This audited RPC lets an administrator
-- manage the selected leader's direct-report list without bypassing the
-- effective-dated employee_assignments history that powers RLS.

create or replace function public.set_employee_reporting_scope(
  p_leader_employee_id uuid,
  p_report_employee_ids uuid[],
  p_relationship text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_leader public.employees;
  v_report_id uuid;
  v_selected uuid[];
  v_current public.employee_assignments;
  v_updated public.employee_assignments;
  v_desired_leader uuid;
  v_valid_count integer;
  v_changed integer := 0;
begin
  if v_actor is null then
    raise exception using errcode = '42501', message = 'You must be signed in to manage reporting scope';
  end if;
  if p_relationship not in ('supervisor', 'manager') then
    raise exception using errcode = '22023', message = 'Relationship must be supervisor or manager';
  end if;

  select * into v_leader
  from public.employees
  where id = p_leader_employee_id
  for update;

  if v_leader.id is null then
    raise exception using errcode = 'P0002', message = 'Leader employee not found';
  end if;
  if not private.has_permission(v_leader.organization_id, 'employee.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to manage reporting lines for this organization';
  end if;
  if v_leader.user_id is null or v_leader.status = 'terminated' then
    raise exception using errcode = '23514', message = 'The selected leader must have an active employee account';
  end if;

  if p_relationship = 'manager' and not exists (
    select 1 from public.role_assignments ra
    where ra.organization_id = v_leader.organization_id
      and ra.user_id = v_leader.user_id
      and ra.role in ('manager', 'admin')
      and ra.valid_from <= now()
      and (ra.valid_until is null or ra.valid_until > now())
  ) then
    raise exception using errcode = '23514', message = 'Assign the Manager role before adding manager reports';
  end if;

  if p_relationship = 'supervisor' and not exists (
    select 1 from public.role_assignments ra
    where ra.organization_id = v_leader.organization_id
      and ra.user_id = v_leader.user_id
      and ra.role in ('supervisor', 'manager', 'admin')
      and ra.valid_from <= now()
      and (ra.valid_until is null or ra.valid_until > now())
  ) then
    raise exception using errcode = '23514', message = 'Assign the Supervisor or Manager role before adding supervisor reports';
  end if;

  select coalesce(array_agg(distinct report_id), '{}'::uuid[])
  into v_selected
  from unnest(coalesce(p_report_employee_ids, '{}'::uuid[])) as selected(report_id);

  if cardinality(v_selected) > 500 then
    raise exception using errcode = '22023', message = 'Reporting scope cannot contain more than 500 direct reports';
  end if;
  if p_leader_employee_id = any(v_selected) then
    raise exception using errcode = '23514', message = 'An employee cannot report to themselves';
  end if;

  select count(*) into v_valid_count
  from public.employees e
  where e.id = any(v_selected)
    and e.organization_id = v_leader.organization_id
    and e.status <> 'terminated';

  if v_valid_count <> cardinality(v_selected) then
    raise exception using errcode = '23514', message = 'Every selected report must be an active employee in the same organization';
  end if;
  if exists (
    select 1
    from public.employee_assignments leader_assignment
    where leader_assignment.employee_id = v_leader.id
      and leader_assignment.end_date is null
      and (
        leader_assignment.supervisor_employee_id = any(v_selected)
        or leader_assignment.manager_employee_id = any(v_selected)
      )
  ) then
    raise exception using errcode = '23514', message = 'This selection would create a circular reporting line';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_leader.organization_id::text, 81));

  -- Include both newly selected employees and employees who must be removed
  -- from this leader's current direct-report list.
  for v_report_id in
    select e.id
    from public.employees e
    where e.organization_id = v_leader.organization_id
      and e.id <> v_leader.id
      and (
        e.id = any(v_selected)
        or exists (
          select 1
          from public.employee_assignments ea
          where ea.employee_id = e.id
            and ea.end_date is null
            and (
              (p_relationship = 'supervisor' and ea.supervisor_employee_id = v_leader.id)
              or (p_relationship = 'manager' and ea.manager_employee_id = v_leader.id)
            )
        )
      )
    order by e.id
  loop
    v_desired_leader := case when v_report_id = any(v_selected) then v_leader.id else null end;

    select * into v_current
    from public.employee_assignments
    where employee_id = v_report_id and end_date is null
    for update;

    if v_current.id is null then
      insert into public.employee_assignments (
        organization_id, employee_id, supervisor_employee_id, manager_employee_id,
        start_date, change_reason, created_by
      ) values (
        v_leader.organization_id,
        v_report_id,
        case when p_relationship = 'supervisor' then v_desired_leader else null end,
        case when p_relationship = 'manager' then v_desired_leader else null end,
        current_date,
        'Reporting scope updated',
        v_actor
      )
      returning * into v_updated;
    elsif (
      (p_relationship = 'supervisor' and v_current.supervisor_employee_id is not distinct from v_desired_leader)
      or (p_relationship = 'manager' and v_current.manager_employee_id is not distinct from v_desired_leader)
    ) then
      continue;
    elsif v_current.start_date >= current_date then
      -- There is no earlier effective period to preserve when an assignment
      -- was created today (or staged for the future), so amend that row and
      -- keep its single audit trail instead of manufacturing a zero-day row.
      update public.employee_assignments
      set supervisor_employee_id = case when p_relationship = 'supervisor' then v_desired_leader else supervisor_employee_id end,
          manager_employee_id = case when p_relationship = 'manager' then v_desired_leader else manager_employee_id end,
          change_reason = 'Reporting scope updated',
          created_by = v_actor
      where id = v_current.id
      returning * into v_updated;
    else
      update public.employee_assignments
      set end_date = current_date - 1
      where id = v_current.id;

      insert into public.employee_assignments (
        organization_id, employee_id, org_unit_id, position_id, location_id,
        supervisor_employee_id, manager_employee_id, employment_type,
        start_date, is_primary, change_reason, created_by
      ) values (
        v_current.organization_id,
        v_current.employee_id,
        v_current.org_unit_id,
        v_current.position_id,
        v_current.location_id,
        case when p_relationship = 'supervisor' then v_desired_leader else v_current.supervisor_employee_id end,
        case when p_relationship = 'manager' then v_desired_leader else v_current.manager_employee_id end,
        v_current.employment_type,
        current_date,
        v_current.is_primary,
        'Reporting scope updated',
        v_actor
      )
      returning * into v_updated;
    end if;

    v_changed := v_changed + 1;
    perform private.log_audit_event(
      v_leader.organization_id,
      'EMPLOYEE_REPORTING_LINE_CHANGED',
      'employee_assignment',
      v_updated.id,
      case when v_current.id is null then null else to_jsonb(v_current) end,
      to_jsonb(v_updated)
    );
  end loop;

  perform private.log_audit_event(
    v_leader.organization_id,
    'REPORTING_SCOPE_UPDATED',
    'employee',
    v_leader.id,
    null,
    jsonb_build_object(
      'relationship', p_relationship,
      'direct_report_ids', to_jsonb(v_selected),
      'changed_assignments', v_changed
    )
  );

  return jsonb_build_object(
    'ok', true,
    'relationship', p_relationship,
    'direct_report_count', cardinality(v_selected),
    'changed_assignments', v_changed
  );
end;
$$;

revoke all on function public.set_employee_reporting_scope(uuid, uuid[], text) from public, anon;
grant execute on function public.set_employee_reporting_scope(uuid, uuid[], text) to authenticated;
