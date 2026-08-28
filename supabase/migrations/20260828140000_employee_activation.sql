-- Halomanage — employee activation
--
-- Every employee is created as 'prehire' (see NewEmployeeForm) and had no
-- documented path out of it: link_invited_employee_account() connected the
-- account and granted the baseline role but never touched status, and no
-- RPC or UI let an admin flip it either. The record was correct — the
-- person really hadn't started — but nothing ever moved them to 'active'.
--
-- Two paths forward:
--   1. The common case — accepting the invite is treated as "day one" and
--      auto-activates the employee.
--   2. activate_employee() covers everyone else: employees who won't use
--      the portal, or who need activating before they accept an invite.

create or replace function public.link_invited_employee_account(
  p_employee_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
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
      hire_date = case when status = 'prehire' and hire_date is null then current_date else hire_date end
  where id = p_employee_id;

  if not exists (
    select 1 from public.role_assignments
    where organization_id = v_employee.organization_id
      and user_id = p_user_id
      and role = 'employee'
      and scope_type = 'organization'
      and valid_until is null
  ) then
    insert into public.role_assignments (organization_id, user_id, role)
    values (v_employee.organization_id, p_user_id, 'employee');
  end if;

  perform private.log_audit_event(
    v_employee.organization_id, 'EMPLOYEE_INVITED', 'employee', v_employee.id,
    null, jsonb_build_object('user_id', p_user_id, 'work_email', v_employee.work_email)
  );
end;
$$;

revoke execute on function public.link_invited_employee_account(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.link_invited_employee_account(uuid, uuid)
  to service_role;

create or replace function public.activate_employee(
  p_employee_id uuid,
  p_hire_date date default current_date
)
returns public.employees
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
begin
  select * into v_employee
  from public.employees
  where id = p_employee_id
  for update;

  if v_employee.id is null then
    raise exception 'Employee not found';
  end if;
  if not private.has_permission(v_employee.organization_id, 'employee.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to manage this organization''s employees';
  end if;
  if v_employee.status = 'terminated' then
    raise exception using errcode = '23514', message = 'A terminated employee cannot be reactivated this way';
  end if;
  if v_employee.status = 'active' then
    raise exception using errcode = '23514', message = 'Employee is already active';
  end if;

  update public.employees
  set status = 'active',
      hire_date = coalesce(hire_date, p_hire_date)
  where id = p_employee_id
  returning * into v_employee;

  perform private.log_audit_event(
    v_employee.organization_id, 'EMPLOYEE_ACTIVATED', 'employee', v_employee.id,
    null, jsonb_build_object('status', 'active', 'hire_date', v_employee.hire_date)
  );
  return v_employee;
end;
$$;

revoke all on function public.activate_employee(uuid, date) from public, anon;
grant execute on function public.activate_employee(uuid, date) to authenticated;
