-- Halomanage — atomic employee assignment changes (promotions/transfers)
-- Ref: ARCHITECTURE.md "Use effective-dated records"; PRODUCT_BLUEPRINT.md
-- automation example ("Manager changes employee position → ... → Change
-- recorded in audit history").
--
-- Direct RLS already permits an employee.manage holder to INSERT/UPDATE
-- employee_assignments, but doing "close the current open row, then open a
-- new one" as two separate client calls isn't atomic and skips the audit
-- trail. This RPC does both in one transaction and logs it, matching the
-- pattern used everywhere else in this schema for multi-step writes.

create or replace function public.change_employee_assignment(
  p_employee_id uuid,
  p_org_unit_id uuid,
  p_position_id uuid,
  p_location_id uuid,
  p_supervisor_employee_id uuid,
  p_manager_employee_id uuid,
  p_employment_type text,
  p_start_date date default current_date,
  p_change_reason text default null
)
returns public.employee_assignments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  v_current public.employee_assignments;
  v_new public.employee_assignments;
begin
  select * into v_employee from public.employees where id = p_employee_id;
  if v_employee.id is null then
    raise exception 'Employee not found';
  end if;
  if not private.has_permission(v_employee.organization_id, 'employee.manage') then
    raise exception 'Not authorized to change this employee''s assignment';
  end if;

  select * into v_current from public.employee_assignments
  where employee_id = p_employee_id and end_date is null
  for update;

  if v_current.id is not null then
    if p_start_date <= v_current.start_date then
      raise exception 'New assignment start_date must be after the current assignment''s start_date (%)', v_current.start_date;
    end if;
    update public.employee_assignments set end_date = p_start_date - 1 where id = v_current.id;
  end if;

  insert into public.employee_assignments (
    organization_id, employee_id, org_unit_id, position_id, location_id,
    supervisor_employee_id, manager_employee_id, employment_type,
    start_date, change_reason, created_by
  )
  values (
    v_employee.organization_id, p_employee_id, p_org_unit_id, p_position_id, p_location_id,
    p_supervisor_employee_id, p_manager_employee_id, p_employment_type,
    p_start_date, p_change_reason, auth.uid()
  )
  returning * into v_new;

  perform private.log_audit_event(
    v_employee.organization_id, 'EMPLOYEE_ASSIGNMENT_CHANGED', 'employee_assignment', v_new.id,
    to_jsonb(v_current), to_jsonb(v_new)
  );

  return v_new;
end;
$$;

revoke execute on function public.change_employee_assignment(uuid, uuid, uuid, uuid, uuid, uuid, text, date, text) from public;
grant execute on function public.change_employee_assignment(uuid, uuid, uuid, uuid, uuid, uuid, text, date, text) to authenticated;
