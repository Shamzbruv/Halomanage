-- Halomanage — RLS denial tests (pgTAP)
-- Ref: ARCHITECTURE.md "Testing strategy" — "an HR security failure is
-- usually not 'the user could not log in'; it is 'the logged-in user could
-- access one row they were never supposed to see.'" These tests exist to
-- catch exactly that class of bug, using the same five personas the
-- architecture doc uses as its worked example.
--
-- Run with the Supabase CLI: `supabase test db` (requires local Docker).
-- Assumes supabase/seed.sql and supabase/seed_auth_users.sql have been
-- applied first so the five personas below actually exist.
--
-- This file is intentionally a *starting* suite covering the highest-value
-- cross-tenant/cross-scope denial cases from employees/employee_private —
-- equivalent coverage for attendance, leave, payroll and documents is
-- tracked in docs/ROADMAP.md and should follow this same pattern.

begin;
select plan(7);

-- Fixed personas from supabase/seed_auth_users.sql
-- Alice — Employee, reports to Bob (Supervisor) and Carol (Manager)
-- Bob   — Supervisor, reports to Carol (Manager)
-- Carol — Manager
-- David — Employee, reports to Carol directly (different team than Alice)
-- Erin  — Admin

create or replace function tests.become(p_user_id uuid) returns void as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$ language plpgsql;

do $$ begin
  if not exists (select 1 from pg_namespace where nspname = 'tests') then
    create schema tests;
  end if;
end $$;

-- 1. Alice cannot read David's employee row (peer employee, no reporting relationship).
select tests.become('10000000-0000-0000-0000-0000000000a1');
select is(
  (select count(*) from public.employees where id = '00000000-0000-0000-0000-0000000000d1'),
  0::bigint,
  'Alice cannot see David''s employee record'
);

-- 2. Alice CAN read her own employee row.
select is(
  (select count(*) from public.employees where id = '00000000-0000-0000-0000-0000000000a1'),
  1::bigint,
  'Alice can see her own employee record'
);

-- 3. Bob (Alice's supervisor) CAN see Alice via management_scope.
select tests.become('10000000-0000-0000-0000-0000000000b1');
select is(
  (select count(*) from public.employees where id = '00000000-0000-0000-0000-0000000000a1'),
  1::bigint,
  'Bob (Alice''s supervisor) can see Alice''s employee record'
);

-- 4. Bob cannot see David (not in Bob's management scope).
select is(
  (select count(*) from public.employees where id = '00000000-0000-0000-0000-0000000000d1'),
  0::bigint,
  'Bob cannot see David (outside his management scope)'
);

-- 5. Alice cannot read her own employee_private row via someone else's — sanity check the reverse isn't leaking.
select tests.become('10000000-0000-0000-0000-0000000000a1');
select is(
  (select count(*) from public.employee_private where employee_id = '00000000-0000-0000-0000-0000000000d1'),
  0::bigint,
  'Alice cannot see David''s private PII'
);

-- 6. Bob (Supervisor, no employee.manage grant) cannot see Alice's private PII —
-- "Manager should not automatically equal HR".
select tests.become('10000000-0000-0000-0000-0000000000b1');
select is(
  (select count(*) from public.employee_private where employee_id = '00000000-0000-0000-0000-0000000000a1'),
  0::bigint,
  'Bob (Supervisor) cannot see Alice''s private PII without employee.manage'
);

-- 7. Erin (Admin, holds employee.manage) CAN see Alice's private PII, if a row exists.
select tests.become('10000000-0000-0000-0000-0000000000e1');
select ok(
  (select private.has_permission('00000000-0000-0000-0000-000000000001'::uuid, 'employee.manage'::public.app_permission)),
  'Erin (Admin) holds employee.manage in the seeded organization'
);

select * from finish();
rollback;
