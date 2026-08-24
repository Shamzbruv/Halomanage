-- Organization-specific employee portals and useful starter workspaces.
--
-- A newly-created tenant should be ready to explore immediately. This
-- migration keeps employer configuration editable, but creates a sensible
-- baseline only when a category has no data yet. It also exposes one narrow,
-- intentionally public lookup for branded employee sign-in pages; no private
-- organization settings or membership data are returned.

create or replace function private.seed_organization_starter_workspace(
  p_organization_id uuid,
  p_owner_employee_id uuid,
  p_created_by uuid
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_org_unit_id uuid;
  v_location_id uuid;
  v_position_id uuid;
  v_schedule_id uuid;
  v_vacation_type_id uuid;
  v_sick_type_id uuid;
  v_unpaid_type_id uuid;
  v_policy_id uuid;
  v_onboarding_template_id uuid;
  v_onboarding_version_id uuid;
  v_first_step_id uuid;
  v_second_step_id uuid;
  v_appraisal_template_id uuid;
  v_appraisal_section_id uuid;
  v_training_course_id uuid;
begin
  if not exists (
    select 1 from public.employees e
    where e.id = p_owner_employee_id
      and e.organization_id = p_organization_id
      and e.user_id = p_created_by
  ) then
    raise exception using errcode = '42501', message = 'Starter workspace owner does not match the organization';
  end if;

  select ou.id into v_org_unit_id
  from public.org_units ou
  where ou.organization_id = p_organization_id and ou.code = 'GENERAL'
  limit 1;

  if v_org_unit_id is null then
    insert into public.org_units (organization_id, name, type, code)
    values (p_organization_id, 'General', 'department', 'GENERAL')
    returning id into v_org_unit_id;
  end if;

  select l.id into v_location_id
  from public.locations l
  where l.organization_id = p_organization_id and lower(l.name) = 'main office'
  limit 1;

  if v_location_id is null then
    insert into public.locations (organization_id, name, country_code, timezone)
    select p_organization_id, 'Main office', o.country_code, o.timezone
    from public.organizations o where o.id = p_organization_id
    returning id into v_location_id;
  end if;

  select p.id into v_position_id
  from public.positions p
  where p.organization_id = p_organization_id and p.job_code = 'ORG-ADMIN'
  limit 1;

  if v_position_id is null then
    insert into public.positions (organization_id, title, job_code, description)
    values (p_organization_id, 'Organization Administrator', 'ORG-ADMIN', 'Workspace owner and people operations administrator')
    returning id into v_position_id;
  end if;

  if not exists (
    select 1 from public.employee_assignments ea
    where ea.employee_id = p_owner_employee_id and ea.end_date is null
  ) then
    insert into public.employee_assignments (
      organization_id, employee_id, org_unit_id, position_id, location_id,
      employment_type, start_date, change_reason, created_by
    ) values (
      p_organization_id, p_owner_employee_id, v_org_unit_id, v_position_id,
      v_location_id, 'full_time', current_date, 'Initial workspace setup', p_created_by
    );
  end if;

  select ws.id into v_schedule_id
  from public.work_schedules ws
  where ws.organization_id = p_organization_id and lower(ws.name) = 'standard work week'
  limit 1;

  if v_schedule_id is null then
    insert into public.work_schedules (organization_id, name, description)
    values (p_organization_id, 'Standard work week', 'Monday to Friday, 9:00 AM to 5:00 PM')
    returning id into v_schedule_id;

    insert into public.schedule_shifts (schedule_id, day_of_week, start_time, end_time, break_minutes)
    select v_schedule_id, day_number, time '09:00', time '17:00', 60
    from generate_series(1, 5) as day_number;
  end if;

  if not exists (
    select 1 from public.schedule_assignments sa
    where sa.employee_id = p_owner_employee_id and sa.end_date is null
  ) then
    insert into public.schedule_assignments (organization_id, employee_id, schedule_id, start_date)
    values (p_organization_id, p_owner_employee_id, v_schedule_id, current_date);
  end if;

  if not exists (
    select 1 from public.attendance_policies ap where ap.organization_id = p_organization_id
  ) then
    insert into public.attendance_policies (
      organization_id, name, is_default, grace_period_minutes, rounding_minutes,
      overtime_requires_approval, allow_mobile_clock
    ) values (p_organization_id, 'Standard attendance', true, 10, 0, true, true);
  end if;

  insert into public.leave_types (
    organization_id, name, code, color, is_paid, balance_tracked,
    allow_half_day, minimum_notice_days
  ) values (p_organization_id, 'Vacation leave', 'VACATION', '#64a78f', true, true, true, 5)
  on conflict (organization_id, code) do nothing;
  select id into v_vacation_type_id from public.leave_types where organization_id = p_organization_id and code = 'VACATION';

  insert into public.leave_types (
    organization_id, name, code, color, is_paid, balance_tracked,
    allow_half_day, requires_attachment, attachment_after_days
  ) values (p_organization_id, 'Sick leave', 'SICK', '#f2c866', true, true, true, false, 3)
  on conflict (organization_id, code) do nothing;
  select id into v_sick_type_id from public.leave_types where organization_id = p_organization_id and code = 'SICK';

  insert into public.leave_types (
    organization_id, name, code, color, is_paid, balance_tracked,
    allow_half_day, allow_negative_balance
  ) values (p_organization_id, 'Unpaid leave', 'UNPAID', '#ef8d79', false, false, true, true)
  on conflict (organization_id, code) do nothing;
  select id into v_unpaid_type_id from public.leave_types where organization_id = p_organization_id and code = 'UNPAID';

  if not exists (select 1 from public.leave_policies where organization_id = p_organization_id and leave_type_id = v_vacation_type_id and is_default) then
    insert into public.leave_policies (
      organization_id, leave_type_id, name, accrual_method, accrual_amount,
      carryover_max, is_default
    ) values (p_organization_id, v_vacation_type_id, 'Standard vacation', 'annual_grant', 15, 5, true)
    returning id into v_policy_id;
  else
    select id into v_policy_id from public.leave_policies
    where organization_id = p_organization_id and leave_type_id = v_vacation_type_id and is_default limit 1;
  end if;
  if not exists (select 1 from public.leave_policy_assignments where employee_id = p_owner_employee_id and leave_policy_id = v_policy_id and end_date is null) then
    insert into public.leave_policy_assignments (organization_id, employee_id, leave_policy_id)
    values (p_organization_id, p_owner_employee_id, v_policy_id);
  end if;
  if not exists (select 1 from public.leave_ledger where employee_id = p_owner_employee_id and leave_type_id = v_vacation_type_id and entry_type = 'grant') then
    insert into public.leave_ledger (organization_id, employee_id, leave_type_id, entry_type, amount, note, created_by)
    values (p_organization_id, p_owner_employee_id, v_vacation_type_id, 'grant', 15, 'Starter annual entitlement', p_created_by);
  end if;

  v_policy_id := null;
  if not exists (select 1 from public.leave_policies where organization_id = p_organization_id and leave_type_id = v_sick_type_id and is_default) then
    insert into public.leave_policies (
      organization_id, leave_type_id, name, accrual_method, accrual_amount,
      carryover_max, is_default
    ) values (p_organization_id, v_sick_type_id, 'Standard sick leave', 'annual_grant', 10, 0, true)
    returning id into v_policy_id;
  else
    select id into v_policy_id from public.leave_policies
    where organization_id = p_organization_id and leave_type_id = v_sick_type_id and is_default limit 1;
  end if;
  if not exists (select 1 from public.leave_policy_assignments where employee_id = p_owner_employee_id and leave_policy_id = v_policy_id and end_date is null) then
    insert into public.leave_policy_assignments (organization_id, employee_id, leave_policy_id)
    values (p_organization_id, p_owner_employee_id, v_policy_id);
  end if;
  if not exists (select 1 from public.leave_ledger where employee_id = p_owner_employee_id and leave_type_id = v_sick_type_id and entry_type = 'grant') then
    insert into public.leave_ledger (organization_id, employee_id, leave_type_id, entry_type, amount, note, created_by)
    values (p_organization_id, p_owner_employee_id, v_sick_type_id, 'grant', 10, 'Starter annual entitlement', p_created_by);
  end if;

  v_policy_id := null;
  if not exists (select 1 from public.leave_policies where organization_id = p_organization_id and leave_type_id = v_unpaid_type_id and is_default) then
    insert into public.leave_policies (
      organization_id, leave_type_id, name, accrual_method, accrual_amount,
      carryover_max, is_default
    ) values (p_organization_id, v_unpaid_type_id, 'Standard unpaid leave', 'none', 0, 0, true)
    returning id into v_policy_id;
  else
    select id into v_policy_id from public.leave_policies
    where organization_id = p_organization_id and leave_type_id = v_unpaid_type_id and is_default limit 1;
  end if;
  if not exists (select 1 from public.leave_policy_assignments where employee_id = p_owner_employee_id and leave_policy_id = v_policy_id and end_date is null) then
    insert into public.leave_policy_assignments (organization_id, employee_id, leave_policy_id)
    values (p_organization_id, p_owner_employee_id, v_policy_id);
  end if;

  if not exists (select 1 from public.onboarding_templates where organization_id = p_organization_id) then
    insert into public.onboarding_templates (
      organization_id, name, description, is_default, created_by
    ) values (
      p_organization_id, 'New employee essentials',
      'A practical starting workflow for every new team member.', true, p_created_by
    ) returning id into v_onboarding_template_id;

    insert into public.onboarding_template_versions (template_id, version_number, is_current, created_by)
    values (v_onboarding_template_id, 1, true, p_created_by)
    returning id into v_onboarding_version_id;

    insert into public.onboarding_template_steps (
      template_version_id, title, description, step_type, assignee_type,
      sequence, due_offset_days
    ) values (
      v_onboarding_version_id, 'Complete your employee profile',
      'Add your contact and emergency information so HR can support you.',
      'form', 'employee', 1, 0
    ) returning id into v_first_step_id;

    insert into public.onboarding_template_steps (
      template_version_id, title, description, step_type, assignee_type,
      sequence, due_offset_days, dependency_step_ids
    ) values (
      v_onboarding_version_id, 'Review workplace policies',
      'Read the policies shared in your document hub and raise any questions.',
      'acknowledgement', 'employee', 2, 1, array[v_first_step_id]
    ) returning id into v_second_step_id;

    insert into public.onboarding_template_steps (
      template_version_id, title, description, step_type, assignee_type,
      sequence, due_offset_days, dependency_step_ids
    ) values (
      v_onboarding_version_id, 'Meet your manager',
      'Discuss priorities, working agreements, and what success looks like.',
      'meeting', 'supervisor', 3, 3, array[v_second_step_id]
    );
  end if;

  if not exists (select 1 from public.appraisal_templates where organization_id = p_organization_id) then
    insert into public.appraisal_templates (organization_id, name, description, rating_scale)
    values (
      p_organization_id,
      'Quarterly growth conversation',
      'A balanced check-in covering progress, support, and next-quarter priorities.',
      '[{"value":1,"label":"Needs support"},{"value":2,"label":"Developing"},{"value":3,"label":"On track"},{"value":4,"label":"Strong"},{"value":5,"label":"Exceptional"}]'::jsonb
    ) returning id into v_appraisal_template_id;

    insert into public.appraisal_sections (template_id, title, sequence)
    values (v_appraisal_template_id, 'Progress and growth', 1)
    returning id into v_appraisal_section_id;

    insert into public.appraisal_questions (section_id, prompt, question_type, weight, sequence)
    values
      (v_appraisal_section_id, 'What progress are you most proud of this period?', 'text', 1, 1),
      (v_appraisal_section_id, 'How would you rate progress against current expectations?', 'rating_scale', 1, 2),
      (v_appraisal_section_id, 'What support or development would help next?', 'text', 1, 3),
      (v_appraisal_section_id, 'What are the most important priorities for the next period?', 'goal', 1, 4);
  end if;

  if not exists (select 1 from public.training_courses where organization_id = p_organization_id) then
    insert into public.training_courses (organization_id, name, description, is_required)
    values (
      p_organization_id, 'Workplace orientation',
      'An editable starter course for policies, safety, systems, and team expectations.', true
    ) returning id into v_training_course_id;
  else
    select id into v_training_course_id
    from public.training_courses
    where organization_id = p_organization_id and is_active
    order by is_required desc, created_at
    limit 1;
  end if;

  if v_training_course_id is not null and not exists (
    select 1 from public.employee_training
    where employee_id = p_owner_employee_id and course_id = v_training_course_id
  ) then
    insert into public.employee_training (organization_id, employee_id, course_id)
    values (p_organization_id, p_owner_employee_id, v_training_course_id);
  end if;

  update public.organizations
  set settings = settings || jsonb_build_object(
    'portal_enabled', true,
    'portal_title', 'Welcome to ' || name,
    'portal_message', 'Sign in to manage your workday, time away, documents, and development.',
    'starter_workspace_initialized_at', coalesce(settings->'starter_workspace_initialized_at', to_jsonb(now()))
  )
  where id = p_organization_id;
end;
$$;

revoke execute on function private.seed_organization_starter_workspace(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.create_organization_workspace(
  p_organization_name text,
  p_slug text,
  p_first_name text,
  p_last_name text,
  p_timezone text default 'UTC',
  p_country_code text default null
)
returns public.organizations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_email text;
  v_org public.organizations;
  v_employee public.employees;
  v_slug text;
  v_base_slug text;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'You must be signed in to create an organization';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));

  if exists (select 1 from public.role_assignments where user_id = v_user_id)
     or exists (select 1 from public.employees where user_id = v_user_id) then
    raise exception using errcode = '23505', message = 'This account already belongs to an organization';
  end if;

  if nullif(btrim(p_organization_name), '') is null or char_length(btrim(p_organization_name)) > 120 then
    raise exception using errcode = '22023', message = 'Organization name must be between 1 and 120 characters';
  end if;
  if nullif(btrim(p_first_name), '') is null or char_length(btrim(p_first_name)) > 80 then
    raise exception using errcode = '22023', message = 'First name must be between 1 and 80 characters';
  end if;
  if nullif(btrim(p_last_name), '') is null or char_length(btrim(p_last_name)) > 80 then
    raise exception using errcode = '22023', message = 'Last name must be between 1 and 80 characters';
  end if;
  if nullif(btrim(p_timezone), '') is null or char_length(btrim(p_timezone)) > 100 then
    raise exception using errcode = '22023', message = 'A valid timezone is required';
  end if;
  if p_country_code is not null and p_country_code !~ '^[A-Za-z]{2}$' then
    raise exception using errcode = '22023', message = 'Country code must contain two letters';
  end if;

  select email into v_email from auth.users where id = v_user_id;
  if v_email is null then
    raise exception using errcode = '22023', message = 'A verified email address is required';
  end if;

  v_base_slug := trim(both '-' from regexp_replace(lower(coalesce(p_slug, p_organization_name)), '[^a-z0-9]+', '-', 'g'));
  if char_length(v_base_slug) < 2 then v_base_slug := 'organization'; end if;
  v_slug := left(v_base_slug, 50);
  if exists (select 1 from public.organizations where slug = v_slug) then
    v_slug := left(v_base_slug, 41) || '-' || left(replace(gen_random_uuid()::text, '-', ''), 8);
  end if;

  insert into public.organizations (name, slug, timezone, country_code)
  values (btrim(p_organization_name), v_slug, btrim(p_timezone), upper(p_country_code))
  returning * into v_org;

  insert into public.employees (
    organization_id, user_id, employee_number, first_name, last_name, work_email, status, hire_date
  ) values (
    v_org.id, v_user_id, 'EMP-0001', btrim(p_first_name), btrim(p_last_name), v_email, 'active', current_date
  ) returning * into v_employee;

  insert into public.role_assignments (organization_id, user_id, role, granted_by)
  values (v_org.id, v_user_id, 'admin', v_user_id);

  perform private.seed_organization_starter_workspace(v_org.id, v_employee.id, v_user_id);

  perform private.log_audit_event(
    v_org.id,
    'ORGANIZATION_WORKSPACE_CREATED',
    'organization',
    v_org.id,
    null,
    jsonb_build_object('organization', to_jsonb(v_org), 'first_admin_employee_id', v_employee.id)
  );

  select * into v_org from public.organizations where id = v_org.id;
  return v_org;
end;
$$;

revoke execute on function public.create_organization_workspace(text, text, text, text, text, text)
  from public, anon;
grant execute on function public.create_organization_workspace(text, text, text, text, text, text)
  to authenticated;

create or replace function public.initialize_organization_workspace(p_organization_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_employee_id uuid;
begin
  if v_user_id is null or not private.has_permission(p_organization_id, 'organization.manage') then
    raise exception using errcode = '42501', message = 'Only an organization administrator can initialize this workspace';
  end if;

  select e.id into v_employee_id
  from public.employees e
  where e.organization_id = p_organization_id and e.user_id = v_user_id
  limit 1;

  if v_employee_id is null then
    raise exception using errcode = '42501', message = 'The administrator must have an employee record in this organization';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text, 1));
  perform private.seed_organization_starter_workspace(p_organization_id, v_employee_id, v_user_id);

  perform private.log_audit_event(
    p_organization_id, 'ORGANIZATION_STARTER_WORKSPACE_INITIALIZED',
    'organization', p_organization_id, null,
    jsonb_build_object('initialized_by', v_user_id)
  );

  return jsonb_build_object('ok', true, 'organization_id', p_organization_id);
end;
$$;

revoke execute on function public.initialize_organization_workspace(uuid) from public, anon;
grant execute on function public.initialize_organization_workspace(uuid) to authenticated;

create or replace function public.update_organization_portal(
  p_organization_id uuid,
  p_slug text,
  p_portal_title text default null,
  p_portal_message text default null
)
returns public.organizations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slug text;
  v_old public.organizations;
  v_updated public.organizations;
begin
  if auth.uid() is null or not private.has_permission(p_organization_id, 'organization.manage') then
    raise exception using errcode = '42501', message = 'Only an organization administrator can update the employee portal';
  end if;

  select * into v_old from public.organizations where id = p_organization_id for update;
  if v_old.id is null then raise exception using errcode = 'P0002', message = 'Organization not found'; end if;

  v_slug := trim(both '-' from regexp_replace(lower(coalesce(p_slug, '')), '[^a-z0-9]+', '-', 'g'));
  if char_length(v_slug) < 3 or char_length(v_slug) > 50 then
    raise exception using errcode = '22023', message = 'Portal address must contain 3 to 50 letters, numbers, or hyphens';
  end if;
  if v_slug in ('admin', 'api', 'auth', 'dashboard', 'login', 'portal', 'signup', 'support', 'www') then
    raise exception using errcode = '22023', message = 'That portal address is reserved';
  end if;
  if nullif(btrim(p_portal_title), '') is not null and char_length(btrim(p_portal_title)) > 100 then
    raise exception using errcode = '22023', message = 'Portal heading must be 100 characters or fewer';
  end if;
  if nullif(btrim(p_portal_message), '') is not null and char_length(btrim(p_portal_message)) > 240 then
    raise exception using errcode = '22023', message = 'Portal message must be 240 characters or fewer';
  end if;

  update public.organizations
  set slug = v_slug,
      settings = settings || jsonb_build_object(
        'portal_enabled', true,
        'portal_title', coalesce(nullif(btrim(p_portal_title), ''), 'Welcome to ' || name),
        'portal_message', coalesce(
          nullif(btrim(p_portal_message), ''),
          'Sign in to manage your workday, time away, documents, and development.'
        )
      )
  where id = p_organization_id
  returning * into v_updated;

  perform private.log_audit_event(
    p_organization_id, 'ORGANIZATION_PORTAL_UPDATED', 'organization',
    p_organization_id, to_jsonb(v_old), to_jsonb(v_updated)
  );

  return v_updated;
exception
  when unique_violation then
    raise exception using errcode = '23505', message = 'That employee portal address is already in use';
end;
$$;

revoke execute on function public.update_organization_portal(uuid, text, text, text) from public, anon;
grant execute on function public.update_organization_portal(uuid, text, text, text) to authenticated;

-- Repairs the two safe historical partial states: an employee linked without
-- a baseline role, or a granted role whose employee record was never created.
-- It never invents an organization or elevates a role.
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
  select * into v_employee from public.employees where user_id = v_user_id limit 1;
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
    from auth.users u where u.id = v_user_id;

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
    perform private.seed_organization_starter_workspace(v_employee.organization_id, v_employee.id, v_user_id);
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

-- Edge Functions must distinguish "can view this person" from the stronger
-- employee.manage permission. Supervisors can read direct reports, but only
-- an administrator/HR role may create their login account.
create or replace function public.can_invite_employee(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.employees e
    where e.id = p_employee_id
      and private.has_permission(e.organization_id, 'employee.manage')
  );
$$;

revoke execute on function public.can_invite_employee(uuid) from public, anon;
grant execute on function public.can_invite_employee(uuid) to authenticated;

-- Called only by the service-role Edge Function after Auth creates the user.
-- Employee linking and the baseline role are one transaction, preventing the
-- partially-provisioned account that previously rendered an empty workspace.
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

  update public.employees set user_id = p_user_id where id = p_employee_id;

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

-- Intentionally public and deliberately narrow: employee sign-in pages need
-- to resolve a portal before authentication. The function returns only the
-- organization name and owner-configured welcome copy; it never exposes the
-- organization row, settings JSON, users, employees, or internal IDs.
create or replace function public.get_organization_portal(p_slug text)
returns table (
  name text,
  slug text,
  portal_title text,
  portal_message text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    o.name,
    o.slug::text,
    coalesce(nullif(o.settings->>'portal_title', ''), 'Welcome to ' || o.name),
    coalesce(
      nullif(o.settings->>'portal_message', ''),
      'Sign in to manage your workday, time away, documents, and development.'
    )
  from public.organizations o
  where o.slug = lower(btrim(p_slug))
    and o.is_active
    and coalesce((o.settings->>'portal_enabled')::boolean, true)
  limit 1;
$$;

revoke execute on function public.get_organization_portal(text) from public;
grant execute on function public.get_organization_portal(text) to anon, authenticated;
