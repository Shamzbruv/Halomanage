-- Halomanage — local/dev seed data
-- Run automatically by `supabase db reset` / `supabase start` against a
-- LOCAL project only. Never run this against a production project — it
-- creates a sample tenant with predictable IDs and no real security review.
--
-- This file intentionally does NOT create auth.users rows (that schema is
-- version-sensitive and best driven by the actual Auth API). It seeds
-- everything that doesn't depend on a login existing yet — organization
-- structure, policies, and employee directory rows with user_id = NULL —
-- so the app has real data to render immediately. See
-- supabase/seed_auth_users.sql for how to attach real logins to these five
-- employee personas (Alice/Bob/Carol/David/Erin — the same names
-- ARCHITECTURE.md's "Testing strategy" section uses for RLS test personas).

do $$
declare
  v_org uuid := '00000000-0000-0000-0000-000000000001';
  v_company_unit uuid := '00000000-0000-0000-0000-000000000010';
  v_ops_unit uuid := '00000000-0000-0000-0000-000000000011';
  v_cs_team_unit uuid := '00000000-0000-0000-0000-000000000012';
  v_location uuid := '00000000-0000-0000-0000-000000000020';
  v_pos_csr uuid := '00000000-0000-0000-0000-000000000030';
  v_pos_supervisor uuid := '00000000-0000-0000-0000-000000000031';
  v_pos_manager uuid := '00000000-0000-0000-0000-000000000032';
  v_pos_hr uuid := '00000000-0000-0000-0000-000000000033';

  v_alice uuid := '00000000-0000-0000-0000-0000000000a1'; -- Employee, Department A
  v_bob   uuid := '00000000-0000-0000-0000-0000000000b1'; -- Supervisor, Department A
  v_carol uuid := '00000000-0000-0000-0000-0000000000c1'; -- Manager, Division A
  v_david uuid := '00000000-0000-0000-0000-0000000000d1'; -- Employee, Department B
  v_erin  uuid := '00000000-0000-0000-0000-0000000000e1'; -- Admin

  v_vacation uuid := '00000000-0000-0000-0000-0000000000f1';
  v_sick uuid := '00000000-0000-0000-0000-0000000000f2';
begin
  insert into public.organizations (id, name, slug, timezone, country_code)
  values (v_org, 'Acme Jamaica Ltd', 'acme', 'America/Jamaica', 'JM')
  on conflict (id) do nothing;

  insert into public.org_units (id, organization_id, parent_id, name, type) values
    (v_company_unit, v_org, null, 'Acme Jamaica Ltd', 'company'),
    (v_ops_unit, v_org, v_company_unit, 'Operations', 'department'),
    (v_cs_team_unit, v_org, v_ops_unit, 'Customer Service', 'team')
  on conflict (id) do nothing;

  insert into public.locations (id, organization_id, name, city, country_code, timezone)
  values (v_location, v_org, 'Kingston HQ', 'Kingston', 'JM', 'America/Jamaica')
  on conflict (id) do nothing;

  insert into public.positions (id, organization_id, title) values
    (v_pos_csr, v_org, 'Customer Service Representative'),
    (v_pos_supervisor, v_org, 'Customer Service Supervisor'),
    (v_pos_manager, v_org, 'Operations Manager'),
    (v_pos_hr, v_org, 'HR Administrator')
  on conflict (id) do nothing;

  insert into public.employees (id, organization_id, employee_number, first_name, last_name, work_email, status, hire_date) values
    (v_alice, v_org, 'EMP-0001', 'Alice', 'Johnson', 'alice@acme.test', 'active', current_date - 400),
    (v_bob, v_org, 'EMP-0002', 'Bob', 'Green', 'bob@acme.test', 'active', current_date - 900),
    (v_carol, v_org, 'EMP-0003', 'Carol', 'White', 'carol@acme.test', 'active', current_date - 1500),
    (v_david, v_org, 'EMP-0004', 'David', 'Brown', 'david@acme.test', 'active', current_date - 200),
    (v_erin, v_org, 'EMP-0005', 'Erin', 'Blake', 'erin@acme.test', 'active', current_date - 1800)
  on conflict (id) do nothing;

  insert into public.employee_assignments (organization_id, employee_id, org_unit_id, position_id, location_id, supervisor_employee_id, manager_employee_id, employment_type, start_date) values
    (v_org, v_alice, v_cs_team_unit, v_pos_csr, v_location, v_bob, v_carol, 'full_time', current_date - 400),
    (v_org, v_bob, v_cs_team_unit, v_pos_supervisor, v_location, null, v_carol, 'full_time', current_date - 900),
    (v_org, v_carol, v_ops_unit, v_pos_manager, v_location, null, null, 'full_time', current_date - 1500),
    (v_org, v_david, v_ops_unit, v_pos_csr, v_location, null, v_carol, 'full_time', current_date - 200),
    (v_org, v_erin, v_company_unit, v_pos_hr, v_location, null, null, 'full_time', current_date - 1800)
  on conflict do nothing;

  insert into public.leave_types (id, organization_id, name, code, is_paid, requires_approval, minimum_notice_days, maximum_consecutive_days, allow_half_day) values
    (v_vacation, v_org, 'Vacation', 'VAC', true, true, 3, 20, true),
    (v_sick, v_org, 'Sick Leave', 'SICK', true, true, 0, 10, true)
  on conflict (organization_id, code) do nothing;

  insert into public.leave_ledger (organization_id, employee_id, leave_type_id, entry_type, amount, note) values
    (v_org, v_alice, v_vacation, 'grant', 15, 'Annual grant'),
    (v_org, v_alice, v_sick, 'grant', 10, 'Annual grant'),
    (v_org, v_david, v_vacation, 'grant', 15, 'Annual grant'),
    (v_org, v_david, v_sick, 'grant', 10, 'Annual grant');

  insert into public.holidays (organization_id, name, observed_on) values
    (v_org, 'Independence Day', make_date(extract(year from current_date)::int, 8, 6)),
    (v_org, 'National Heroes Day', make_date(extract(year from current_date)::int, 10, 21));
end $$;
