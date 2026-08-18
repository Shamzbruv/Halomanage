-- Halomanage — OPTIONAL local-only auth bootstrapping
--
-- NOT run automatically by `supabase db reset` (only seed.sql is). Run this
-- by hand against a LOCAL Supabase instance only, after `supabase start`,
-- e.g.: `supabase db execute --local --file supabase/seed_auth_users.sql`
-- (or paste it into the local Studio SQL editor at http://localhost:54323).
--
-- Why this is separate from seed.sql: inserting directly into auth.users /
-- auth.identities is version-sensitive (Supabase's Auth schema has changed
-- shape across releases) and is not how production accounts should ever be
-- created — see supabase/functions/invite-employee for the real flow. This
-- file exists purely so the five RLS test personas from seed.sql
-- (Alice/Bob/Carol/David/Erin — matching ARCHITECTURE.md's "Testing
-- strategy" example) can actually log in in a local dev environment without
-- wiring up email delivery. All five get the password: Halomanage123!
--
-- If this fails against your local Auth schema version, use the Studio
-- "Add user" UI instead and then just run the role_assignments block below
-- with the resulting user ids substituted in.

do $$
declare
  v_org uuid := '00000000-0000-0000-0000-000000000001';
  v_alice_employee uuid := '00000000-0000-0000-0000-0000000000a1';
  v_bob_employee uuid := '00000000-0000-0000-0000-0000000000b1';
  v_carol_employee uuid := '00000000-0000-0000-0000-0000000000c1';
  v_david_employee uuid := '00000000-0000-0000-0000-0000000000d1';
  v_erin_employee uuid := '00000000-0000-0000-0000-0000000000e1';

  v_alice_user uuid := '10000000-0000-0000-0000-0000000000a1';
  v_bob_user uuid := '10000000-0000-0000-0000-0000000000b1';
  v_carol_user uuid := '10000000-0000-0000-0000-0000000000c1';
  v_david_user uuid := '10000000-0000-0000-0000-0000000000d1';
  v_erin_user uuid := '10000000-0000-0000-0000-0000000000e1';

  persona record;
begin
  for persona in
    select * from (values
      (v_alice_user, 'alice@acme.test', v_alice_employee, 'employee'),
      (v_bob_user, 'bob@acme.test', v_bob_employee, 'supervisor'),
      (v_carol_user, 'carol@acme.test', v_carol_employee, 'manager'),
      (v_david_user, 'david@acme.test', v_david_employee, 'employee'),
      (v_erin_user, 'erin@acme.test', v_erin_employee, 'admin')
    ) as t(user_id, email, employee_id, role)
  loop
    insert into auth.users (
      id, instance_id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at, confirmation_token, recovery_token
    )
    values (
      persona.user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
      persona.email, crypt('Halomanage123!', gen_salt('bf')),
      now(), '{"provider":"email","providers":["email"]}', '{}',
      now(), now(), '', ''
    )
    on conflict (id) do nothing;

    insert into auth.identities (
      id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
    )
    values (
      gen_random_uuid(), persona.user_id, persona.user_id::text,
      jsonb_build_object('sub', persona.user_id::text, 'email', persona.email),
      'email', now(), now(), now()
    )
    on conflict do nothing;

    update public.employees set user_id = persona.user_id where id = persona.employee_id;

    insert into public.role_assignments (organization_id, user_id, role)
    values (v_org, persona.user_id, persona.role::public.app_role)
    on conflict do nothing;
  end loop;
end $$;
