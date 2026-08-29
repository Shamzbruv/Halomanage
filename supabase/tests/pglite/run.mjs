// Halomanage — Docker-free integration test suite (PGlite / WASM Postgres)
//
// Applies every migration in supabase/migrations/ against a real (if
// embedded) Postgres engine, then exercises the core RPCs as five
// impersonated personas with RLS actually enforced — not a mock. This is a
// deliberate second testing layer alongside supabase/tests/database/*.sql
// (pgTAP, which needs the Supabase CLI + Docker): this suite needs only
// `npm install && npm test` and is what CI should run on every change to
// supabase/migrations/.
//
// It is NOT a substitute for testing against a real Supabase project
// before going live — PGlite stubs Auth/Storage (see bootstrap.sql) well
// enough to validate schema/RLS/RPC logic, but doesn't reproduce Supabase's
// actual Auth flows, Storage signed URLs, Realtime, or Edge Functions. See
// docs/ROADMAP.md → "First thing to do next".
//
// This suite was what actually found (and, once fixed, now guards against
// regressing) four real bugs during initial development:
//   1. PL/pgSQL "record variable cannot be part of multiple-item INTO
//      list" in the payroll row-matching RPCs.
//   2. management_scope never refreshing when an employee's account is
//      linked *after* their reporting-line assignment already exists (the
//      realistic order of operations) — a Supervisor invited after their
//      reports would never see them.
//   3. current_payroll_records silently returning nothing for an employee
//      because payroll_import_batches had no SELECT policy for ordinary
//      employees at all, even though payroll_import_rows did.
//   4. Infinite RLS recursion from mutual plain-subquery cross-references
//      between two tables (payroll_import_batches ↔ payroll_import_rows,
//      and separately appraisal_instances ↔ appraisal_reviewers) — fixed
//      with SECURITY DEFINER helper functions that break the cycle.
// Keep this file passing; extend it (or supabase/tests/database/) for any
// new module before trusting its RLS.

import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { citext } from "@electric-sql/pglite/contrib/citext";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const migrationsDir = path.join(repoRoot, "supabase/migrations");

const db = new PGlite({ extensions: { pgcrypto, citext } });

let passCount = 0;
let failCount = 0;
function ok(label, cond) {
  if (cond) {
    passCount += 1;
    console.log(`PASS ${label}`);
  } else {
    failCount += 1;
    console.log(`FAIL ${label}`);
  }
}

async function as(userId, fn) {
  await db.exec(`set role authenticated; select set_config('request.jwt.uid', '${userId}', false);`);
  try {
    return await fn();
  } finally {
    // Both halves matter: resetting role alone leaves request.jwt.uid set
    // to the last impersonated user, so auth.uid() keeps returning a stale
    // (non-null) value for any *un-impersonated* code that runs
    // afterwards — including private.enforce_employee_protected_columns()'s
    // "auth.uid() is null" fast path for trusted/service-role-style
    // context, which several persona-linking statements below rely on.
    // Caught by the first test that ever called as() before that linking
    // code ran (every previous run happened to call as() only afterward).
    await db.exec(`reset role; select set_config('request.jwt.uid', '', false);`);
  }
}

async function main() {
  await db.exec(fs.readFileSync(path.join(__dirname, "bootstrap.sql"), "utf8"));

  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    try {
      await db.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
    } catch (err) {
      console.error(`Migration failed: ${file}`);
      throw err;
    }
  }
  console.log(`Applied ${fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).length} migrations cleanly.\n`);

  // Compensation tables were added after an earlier one-time blanket grant.
  // This assertion intentionally runs before the test harness mimics broad
  // Supabase provisioning below, so a migration that forgets explicit Data
  // API privileges cannot be masked by the harness itself.
  const compensationGrantCheck = await db.query(`
    select bool_and(
      has_table_privilege('authenticated', table_name, 'SELECT')
      and has_table_privilege('authenticated', table_name, 'INSERT')
      and has_table_privilege('authenticated', table_name, 'UPDATE')
      and has_table_privilege('authenticated', table_name, 'DELETE')
    ) as granted
    from unnest(array[
      'public.pay_groups',
      'public.pay_calendars',
      'public.pay_periods',
      'public.pay_grades',
      'public.compensation_components',
      'public.compensation_change_reasons',
      'public.employee_compensation_components'
    ]) as grants(table_name)
  `);
  ok("all compensation administration tables have explicit authenticated Data API grants", compensationGrantCheck.rows[0].granted === true);

  // Mimic Supabase's default provisioning grants (real projects have these
  // already; our migrations correctly don't redo them).
  await db.exec(`
    grant usage on schema public, storage to authenticated, anon;
    grant all on all tables in schema public to authenticated;
    grant all on all sequences in schema public to authenticated;
    grant execute on all functions in schema public to authenticated;
    grant select, insert, update, delete on storage.objects to authenticated;
    grant select on storage.buckets to authenticated;
  `);

  // ==================== FIRST-ORGANIZATION BOOTSTRAP ==========================
  // Must run against the genuinely empty, freshly-migrated database — before
  // seed.sql creates an organization — since that emptiness is exactly what
  // deployment_needs_bootstrap()/bootstrap_first_organization() key off of.
  // This is the flow a real user hit live in production with no HR admin to
  // ask for an invitation from; see 20260818001900_bootstrap_first_organization.sql.
  const FOUNDER_USER = "20000000-0000-0000-0000-000000000001";
  const IMPOSTER_USER = "20000000-0000-0000-0000-000000000002";
  await db.exec(`
    insert into auth.users (id, email) values
      ('${FOUNDER_USER}', 'founder@newco.test'), ('${IMPOSTER_USER}', 'imposter@elsewhere.test');
  `);

  await as(FOUNDER_USER, async () => {
    const before = await db.query(`select public.deployment_needs_bootstrap() as needed`);
    ok("fresh deployment (zero orgs) reports it needs bootstrapping", before.rows[0].needed === true);

    const org = await db.query(`select * from public.bootstrap_first_organization(
      'NewCo Ltd', 'newco', 'Founding', 'Admin', 'America/Jamaica', 'JM'
    )`);
    ok("the founder can bootstrap the first organization", org.rows[0].name === "NewCo Ltd");

    const employees = await db.query(`select first_name, last_name, status from public.employees where organization_id = '${org.rows[0].id}'`);
    ok("bootstrapping created exactly one employee record — the founder", employees.rows.length === 1 && employees.rows[0].first_name === "Founding");

    const roles = await db.query(`select role from public.role_assignments where user_id = '${FOUNDER_USER}'`);
    ok("the founder was granted the admin role", roles.rows.length === 1 && roles.rows[0].role === "admin");

    const after = await db.query(`select public.deployment_needs_bootstrap() as needed`);
    ok("deployment no longer reports needing bootstrap after one exists", after.rows[0].needed === false);
  });

  await as(IMPOSTER_USER, async () => {
    let threw = false;
    try {
      await db.query(`select * from public.bootstrap_first_organization('Squatter Inc', 'squatter', 'Some', 'Rando')`);
    } catch { threw = true; }
    ok("a second person cannot bootstrap another organization once one exists — must be invited instead", threw);
  });

  // Checked as a superuser (no RLS), not as the impostor — the impostor
  // legitimately can't see any organization via RLS regardless of how many
  // exist, since they're not a member of one; that's not the thing this
  // assertion is testing.
  const orgCountAfter = await db.query(`select count(*) from public.organizations`);
  ok("the attempted second bootstrap created no organization", Number(orgCountAfter.rows[0].count) === 1);

  let independentOrgId;
  await as(IMPOSTER_USER, async () => {
    const org = await db.query(`select * from public.create_organization_workspace(
      'Independent Co', 'independent', 'Second', 'Founder', 'America/Jamaica', 'JM'
    )`);
    independentOrgId = org.rows[0].id;
    ok("a new organization owner can create an isolated workspace", org.rows[0].name === "Independent Co");

    const structure = await db.query(`
      select
        (select count(*) from public.org_units where organization_id = '${independentOrgId}') as units,
        (select count(*) from public.positions where organization_id = '${independentOrgId}') as positions,
        (select count(*) from public.locations where organization_id = '${independentOrgId}') as locations
    `);
    ok("workspace provisioning creates a usable organization structure", Number(structure.rows[0].units) === 1 && Number(structure.rows[0].positions) === 1 && Number(structure.rows[0].locations) === 1);

    const workday = await db.query(`
      select
        (select count(*) from public.employee_assignments where organization_id = '${independentOrgId}' and end_date is null) as assignments,
        (select count(*) from public.schedule_assignments where organization_id = '${independentOrgId}' and end_date is null) as schedules,
        (select count(*) from public.schedule_shifts ss join public.work_schedules ws on ws.id = ss.schedule_id where ws.organization_id = '${independentOrgId}') as shifts
    `);
    ok("workspace provisioning assigns the owner to a five-day work schedule", Number(workday.rows[0].assignments) === 1 && Number(workday.rows[0].schedules) === 1 && Number(workday.rows[0].shifts) === 5);

    const leave = await db.query(`
      select
        (select count(*) from public.leave_types where organization_id = '${independentOrgId}') as types,
        (select coalesce(sum(amount), 0) from public.leave_ledger where organization_id = '${independentOrgId}') as balance
    `);
    ok("workspace provisioning gives the owner practical starter leave", Number(leave.rows[0].types) === 3 && Number(leave.rows[0].balance) === 25);

    const workflows = await db.query(`
      select
        (select count(*) from public.onboarding_templates where organization_id = '${independentOrgId}') as onboarding,
        (select count(*) from public.appraisal_templates where organization_id = '${independentOrgId}') as appraisals,
        (select count(*) from public.training_courses where organization_id = '${independentOrgId}') as courses,
        (select count(*) from public.employee_training where organization_id = '${independentOrgId}') as assigned_courses
    `);
    ok("workspace provisioning includes onboarding, performance, and assigned learning", Number(workflows.rows[0].onboarding) === 1 && Number(workflows.rows[0].appraisals) === 1 && Number(workflows.rows[0].courses) === 1 && Number(workflows.rows[0].assigned_courses) === 1);

    await db.query(`select public.initialize_organization_workspace('${independentOrgId}')`);
    const idempotent = await db.query(`select count(*) from public.leave_types where organization_id = '${independentOrgId}'`);
    ok("re-running starter initialization is idempotent", Number(idempotent.rows[0].count) === 3);

    const portal = await db.query(`select * from public.update_organization_portal(
      '${independentOrgId}', 'independent-team', 'Welcome, Independent team', 'Clock in, request leave, and manage your employee account.'
    )`);
    // Portal branding moved out of organizations.settings JSON into its own
    // table (see 20260829142948_employee_experience_branding.sql) — check
    // the actual source of truth, not the now-stale settings blob.
    const brandingRow = await db.query(`select portal_title from public.organization_branding where organization_id = '${independentOrgId}'`);
    ok("an administrator can customize the organization employee portal", portal.rows[0].slug === "independent-team" && brandingRow.rows[0].portal_title === "Welcome, Independent team");

    let reservedThrew = false;
    try {
      await db.query(`select public.update_organization_portal('${independentOrgId}', 'admin', 'Bad address', 'Should not save')`);
    } catch { reservedThrew = true; }
    ok("reserved employee portal addresses are rejected", reservedThrew);

    let threw = false;
    try {
      await db.query(`select * from public.create_organization_workspace('Duplicate Co', 'duplicate', 'Second', 'Founder')`);
    } catch { threw = true; }
    ok("an account cannot provision a second workspace", threw);
  });

  const orgCountWithWorkspace = await db.query(`select count(*) from public.organizations`);
  ok("self-service provisioning creates exactly one additional organization", Number(orgCountWithWorkspace.rows[0].count) === 2);

  await db.exec(`set role anon; select set_config('request.jwt.uid', '', false);`);
  const publicPortal = await db.query(`select * from public.get_organization_portal('independent-team')`);
  await db.exec(`reset role;`);
  ok("the anonymous employee portal lookup returns only safe branded fields", publicPortal.rows.length === 1 && publicPortal.rows[0].name === "Independent Co" && Object.keys(publicPortal.rows[0]).sort().join(",") === "accent_color,logo_path,name,portal_message,portal_title,primary_color,slug");

  // Clean up the bootstrap-test org/employee/roles so it doesn't collide
  // with seed.sql's fixed UUIDs or pollute the persona tests below.
  await db.exec(`delete from public.organizations where id in ('${independentOrgId}') or slug = 'newco';`);
  await db.exec(`delete from auth.users where id in ('${FOUNDER_USER}', '${IMPOSTER_USER}');`);

  await db.exec(fs.readFileSync(path.join(repoRoot, "supabase/seed.sql"), "utf8"));
  console.log("seed.sql applied.\n");

  const ORG = "00000000-0000-0000-0000-000000000001";
  const ALICE_EMP = "00000000-0000-0000-0000-0000000000a1";
  const BOB_EMP = "00000000-0000-0000-0000-0000000000b1";
  const CAROL_EMP = "00000000-0000-0000-0000-0000000000c1";
  const DAVID_EMP = "00000000-0000-0000-0000-0000000000d1";
  const ERIN_EMP = "00000000-0000-0000-0000-0000000000e1";
  const ALICE_USER = "10000000-0000-0000-0000-0000000000a1";
  const BOB_USER = "10000000-0000-0000-0000-0000000000b1";
  const CAROL_USER = "10000000-0000-0000-0000-0000000000c1";
  const DAVID_USER = "10000000-0000-0000-0000-0000000000d1";
  const ERIN_USER = "10000000-0000-0000-0000-0000000000e1";

  await db.exec(`
    insert into auth.users (id, email) values
      ('${ALICE_USER}', 'alice@acme.test'), ('${BOB_USER}', 'bob@acme.test'),
      ('${CAROL_USER}', 'carol@acme.test'), ('${DAVID_USER}', 'david@acme.test'), ('${ERIN_USER}', 'erin@acme.test');
    update public.employees set user_id = '${ALICE_USER}' where id = '${ALICE_EMP}';
    update public.employees set user_id = '${BOB_USER}' where id = '${BOB_EMP}';
    update public.employees set user_id = '${CAROL_USER}' where id = '${CAROL_EMP}';
    update public.employees set user_id = '${DAVID_USER}' where id = '${DAVID_EMP}';
    update public.employees set user_id = '${ERIN_USER}' where id = '${ERIN_EMP}';
    insert into public.role_assignments (organization_id, user_id, role) values
      ('${ORG}', '${ALICE_USER}', 'employee'), ('${ORG}', '${BOB_USER}', 'supervisor'),
      ('${ORG}', '${CAROL_USER}', 'manager'), ('${ORG}', '${DAVID_USER}', 'employee'), ('${ORG}', '${ERIN_USER}', 'admin');
  `);
  console.log("Five RLS test personas linked (Alice/Bob/Carol/David/Erin — see docs/ARCHITECTURE.md).\n");

  await db.exec(`delete from public.role_assignments where user_id = '${ALICE_USER}';`);
  await as(ALICE_USER, async () => {
    const repaired = await db.query(`select public.repair_current_workspace('Alice', 'Employee') as result`);
    ok("repair restores a missing baseline role without elevating the employee", repaired.rows[0].result.repaired === true);
    const roles = await db.query(`select role from public.role_assignments where user_id = '${ALICE_USER}'`);
    ok("employee-side workspace repair restores only the employee role", roles.rows.length === 1 && roles.rows[0].role === "employee");
  });

  const PARTIAL_USER = "10000000-0000-0000-0000-0000000000f2";
  await db.exec(`
    insert into auth.users (id, email, raw_user_meta_data) values ('${PARTIAL_USER}', 'partial@acme.test', '{"first_name":"Partial","last_name":"Member"}');
    insert into public.role_assignments (organization_id, user_id, role) values ('${ORG}', '${PARTIAL_USER}', 'employee');
  `);
  await as(PARTIAL_USER, async () => {
    const repaired = await db.query(`select public.repair_current_workspace(null, null) as result`);
    const employee = await db.query(`select first_name, last_name from public.employees where user_id = '${PARTIAL_USER}'`);
    ok("repair creates a missing employee record for an already-granted role", repaired.rows[0].result.repaired === true && employee.rows[0].first_name === "Partial");
  });
  await db.exec(`
    delete from public.audit_events where employee_id = (select id from public.employees where user_id = '${PARTIAL_USER}');
    delete from public.employees where user_id = '${PARTIAL_USER}';
    delete from auth.users where id = '${PARTIAL_USER}';
  `);

  // =========================== DIRECTORY / RLS SCOPE =========================
  await as(ALICE_USER, async () => {
    ok("Alice sees her own employee row",
      Number((await db.query(`select count(*) from public.employees where id = '${ALICE_EMP}'`)).rows[0].count) === 1);
    ok("Alice cannot see David's employee row",
      Number((await db.query(`select count(*) from public.employees where id = '${DAVID_EMP}'`)).rows[0].count) === 0);
  });
  await as(BOB_USER, async () => {
    ok("Bob (Alice's supervisor) sees Alice",
      Number((await db.query(`select count(*) from public.employees where id = '${ALICE_EMP}'`)).rows[0].count) === 1);
    ok("Bob cannot see David (outside his management scope)",
      Number((await db.query(`select count(*) from public.employees where id = '${DAVID_EMP}'`)).rows[0].count) === 0);
    const canInvite = await db.query(`select public.can_invite_employee('${ALICE_EMP}') as allowed`);
    ok("a supervisor who can read a direct report still cannot invite accounts", canInvite.rows[0].allowed === false);
  });
  await as(ERIN_USER, async () => {
    const canInvite = await db.query(`select public.can_invite_employee('${ALICE_EMP}') as allowed`);
    ok("an administrator with employee.manage can invite accounts", canInvite.rows[0].allowed === true);
  });
  await as(BOB_USER, async () => {
    const priv = await db.query(`select count(*) from public.employee_private where employee_id = '${ALICE_EMP}'`);
    ok("Bob (Supervisor, no employee.manage) cannot see Alice's private PII", Number(priv.rows[0].count) === 0);
  });

  const INVITED_USER = "10000000-0000-0000-0000-0000000000f1";
  const INVITED_EMP = "00000000-0000-0000-0000-0000000000f1";
  await db.exec(`
    insert into auth.users (id, email) values ('${INVITED_USER}', 'invited@acme.test');
    insert into public.employees (id, organization_id, employee_number, first_name, last_name, work_email, status)
    values ('${INVITED_EMP}', '${ORG}', 'TEST-INVITE', 'Invited', 'Employee', 'invited@acme.test', 'prehire');
    select public.link_invited_employee_account('${INVITED_EMP}', '${INVITED_USER}');
    select public.link_invited_employee_account('${INVITED_EMP}', '${INVITED_USER}');
  `);
  const linkedInvite = await db.query(`
    select e.user_id,
      (select count(*) from public.role_assignments ra where ra.user_id = '${INVITED_USER}' and ra.organization_id = '${ORG}' and ra.role = 'employee') as role_count
    from public.employees e where e.id = '${INVITED_EMP}'
  `);
  ok("invitation linking atomically connects the employee and exactly one baseline role", linkedInvite.rows[0].user_id === INVITED_USER && Number(linkedInvite.rows[0].role_count) === 1);
  const activatedOnLink = await db.query(`select status, hire_date from public.employees where id = '${INVITED_EMP}'`);
  ok("accepting an invite auto-activates a prehire employee", activatedOnLink.rows[0].status === "active" && activatedOnLink.rows[0].hire_date !== null);
  await db.exec(`delete from public.employees where id = '${INVITED_EMP}'; delete from auth.users where id = '${INVITED_USER}';`);

  // ========================= EMPLOYEE ACTIVATION (RPC) =========================
  const PREHIRE_EMP = "00000000-0000-0000-0000-0000000000f9";
  await db.exec(`
    insert into public.employees (id, organization_id, employee_number, first_name, last_name, work_email, status)
    values ('${PREHIRE_EMP}', '${ORG}', 'TEST-PREHIRE', 'Future', 'Hire', 'future.hire@acme.test', 'prehire');
  `);
  await as(DAVID_USER, async () => {
    let threw = false;
    try { await db.query(`select * from public.activate_employee('${PREHIRE_EMP}')`); } catch { threw = true; }
    ok("David (no employee.manage) cannot activate an employee", threw);
  });
  await as(ERIN_USER, async () => {
    const activated = await db.query(`select * from public.activate_employee('${PREHIRE_EMP}')`);
    ok("Erin can activate a prehire employee", activated.rows[0].status === "active" && activated.rows[0].hire_date !== null);
    let threw = false;
    try { await db.query(`select * from public.activate_employee('${PREHIRE_EMP}')`); } catch { threw = true; }
    ok("cannot activate an already-active employee", threw);
  });
  await db.exec(`delete from public.employees where id = '${PREHIRE_EMP}';`);

  // ============================ PLATFORM CONSOLE ===============================
  // Deliberately outside tenant RBAC — platform_staff carries no
  // organization_id, and no role_assignments row grants any of this by
  // construction. Reusing Carol/David here (already just an org manager and
  // a plain employee) is the point: platform access is completely
  // independent of whatever role they hold inside any tenant.
  await as(DAVID_USER, async () => {
    let threw = false;
    try { await db.query(`select * from public.platform_list_organizations()`); } catch { threw = true; }
    ok("a plain employee cannot list organizations through the platform console", threw);
  });

  await db.exec(`insert into public.platform_staff (user_id, role) values ('${CAROL_USER}', 'support');`);
  await as(CAROL_USER, async () => {
    const orgs = await db.query(`select * from public.platform_list_organizations()`);
    ok("platform staff can list organizations across the platform", orgs.rows.some((row) => row.id === ORG));

    const employees = await db.query(`select * from public.platform_list_organization_employees('${ORG}')`);
    ok("platform staff can list an organization's employee roster", employees.rows.length > 0);

    let threw = false;
    try { await db.query(`select * from public.platform_add_staff('nobody@acme.test', 'support')`); } catch { threw = true; }
    ok("a support-role platform staffer cannot add other platform staff (owner/admin only)", threw);
  });
  await db.exec(`delete from public.platform_staff where user_id = '${CAROL_USER}';`);
  await as(CAROL_USER, async () => {
    let threw = false;
    try { await db.query(`select * from public.platform_list_organizations()`); } catch { threw = true; }
    ok("removing the platform_staff row removes platform access immediately", threw);
  });

  // Feature entitlement: absent override means off; platform staff can flip
  // it per organization without touching anyone else's.
  const beforeOverride = await db.query(`select public.organization_has_feature('${ORG}', 'sso') as enabled`);
  ok("a feature with no override is off by default", beforeOverride.rows[0].enabled === false);

  await db.exec(`insert into public.platform_staff (user_id, role) values ('${CAROL_USER}', 'admin');`);
  await as(CAROL_USER, async () => {
    await db.query(`select public.platform_set_feature_override('${ORG}', 'sso', true, 'enabled for testing')`);
  });
  const afterOverride = await db.query(`select public.organization_has_feature('${ORG}', 'sso') as enabled`);
  ok("an admin-role platform staffer can turn a feature on for one organization", afterOverride.rows[0].enabled === true);

  await as(CAROL_USER, async () => {
    await db.query(`select public.platform_clear_feature_override('${ORG}', 'sso')`);
  });
  const afterClear = await db.query(`select public.organization_has_feature('${ORG}', 'sso') as enabled`);
  ok("clearing the override turns the feature back off", afterClear.rows[0].enabled === false);

  // Last-owner protection mirrors the tenant last-admin guard in set_member_role().
  await db.exec(`
    update public.platform_staff set role = 'owner' where user_id = '${CAROL_USER}';
    insert into public.platform_staff (user_id, role) values ('${DAVID_USER}', 'owner');
  `);
  await as(DAVID_USER, async () => {
    await db.query(`select public.platform_remove_staff('${CAROL_USER}')`);
  });
  const carolGone = await db.query(`select count(*) from public.platform_staff where user_id = '${CAROL_USER}'`);
  ok("an owner can remove another owner while one remains", Number(carolGone.rows[0].count) === 0);

  await db.exec(`insert into public.platform_staff (user_id, role) values ('${CAROL_USER}', 'admin');`);
  await as(CAROL_USER, async () => {
    let threw = false;
    try { await db.query(`select public.platform_remove_staff('${DAVID_USER}')`); } catch { threw = true; }
    ok("the last platform owner cannot be removed even by another admin", threw);
  });

  // SSO connection approval — the workflow that used to require a platform
  // operator running raw SQL against production (see file header of
  // 20260828160000_platform_console.sql).
  const ssoRequestId = (await db.query(`
    insert into public.organization_identity_providers (organization_id, domain, metadata_url, requested_by)
    values ('${ORG}', 'acme.test', 'https://idp.acme.test/metadata', '${ERIN_USER}')
    returning id
  `)).rows[0].id;
  await as(CAROL_USER, async () => {
    const pending = await db.query(`select * from public.platform_list_sso_requests()`);
    ok("platform staff can see the pending SSO connection request", pending.rows.some((row) => row.id === ssoRequestId && row.status === "requested"));

    const activated = await db.query(`
      select * from public.platform_update_identity_provider('${ssoRequestId}', 'active', 'okta|acme-test', false, null)
    `);
    ok("platform staff can activate an SSO connection", activated.rows[0].status === "active" && activated.rows[0].sso_provider_id === "okta|acme-test");
  });

  await db.exec(`delete from public.platform_staff where user_id in ('${CAROL_USER}', '${DAVID_USER}');`);

  // =============================== ATTENDANCE =================================
  await as(ALICE_USER, async () => {
    const in1 = await db.query(`select * from public.clock_in()`);
    ok("Alice can clock in", in1.rows.length === 1 && in1.rows[0].clock_out_at === null);
    let threw = false;
    try { await db.query(`select * from public.clock_in()`); } catch { threw = true; }
    ok("Alice cannot double clock-in (DB constraint)", threw);
    const out1 = await db.query(`select * from public.clock_out()`);
    ok("Alice can clock out", out1.rows[0].clock_out_at !== null);
  });
  await as(BOB_USER, async () => {
    const rows = await db.query(`select count(*) from public.attendance_sessions where employee_id = '${ALICE_EMP}'`);
    ok("Bob can see Alice's attendance (direct report)", Number(rows.rows[0].count) === 1);
  });
  await as(DAVID_USER, async () => {
    const rows = await db.query(`select count(*) from public.attendance_sessions where employee_id = '${ALICE_EMP}'`);
    ok("David cannot see Alice's attendance", Number(rows.rows[0].count) === 0);
  });

  // ================================== LEAVE ====================================
  let leaveRequestId, leaveTotalDays;
  await as(ALICE_USER, async () => {
    // +14/+15 (two weeks out), not +7/+8 (one week out): date_trunc('week', ...)
    // is the Monday of the CURRENT ISO week, so if "today" is a Saturday or
    // Sunday, +7/+8 lands only 1-2 days out — under the 3-day minimum notice
    // this same request checks below. +14/+15 keeps the same deterministic
    // Monday-Tuesday span regardless of which weekday the suite runs on.
    const res = await db.query(`select * from public.submit_leave(
      (select id from public.leave_types where organization_id = '${ORG}' and code = 'VAC'),
      (date_trunc('week', current_date)::date + 14),
      (date_trunc('week', current_date)::date + 15),
      false, 'Family trip', null
    )`);
    leaveRequestId = res.rows[0].id;
    leaveTotalDays = Number(res.rows[0].total_days);
    ok("Alice can submit a vacation request", res.rows[0].status === "pending_supervisor");
    ok("total_days counts the deterministic Monday-Tuesday range", leaveTotalDays === 2);
  });
  await as(BOB_USER, async () => {
    const n = await db.query(`select count(*) from public.notifications where recipient_user_id = '${BOB_USER}' and type = 'leave.requested'`);
    ok("Bob was notified of Alice's leave request", Number(n.rows[0].count) === 1);
  });
  await as(ALICE_USER, async () => {
    let threw = false;
    try { await db.query(`select * from public.decide_leave_request('${leaveRequestId}', true, null)`); } catch { threw = true; }
    ok("Alice (not the approver) cannot approve her own leave request", threw);
  });
  await as(BOB_USER, async () => {
    const res = await db.query(`select * from public.decide_leave_request('${leaveRequestId}', true, null)`);
    ok("Bob (supervisor) can approve Alice's leave request", res.rows[0].status === "approved");
  });
  await as(ALICE_USER, async () => {
    const bal = await db.query(`select balance from public.leave_balance_v where employee_id = '${ALICE_EMP}' and leave_type_id = (select id from public.leave_types where code = 'VAC')`);
    ok(`Alice's vacation balance was deducted (15 - ${leaveTotalDays})`, Number(bal.rows[0].balance) === 15 - leaveTotalDays);
  });

  // ======================== EMPLOYEE SELF-SERVICE PROTECTION ===================
  await as(ALICE_USER, async () => {
    await db.query(`update public.employees set preferred_name = 'Ali' where id = '${ALICE_EMP}'`);
    let threw = false;
    try { await db.query(`update public.employees set status = 'terminated' where id = '${ALICE_EMP}'`); } catch { threw = true; }
    ok("Alice cannot change her own employment status", threw);
  });
  await as(ERIN_USER, async () => {
    await db.query(`update public.employees set status = 'terminated', termination_date = current_date where id = '${DAVID_EMP}'`);
    ok("Erin (Admin) can change employment status without the offboarding auto-trigger crashing (no template configured)", true);
  });

  // ================================= PAYROLL ====================================
  let batchId;
  await as(ERIN_USER, async () => {
    const res = await db.query(`select * from public.create_payroll_import_batch(
      '${ORG}', 'pay_run_results', 'august.csv', '${ORG}/fake-path/august.csv', 'deadbeef',
      '2026-08-01', '2026-08-15', '2026-08-15', 'USD', null, null
    )`);
    batchId = res.rows[0].id;
    ok("Erin can create a payroll import batch", res.rows[0].status === "uploaded");
  });
  // Simulates the payroll-import Edge Function's service_role insert.
  await db.exec(`
    insert into public.payroll_import_rows (batch_id, row_number, employee_id, employee_number, gross_pay, net_pay, raw_row, mapping_status, validation_status)
    values ('${batchId}', 1, '${BOB_EMP}', 'EMP-0002', 5000, 4200, '{}'::jsonb, 'matched', 'valid'),
           ('${batchId}', 2, null, 'EMP-9999', 5000, 4200, '{}'::jsonb, 'unmatched', 'invalid');
  `);
  await as(ERIN_USER, async () => {
    const r1 = await db.query(`select * from public.recompute_payroll_batch_status('${batchId}')`);
    ok("recompute reports 1 matched / 1 unmatched", r1.rows[0].matched_rows === 1 && r1.rows[0].unmatched_rows === 1);
    ok("status is needs_review while a row is unmatched", r1.rows[0].status === "needs_review");
    let threw = false;
    try { await db.query(`select * from public.approve_payroll_import('${batchId}')`); } catch { threw = true; }
    ok("cannot approve while a row is unresolved", threw);
  });
  await as(DAVID_USER, async () => {
    let threw = false;
    try {
      await db.query(`select * from public.resolve_payroll_row_match((select id from public.payroll_import_rows where batch_id = '${batchId}' and row_number = 2), '${ERIN_EMP}')`);
    } catch { threw = true; }
    ok("David (no payroll.import permission) cannot resolve a row match", threw);
  });
  await as(ERIN_USER, async () => {
    const resolved = await db.query(`select * from public.resolve_payroll_row_match((select id from public.payroll_import_rows where batch_id = '${batchId}' and row_number = 2), '${ERIN_EMP}')`);
    ok("Erin (payroll.import) can resolve an unmatched row", resolved.rows[0].mapping_status === "matched");
    const r2 = await db.query(`select * from public.recompute_payroll_batch_status('${batchId}')`);
    ok("after resolving the row, status is ready_for_approval", r2.rows[0].status === "ready_for_approval");
    const approved = await db.query(`select * from public.approve_payroll_import('${batchId}')`);
    ok("Erin can approve a clean batch", approved.rows[0].status === "approved");
  });
  await as(BOB_USER, async () => {
    const mine = await db.query(`select net_pay from public.current_payroll_records where employee_id = '${BOB_EMP}'`);
    ok("Bob can see his own approved pay record via current_payroll_records", mine.rows.length === 1 && Number(mine.rows[0].net_pay) === 4200);
  });
  await as(ALICE_USER, async () => {
    const notMine = await db.query(`select count(*) from public.current_payroll_records where employee_id = '${BOB_EMP}'`);
    ok("Alice cannot see Bob's pay record", Number(notMine.rows[0].count) === 0);
  });

  let compBatchId;
  await as(ERIN_USER, async () => {
    const res = await db.query(`select * from public.create_payroll_import_batch(
      '${ORG}', 'compensation_change', 'raises.csv', '${ORG}/fake-path/raises.csv', 'cafebabe', null, null, null, 'USD', null, null
    )`);
    compBatchId = res.rows[0].id;
  });
  await db.exec(`
    insert into public.compensation_change_rows (batch_id, row_number, employee_id, employee_number, effective_date, old_amount, new_amount, currency, raw_row, mapping_status, validation_status)
    values ('${compBatchId}', 1, '${BOB_EMP}', 'EMP-0002', current_date, null, 55000, 'USD', '{}'::jsonb, 'matched', 'valid');
  `);
  await as(ERIN_USER, async () => {
    await db.query(`select * from public.recompute_payroll_batch_status('${compBatchId}')`);
    const approved = await db.query(`select * from public.approve_payroll_import('${compBatchId}')`);
    ok("Erin can approve a compensation-change batch", approved.rows[0].status === "approved");
  });
  await as(BOB_USER, async () => {
    const comp = await db.query(`select amount, end_date from public.employee_compensation where employee_id = '${BOB_EMP}'`);
    ok("approving a compensation-change batch creates an open effective-dated compensation row",
      comp.rows.length === 1 && Number(comp.rows[0].amount) === 55000 && comp.rows[0].end_date === null);
  });

  // ===================== EMPLOYEE MIGRATION CENTER ======================
  // Ref: supabase/migrations/20260826154926_employee_migration_center.sql.
  // The employee-import Edge Function (XLSX/CSV parsing) isn't runnable
  // here, so rows are staged directly with a service_role-style insert —
  // exactly what that function does after it parses a workbook — and the
  // suite exercises everything downstream of that: permission checks,
  // validation, the needs-review -> ready-for-import -> committed
  // lifecycle, and rollback's two independent activity guards.
  let migBatchId;
  await as(DAVID_USER, async () => {
    let threw = false;
    try {
      await db.query(`select * from public.create_employee_import_batch('${ORG}', 'spreadsheet', 'team.csv', '${ORG}/fake/team.csv', 'hash1', 'update', '{}')`);
    } catch { threw = true; }
    ok("David (no employee.manage) cannot create an import batch", threw);
  });
  await as(ERIN_USER, async () => {
    const res = await db.query(`select * from public.create_employee_import_batch('${ORG}', 'spreadsheet', 'team.csv', '${ORG}/fake/team.csv', 'hash1', 'update', '{}')`);
    migBatchId = res.rows[0].id;
    ok("Erin can create an import batch", res.rows[0].status === "uploaded");
  });
  // Simulates the employee-import Edge Function's service_role insert: one
  // clean create, one clean update (Bob's phone), one row missing a
  // required field.
  await db.exec(`
    insert into public.employee_import_rows (batch_id, row_number, raw_row, normalized_row) values
      ('${migBatchId}', 1, '{}'::jsonb, '{"employee_number":"EMP-0006","first_name":"Frank","last_name":"Stone","work_email":"frank@acme.test","status":"active"}'::jsonb),
      ('${migBatchId}', 2, '{}'::jsonb, '{"employee_number":"EMP-0002","first_name":"Bob","last_name":"Green","work_phone":"+1876555222"}'::jsonb),
      ('${migBatchId}', 3, '{}'::jsonb, '{"employee_number":"EMP-0008","first_name":"NoLast"}'::jsonb);
  `);
  await as(ERIN_USER, async () => {
    const validated = await db.query(`select * from public.revalidate_employee_import_batch('${migBatchId}')`);
    const row = validated.rows[0];
    ok("revalidate counts 3 rows with 1 error", row.total_rows === 3 && row.error_rows === 1 && row.valid_rows === 2);
    ok("revalidate identifies 1 create and 1 update", row.create_rows === 1 && row.update_rows === 1);
    ok("batch needs review while a row has an error", row.status === "needs_review");
    let threw = false;
    try { await db.query(`select * from public.commit_employee_import_batch('${migBatchId}')`); } catch { threw = true; }
    ok("cannot commit while the batch needs review", threw);
  });
  await db.exec(`
    update public.employee_import_rows set normalized_row = normalized_row || '{"last_name":"Lastname"}'::jsonb
    where batch_id = '${migBatchId}' and row_number = 3;
  `);
  await as(ERIN_USER, async () => {
    const revalidated = await db.query(`select * from public.revalidate_employee_import_batch('${migBatchId}')`);
    ok("fixing the bad row moves the batch to ready_for_import", revalidated.rows[0].status === "ready_for_import" && revalidated.rows[0].error_rows === 0);
  });
  await as(DAVID_USER, async () => {
    let threw = false;
    try { await db.query(`select * from public.commit_employee_import_batch('${migBatchId}')`); } catch { threw = true; }
    ok("David (no employee.manage) cannot commit an import batch", threw);
  });
  let frankEmpId;
  await as(ERIN_USER, async () => {
    const committed = await db.query(`select * from public.commit_employee_import_batch('${migBatchId}')`);
    ok("Erin can commit a clean import batch", committed.rows[0].status === "committed");
    const frank = await db.query(`select id from public.employees where organization_id = '${ORG}' and employee_number = 'EMP-0006'`);
    ok("the create row produced a new employee", frank.rows.length === 1 && frank.rows[0].id);
    frankEmpId = frank.rows[0].id;
    const bob = await db.query(`select work_phone from public.employees where id = '${BOB_EMP}'`);
    ok("the update row changed Bob's phone number", bob.rows[0].work_phone === "+1876555222");
  });

  // Rollback guard #1: refuse a created employee once they have any
  // workspace activity of their own, so rollback can never quietly discard
  // real work done under an imported identity.
  await db.exec(`insert into public.attendance_sessions (organization_id, employee_id, work_date, clock_in_at) values ('${ORG}', '${frankEmpId}', current_date, now());`);
  await as(ERIN_USER, async () => {
    let threw = false;
    try { await db.query(`select * from public.rollback_employee_import_batch('${migBatchId}')`); } catch { threw = true; }
    ok("rollback is blocked once an imported employee has activity", threw);
  });

  // Rollback guard #2: refuse an updated employee if their row changed
  // again after the import committed (concurrent/unrelated edit), so
  // rollback never clobbers a later legitimate change.
  let carolBatchId;
  await as(ERIN_USER, async () => {
    const res = await db.query(`select * from public.create_employee_import_batch('${ORG}', 'spreadsheet', 'carol.csv', '${ORG}/fake/carol.csv', 'hash2', 'update', '{}')`);
    carolBatchId = res.rows[0].id;
  });
  await db.exec(`
    insert into public.employee_import_rows (batch_id, row_number, raw_row, normalized_row) values
      ('${carolBatchId}', 1, '{}'::jsonb, '{"employee_number":"EMP-0003","first_name":"Carol","last_name":"White","work_phone":"+1876555333"}'::jsonb);
  `);
  await as(ERIN_USER, async () => {
    await db.query(`select * from public.revalidate_employee_import_batch('${carolBatchId}')`);
    await db.query(`select * from public.commit_employee_import_batch('${carolBatchId}')`);
  });
  await db.exec(`update public.employees set work_phone = 'changed-after-import' where id = '${CAROL_EMP}';`);
  await as(ERIN_USER, async () => {
    let threw = false;
    try { await db.query(`select * from public.rollback_employee_import_batch('${carolBatchId}')`); } catch { threw = true; }
    ok("rollback is blocked once an updated employee changed again afterward", threw);
    const carol = await db.query(`select work_phone from public.employees where id = '${CAROL_EMP}'`);
    ok("the blocked rollback left Carol's later change untouched", carol.rows[0].work_phone === "changed-after-import");
  });

  // A clean batch with no subsequent activity rolls back completely.
  let graceBatchId;
  await as(ERIN_USER, async () => {
    const res = await db.query(`select * from public.create_employee_import_batch('${ORG}', 'spreadsheet', 'grace.csv', '${ORG}/fake/grace.csv', 'hash3', 'update', '{}')`);
    graceBatchId = res.rows[0].id;
  });
  await db.exec(`
    insert into public.employee_import_rows (batch_id, row_number, raw_row, normalized_row) values
      ('${graceBatchId}', 1, '{}'::jsonb, '{"employee_number":"EMP-0010","first_name":"Grace","last_name":"Hill"}'::jsonb);
  `);
  await as(ERIN_USER, async () => {
    await db.query(`select * from public.revalidate_employee_import_batch('${graceBatchId}')`);
    await db.query(`select * from public.commit_employee_import_batch('${graceBatchId}')`);
    const rolledBack = await db.query(`select * from public.rollback_employee_import_batch('${graceBatchId}')`);
    ok("a clean batch with no subsequent activity rolls back", rolledBack.rows[0].status === "rolled_back");
    const grace = await db.query(`select count(*) from public.employees where organization_id = '${ORG}' and employee_number = 'EMP-0010'`);
    ok("rollback removed the employee it had created", Number(grace.rows[0].count) === 0);
  });

  // ================================ ONBOARDING ===================================
  let templateVersionId, stepAId, stepBId;
  await as(ERIN_USER, async () => {
    const tmpl = await db.query(`insert into public.onboarding_templates (organization_id, name, is_default) values ('${ORG}', 'Standard onboarding', true) returning id`);
    const version = await db.query(`insert into public.onboarding_template_versions (template_id, version_number, is_current) values ('${tmpl.rows[0].id}', 1, true) returning id`);
    templateVersionId = version.rows[0].id;
    const stepA = await db.query(`insert into public.onboarding_template_steps (template_version_id, title, step_type, assignee_type, sequence, due_offset_days) values ('${templateVersionId}', 'Upload ID', 'document_upload', 'employee', 1, 3) returning id`);
    stepAId = stepA.rows[0].id;
    const stepB = await db.query(`insert into public.onboarding_template_steps (template_version_id, title, step_type, assignee_type, sequence, due_offset_days, dependency_step_ids) values ('${templateVersionId}', 'Supervisor welcome meeting', 'meeting', 'supervisor', 2, 5, array['${stepAId}']::uuid[]) returning id`);
    stepBId = stepB.rows[0].id;
  });
  let runId, taskAId, taskBId;
  await as(ERIN_USER, async () => {
    const run = await db.query(`select * from public.start_onboarding('${DAVID_EMP}', null)`);
    runId = run.rows[0].id;
    ok("Erin can start onboarding for David", run.rows[0].status === "in_progress");
    const tasks = await db.query(`select id, assigned_to_user_id from public.onboarding_tasks where run_id = '${runId}' order by sequence`);
    taskAId = tasks.rows[0].id;
    taskBId = tasks.rows[1].id;
    ok("2 tasks were instantiated", tasks.rows.length === 2);
    ok("Task A assigned to David (employee)", tasks.rows[0].assigned_to_user_id === DAVID_USER);
  });
  await as(DAVID_USER, async () => {
    let threw = false;
    try { await db.query(`select * from public.complete_onboarding_task('${taskBId}', null)`); } catch { threw = true; }
    ok("Task B (depends on Task A) cannot be completed early", threw);
    const doneA = await db.query(`select * from public.complete_onboarding_task('${taskAId}', null)`);
    ok("David can complete his own Task A", doneA.rows[0].status === "completed");
  });
  await as(ERIN_USER, async () => {
    const doneB = await db.query(`select * from public.complete_onboarding_task('${taskBId}', null)`);
    ok("Erin (employee.manage) can complete an unassigned task", doneB.rows[0].status === "completed");
    const run = await db.query(`select status from public.onboarding_runs where id = '${runId}'`);
    ok("Onboarding run auto-completes once all required tasks are done", run.rows[0].status === "completed");
  });

  // ================================ APPRAISALS ====================================
  let templateId2, sectionId, questionId, cycleId, instanceId;
  await as(ERIN_USER, async () => {
    const t = await db.query(`insert into public.appraisal_templates (organization_id, name) values ('${ORG}', '90-day checkpoint') returning id`);
    templateId2 = t.rows[0].id;
    const s = await db.query(`insert into public.appraisal_sections (template_id, title, sequence) values ('${templateId2}', 'Performance', 1) returning id`);
    sectionId = s.rows[0].id;
    questionId = (await db.query(`insert into public.appraisal_questions (section_id, prompt, question_type, sequence) values ('${sectionId}', 'Overall rating', 'numeric_rating', 1) returning id`)).rows[0].id;
    const c = await db.query(`insert into public.appraisal_cycles (organization_id, template_id, name, start_date) values ('${ORG}', '${templateId2}', '90-day: Alice', current_date) returning id`);
    cycleId = c.rows[0].id;
    const launched = await db.query(`select * from public.launch_appraisal_cycle('${cycleId}')`);
    instanceId = launched.rows.find((r) => r.employee_id === ALICE_EMP).id;
    ok("launch_appraisal_cycle creates an instance for Alice", !!instanceId);
  });
  await as(BOB_USER, async () => {
    const visible = await db.query(`select id from public.appraisal_instances where id = '${instanceId}'`);
    ok("Bob (a reviewer) can see the instance — no RLS recursion", visible.rows.length === 1);
  });
  await as(ALICE_USER, async () => {
    const rows = await db.query(`select role from public.appraisal_reviewers where instance_id = '${instanceId}'`);
    ok("Alice (the subject) can see all reviewer rows — no RLS recursion", rows.rows.length === 3);
    const submit = await db.query(`select * from public.submit_appraisal('${instanceId}')`);
    ok("Alice can submit her self-review stage", submit.rows[0].status === "supervisor_review");
  });
  await as(DAVID_USER, async () => {
    const visible = await db.query(`select id from public.appraisal_instances where id = '${instanceId}'`);
    ok("David (unrelated) cannot see Alice's appraisal instance", visible.rows.length === 0);
  });
  await as(BOB_USER, async () => {
    const submit = await db.query(`select * from public.submit_appraisal('${instanceId}')`);
    ok("Bob (supervisor) can submit his review stage", submit.rows[0].status === "manager_review");
  });
  await as(CAROL_USER, async () => {
    const submit = await db.query(`select * from public.submit_appraisal('${instanceId}')`);
    ok("Carol (manager) can submit her review stage", submit.rows[0].status === "employee_acknowledgement");
  });
  await as(ALICE_USER, async () => {
    const ack = await db.query(`select * from public.acknowledge_appraisal('${instanceId}', 'Looks fair')`);
    ok("Alice can acknowledge the completed appraisal", ack.rows[0].status === "complete");
  });

  // ============================ EMPLOYEE ASSIGNMENT ============================
  // Deliberately last: this mutates Alice's reporting line, which every
  // earlier section (leave routing, onboarding assignee resolution,
  // appraisal reviewer assignment) assumes is the original seed.sql shape
  // (Bob=supervisor, Carol=manager). Run structural-change tests after
  // everything that depends on the org chart being stable, not before.
  await as(DAVID_USER, async () => {
    let threw = false;
    try {
      await db.query(`select * from public.change_employee_assignment(
        '${ALICE_EMP}', null, null, null, '${DAVID_EMP}', null, 'full_time', current_date, 'David tries to grab Alice'
      )`);
    } catch { threw = true; }
    ok("David (no employee.manage) cannot change Alice's assignment", threw);
  });
  await as(ERIN_USER, async () => {
    const before = await db.query(`select supervisor_employee_id from public.employee_assignments where employee_id = '${ALICE_EMP}' and end_date is null`);
    const changed = await db.query(`select * from public.change_employee_assignment(
      '${ALICE_EMP}', null, null, null, '${CAROL_EMP}', null, 'full_time', (current_date + 1)::date, 'Team restructure'
    )`);
    ok("Erin can transfer Alice to a new supervisor", changed.rows[0].supervisor_employee_id === CAROL_EMP);
    const historyCount = await db.query(`select count(*) from public.employee_assignments where employee_id = '${ALICE_EMP}'`);
    ok("the prior assignment row is preserved as history, not overwritten", Number(historyCount.rows[0].count) === 2 && before.rows[0].supervisor_employee_id === BOB_EMP);
    const openCount = await db.query(`select count(*) from public.employee_assignments where employee_id = '${ALICE_EMP}' and end_date is null`);
    ok("exactly one open assignment remains after the transfer", Number(openCount.rows[0].count) === 1);
  });
  await as(BOB_USER, async () => {
    const rows = await db.query(`select count(*) from public.employees where id = '${ALICE_EMP}'`);
    ok("Bob (Alice's former supervisor) no longer sees Alice after the transfer", Number(rows.rows[0].count) === 0);
  });
  await as(CAROL_USER, async () => {
    const rows = await db.query(`select count(*) from public.employees where id = '${ALICE_EMP}'`);
    ok("Carol (Alice's new supervisor) sees Alice after the transfer", Number(rows.rows[0].count) === 1);
  });

  // ===================== LIFECYCLE / RBAC HARDENING =====================
  // Ref: 20260828110000_lifecycle_rbac_hardening.sql.

  // Security regression: `!=` against a NULL assigned_to_user_id evaluates
  // to NULL, and PL/pgSQL's `if` treats NULL as false (skips the raise) —
  // so the *previous* version of complete_onboarding_task/
  // complete_offboarding_task let ANY authenticated caller complete an
  // unassigned ("hr"-owned) task regardless of permission. IS DISTINCT
  // FROM is the null-safe fix; these two blocks specifically recreate an
  // unassigned task and confirm an unprivileged, unassigned caller is now
  // rejected — the case the earlier "Erin (employee.manage) can complete
  // an unassigned task" assertion never actually covered, since Erin
  // holding the permission would pass under the old buggy code too.
  // Fixture setup, not the thing under test — run unimpersonated (bypasses
  // RLS, same as every other raw fixture insert in this file) rather than
  // through the start_onboarding()/start_offboarding() RPCs, since those
  // don't offer a way to force an unassigned "hr" step onto a real run.
  let unassignedOnboardingRunId, unassignedOnboardingTaskId;
  {
    const run = await db.query(`insert into public.onboarding_runs (organization_id, employee_id, template_version_id, created_by) values ('${ORG}', '${ALICE_EMP}', '${templateVersionId}', '${ERIN_USER}') returning id`);
    unassignedOnboardingRunId = run.rows[0].id;
    const task = await db.query(`
      insert into public.onboarding_tasks (run_id, template_step_id, organization_id, employee_id, title, step_type, assignee_type, assigned_to_user_id, sequence, required)
      values ('${unassignedOnboardingRunId}', '${stepAId}', '${ORG}', '${ALICE_EMP}', 'HR-owned onboarding task', 'form', 'hr', null, 1, true)
      returning id
    `);
    unassignedOnboardingTaskId = task.rows[0].id;
  }
  await as(DAVID_USER, async () => {
    let threw = false;
    try { await db.query(`select * from public.complete_onboarding_task('${unassignedOnboardingTaskId}', null)`); } catch { threw = true; }
    ok("David (unassigned, no employee.manage) cannot complete an unassigned onboarding task", threw);
  });
  await as(ERIN_USER, async () => {
    const done = await db.query(`select * from public.complete_onboarding_task('${unassignedOnboardingTaskId}', null)`);
    ok("Erin (employee.manage) can still complete an unassigned onboarding task", done.rows[0].status === "completed");
  });

  let offboardingTemplateId, unassignedOffboardingRunId, unassignedOffboardingTaskId;
  {
    const tmpl = await db.query(`insert into public.offboarding_templates (organization_id, name, is_default, is_active) values ('${ORG}', 'Regression test template', false, true) returning id`);
    offboardingTemplateId = tmpl.rows[0].id;
    const run = await db.query(`insert into public.offboarding_runs (organization_id, employee_id, template_id, created_by) values ('${ORG}', '${ALICE_EMP}', '${offboardingTemplateId}', '${ERIN_USER}') returning id`);
    unassignedOffboardingRunId = run.rows[0].id;
    const task = await db.query(`
      insert into public.offboarding_tasks (run_id, organization_id, employee_id, title, assignee_type, assigned_to_user_id, sequence, required)
      values ('${unassignedOffboardingRunId}', '${ORG}', '${ALICE_EMP}', 'HR-owned exit task', 'hr', null, 1, true)
      returning id
    `);
    unassignedOffboardingTaskId = task.rows[0].id;
  }
  await as(DAVID_USER, async () => {
    let threw = false;
    try { await db.query(`select * from public.complete_offboarding_task('${unassignedOffboardingTaskId}')`); } catch { threw = true; }
    ok("David (unassigned, no employee.manage) cannot complete an unassigned offboarding task", threw);
  });
  await as(ERIN_USER, async () => {
    const done = await db.query(`select * from public.complete_offboarding_task('${unassignedOffboardingTaskId}')`);
    ok("Erin (employee.manage) can still complete an unassigned offboarding task", done.rows[0].status === "completed");
  });

  // role_assignments is select-only now — every mutation must go through
  // set_member_role().
  await as(DAVID_USER, async () => {
    let threw = false;
    try { await db.query(`insert into public.role_assignments (organization_id, user_id, role) values ('${ORG}', '${DAVID_USER}', 'admin')`); } catch { threw = true; }
    ok("David cannot INSERT into role_assignments directly (write access revoked)", threw);
  });
  await as(DAVID_USER, async () => {
    let threw = false;
    try { await db.query(`select * from public.set_member_role('${ALICE_EMP}', 'supervisor', null)`); } catch { threw = true; }
    ok("David (no roles.manage) cannot change Alice's role", threw);
  });
  await as(ERIN_USER, async () => {
    const changed = await db.query(`select * from public.set_member_role('${ALICE_EMP}', 'supervisor', null)`);
    ok("Erin can promote Alice to supervisor", changed.rows[0].role === "supervisor");
    const activeRoles = await db.query(`select role from public.role_assignments where organization_id = '${ORG}' and user_id = '${ALICE_USER}' and (valid_until is null or valid_until > now())`);
    ok("Alice holds exactly one active role after the change", activeRoles.rows.length === 1 && activeRoles.rows[0].role === "supervisor");
  });
  await as(ERIN_USER, async () => {
    let threw = false;
    try { await db.query(`select * from public.set_member_role('${ERIN_EMP}', 'manager', null)`); } catch { threw = true; }
    ok("Erin (the only active admin) cannot demote herself", threw);
  });
  await as(ERIN_USER, async () => {
    // Prove the last-admin guard is actually about "last", not "any
    // change to an admin": with a second admin present, demoting Erin
    // succeeds.
    await db.query(`select * from public.set_member_role('${CAROL_EMP}', 'admin', null)`);
    const changed = await db.query(`select * from public.set_member_role('${ERIN_EMP}', 'manager', null)`);
    ok("Erin can demote herself once another admin exists", changed.rows[0].role === "manager");
  });
  await as(CAROL_USER, async () => {
    // Erin just lost roles.manage by demoting herself — Carol (the
    // remaining admin) is who restores the org's admin back to Erin.
    // Assert on the RPC's own return value rather than a follow-up SELECT:
    // once Carol demotes herself below, she loses roles.manage and the
    // "read own role assignments" RLS policy would hide Erin's row from her.
    const restored = await db.query(`select * from public.set_member_role('${ERIN_EMP}', 'admin', null)`);
    ok("Erin's admin role is restored", restored.rows[0]?.role === "admin");
    await db.query(`select * from public.set_member_role('${CAROL_EMP}', 'manager', null)`);
  });

  // ============================ TERMINATION ============================
  // Note: David's employees.status was already flipped to 'terminated' by
  // an earlier, pre-existing test (raw UPDATE, not through terminate_employee())
  // — so Bob is used here as the actually-untouched target for the RPC itself.
  await as(DAVID_USER, async () => {
    let threw = false;
    try { await db.query(`select * from public.terminate_employee('${ALICE_EMP}', current_date, 'test')`); } catch { threw = true; }
    ok("David (no employee.manage) cannot terminate Alice", threw);
  });
  await as(ERIN_USER, async () => {
    let threw = false;
    try { await db.query(`select * from public.terminate_employee('${ERIN_EMP}', current_date, null)`); } catch { threw = true; }
    ok("Erin cannot terminate her own employee record", threw);
  });
  await as(ERIN_USER, async () => {
    const terminated = await db.query(`select * from public.terminate_employee('${BOB_EMP}', current_date, 'Regression test')`);
    ok("Erin can terminate Bob", terminated.rows[0].status === "terminated");
    const assignment = await db.query(`select count(*) from public.employee_assignments where employee_id = '${BOB_EMP}' and end_date is null`);
    ok("Bob's open assignment was closed by termination", Number(assignment.rows[0].count) === 0);
    const activeRole = await db.query(`select count(*) from public.role_assignments where organization_id = '${ORG}' and user_id = '${BOB_USER}' and (valid_until is null or valid_until > now())`);
    ok("Bob has no active role after termination", Number(activeRole.rows[0].count) === 0);
  });
  await as(ERIN_USER, async () => {
    let threw = false;
    try { await db.query(`select * from public.terminate_employee('${BOB_EMP}', current_date, null)`); } catch { threw = true; }
    ok("Bob cannot be terminated a second time", threw);
  });
  await as(BOB_USER, async () => {
    let threw = false;
    try { await db.query(`select public.repair_current_workspace(null, null) as result`); } catch { threw = true; }
    ok("A terminated employee cannot use workspace-repair to restore access", threw);
  });

  // ================ COMPENSATION & PAY ADMINISTRATION ================
  // A second organization proves pay_groups/pay_calendars/pay_grades/
  // compensation_components/employee_compensation are tenant-isolated —
  // none of the existing fixtures exercise a second org for these tables.
  const ORG2 = "00000000-0000-0000-0000-000000000002";
  const ORG2_ADMIN_USER = "10000000-0000-0000-0000-00000000a002";
  const ORG2_ADMIN_EMP = "00000000-0000-0000-0000-00000000a002";
  await db.exec(`
    insert into auth.users (id, email) values ('${ORG2_ADMIN_USER}', 'org2admin@acme.test');
    insert into public.organizations (id, name, slug) values ('${ORG2}', 'Acme Two', 'acme-two');
    insert into public.employees (id, organization_id, employee_number, first_name, last_name, work_email, status, user_id)
    values ('${ORG2_ADMIN_EMP}', '${ORG2}', 'ORG2-0001', 'Two', 'Admin', 'org2admin@acme.test', 'active', '${ORG2_ADMIN_USER}');
    insert into public.role_assignments (organization_id, user_id, role) values ('${ORG2}', '${ORG2_ADMIN_USER}', 'admin');
  `);

  // --- Pay groups / calendars: structure permission required, tenant-isolated ---
  let payGroupId, payCalendarId;
  await as(DAVID_USER, async () => {
    let threw = false;
    try { await db.query(`insert into public.pay_groups (organization_id, name, code, pay_frequency) values ('${ORG}', 'Salaried Monthly', 'SAL-M', 'monthly')`); } catch { threw = true; }
    ok("David (no compensation.manage_structure) cannot create a pay group", threw);
  });
  await as(ERIN_USER, async () => {
    const pg = await db.query(`insert into public.pay_groups (organization_id, name, code, pay_frequency) values ('${ORG}', 'Salaried Monthly', 'SAL-M', 'monthly') returning id`);
    payGroupId = pg.rows[0].id;
    const cal = await db.query(`select * from public.create_pay_calendar('${ORG}', 'Monthly Calendar', 'monthly', '${payGroupId}')`);
    payCalendarId = cal.rows[0].id;
    const linked = await db.query(`select pay_calendar_id from public.pay_groups where id = '${payGroupId}'`);
    ok("create_pay_calendar atomically creates and wires a pay group's source-of-truth calendar", !!payCalendarId && linked.rows[0].pay_calendar_id === payCalendarId);
    const audit = await db.query(`select count(*) from public.audit_events where action = 'PAY_CALENDAR_CREATED' and entity_id = '${payCalendarId}'`);
    ok("create_pay_calendar records an audit event", Number(audit.rows[0].count) === 1);
  });
  await as(DAVID_USER, async () => {
    let threw = false;
    try { await db.query(`select * from public.create_pay_calendar('${ORG}', 'Unauthorized calendar', 'monthly', '${payGroupId}')`); } catch { threw = true; }
    ok("David (no pay_calendar.manage) cannot create or rewire a pay calendar", threw);
  });
  await as(ORG2_ADMIN_USER, async () => {
    const visible = await db.query(`select count(*) from public.pay_groups where id = '${payGroupId}'`);
    ok("ORG2's admin cannot see ORG's pay group (tenant isolation)", Number(visible.rows[0].count) === 0);
  });

  // --- Pay period generation is pure scheduling (date arithmetic, no money) ---
  await as(ERIN_USER, async () => {
    const periods = await db.query(`
      select period_start::text as period_start, period_end::text as period_end
      from public.generate_pay_periods('${payCalendarId}', '2027-01-01', 3)
      order by period_start
    `);
    ok("generate_pay_periods produced 3 monthly periods", periods.rows.length === 3);
    ok("the first monthly period runs Jan 1 -> Jan 31", periods.rows[0].period_start === "2027-01-01" && periods.rows[0].period_end === "2027-01-31");
    ok("the second monthly period runs Feb 1 -> Feb 28", periods.rows[1].period_start === "2027-02-01" && periods.rows[1].period_end === "2027-02-28");
  });
  await as(DAVID_USER, async () => {
    let threw = false;
    try { await db.query(`select * from public.generate_pay_periods('${payCalendarId}', '2028-01-01', 1)`); } catch { threw = true; }
    ok("David (no pay_calendar.manage) cannot generate pay periods", threw);
  });
  await as(ALICE_USER, async () => {
    const hidden = await db.query(`select count(*) from public.pay_groups where id = '${payGroupId}'`);
    ok("Alice cannot see a pay group before it is part of her effective compensation", Number(hidden.rows[0].count) === 0);
  });

  // --- Pay grades ---
  await as(ERIN_USER, async () => {
    const grade = await db.query(`insert into public.pay_grades (organization_id, name, code, currency, minimum_amount, midpoint_amount, maximum_amount) values ('${ORG}', 'Grade 5', 'G5', 'USD', 50000, 65000, 80000) returning id`);
    ok("Erin can create a pay grade with a valid min/mid/max range", grade.rows.length === 1);
    let threw = false;
    try { await db.query(`insert into public.pay_grades (organization_id, name, minimum_amount, maximum_amount) values ('${ORG}', 'Bad Grade', 100000, 50000)`); } catch { threw = true; }
    ok("a pay grade cannot have maximum below minimum", threw);
  });

  // --- Compensation components: recurring assignments can't overlap ---
  let componentId;
  await as(ERIN_USER, async () => {
    const comp = await db.query(`insert into public.compensation_components (organization_id, name, code, component_type, recurrence, value_type, default_amount) values ('${ORG}', 'Car Allowance', 'CAR', 'allowance', 'recurring', 'fixed_amount', 300) returning id`);
    componentId = comp.rows[0].id;
    ok("Erin can create a recurring compensation component", !!componentId);

    await db.query(`insert into public.employee_compensation_components (organization_id, employee_id, component_id, amount, start_date) values ('${ORG}', '${ALICE_EMP}', '${componentId}', 300, current_date)`);
    let threw = false;
    try {
      await db.query(`insert into public.employee_compensation_components (organization_id, employee_id, component_id, amount, start_date) values ('${ORG}', '${ALICE_EMP}', '${componentId}', 350, current_date)`);
    } catch { threw = true; }
    ok("a second open assignment of the same recurring component is rejected", threw);
  });

  // --- Manual, effective-dated Change Compensation workflow ---
  await as(DAVID_USER, async () => {
    let threw = false;
    try { await db.query(`select * from public.change_employee_compensation('${ALICE_EMP}', 60000, 'salaried', current_date, 'USD', 'year')`); } catch { threw = true; }
    ok("David (no compensation.manage) cannot change Alice's compensation", threw);
  });
  await as(CAROL_USER, async () => {
    // Carol is a Manager with employee.read_team, but Managers get no
    // compensation.* permission by default — proving access is never implied.
    let threw = false;
    try { await db.query(`select * from public.change_employee_compensation('${ALICE_EMP}', 60000, 'salaried', current_date, 'USD', 'year')`); } catch { threw = true; }
    ok("Carol (Manager, employee.read_team only) cannot change compensation without an explicit grant", threw);
  });
  await as(ERIN_USER, async () => {
    const first = await db.query(`select * from public.change_employee_compensation(
      p_employee_id => '${ALICE_EMP}',
      p_amount => 60000,
      p_pay_type => 'salaried',
      p_effective_date => current_date,
      p_currency => 'USD',
      p_rate_unit => 'year',
      p_pay_frequency => 'monthly',
      p_pay_group_id => '${payGroupId}'
    )`);
    ok("Erin can set Alice's initial compensation", Number(first.rows[0].amount) === 60000);
  });
  await as(ALICE_USER, async () => {
    const mine = await db.query(`select amount, pay_type, end_date from public.employee_compensation where employee_id = '${ALICE_EMP}' and end_date is null`);
    ok("Alice can read her own current compensation", mine.rows.length === 1 && Number(mine.rows[0].amount) === 60000);
    const group = await db.query(`select id from public.pay_groups where id = '${payGroupId}'`);
    const calendar = await db.query(`select id from public.pay_calendars where id = '${payCalendarId}'`);
    const periods = await db.query(`select count(*) from public.pay_periods where pay_calendar_id = '${payCalendarId}'`);
    ok("Alice can read the pay group on her effective compensation", group.rows.length === 1);
    ok("Alice can read the calendar wired to her effective pay group", calendar.rows.length === 1);
    ok("Alice can read future periods on her own compensation calendar", Number(periods.rows[0].count) === 3);
  });
  await as(CAROL_USER, async () => {
    const hidden = await db.query(`select count(*) from public.employee_compensation where employee_id = '${ALICE_EMP}'`);
    ok("Carol (Manager, no compensation.read_team) cannot see Alice's compensation history", Number(hidden.rows[0].count) === 0);
  });
  await as(ORG2_ADMIN_USER, async () => {
    const hidden = await db.query(`select count(*) from public.employee_compensation where employee_id = '${ALICE_EMP}'`);
    ok("ORG2's admin cannot see Alice's compensation (cross-tenant isolation)", Number(hidden.rows[0].count) === 0);
  });
  await as(ERIN_USER, async () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const second = await db.query(`select * from public.change_employee_compensation('${ALICE_EMP}', 65000, 'salaried', '${future}', 'USD', 'year', 'monthly')`);
    ok("Erin can raise Alice's compensation effective 30 days out", Number(second.rows[0].amount) === 65000);
    const history = await db.query(`select amount, end_date from public.employee_compensation where employee_id = '${ALICE_EMP}' order by start_date`);
    ok("the prior compensation record is closed, not overwritten", history.rows.length === 2 && history.rows[0].end_date !== null && Number(history.rows[0].amount) === 60000);
    ok("exactly one open compensation record remains", history.rows.filter((r) => r.end_date === null).length === 1);
  });

  // --- Privilege separation: structure access does not imply per-employee
  // change access. An org override REPLACES a role's whole bundle (not
  // adds to it — see private.has_permission()), so David's normal 'employee'
  // bundle is copied forward explicitly alongside the one permission being
  // tested, isolating exactly the variable this test cares about.
  await db.exec(`
    insert into public.role_permissions (organization_id, role, permission)
    select '${ORG}'::uuid, 'employee', permission from public.role_permissions where organization_id is null and role = 'employee'
    union all select '${ORG}'::uuid, 'employee'::public.app_role, 'compensation.manage_structure'::public.app_permission
    on conflict do nothing;
  `);
  await as(DAVID_USER, async () => {
    const grade = await db.query(`insert into public.pay_grades (organization_id, name) values ('${ORG}', 'David''s Grade') returning id`);
    ok("compensation.manage_structure alone lets David configure pay grades", grade.rows.length === 1);
    let threw = false;
    try { await db.query(`select * from public.change_employee_compensation('${ALICE_EMP}', 1, 'salaried', current_date, 'USD', 'year')`); } catch { threw = true; }
    ok("compensation.manage_structure alone does NOT let David change an individual's pay", threw);
  });
  await db.exec(`delete from public.role_permissions where organization_id = '${ORG}' and role = 'employee';`);

  // ================ REPORTING SCOPE, WORK SCHEDULES, ORG PROFILE ================
  // A role change grants capability; it never by itself decides who reports
  // to whom (see 20260829143000_role_reporting_scope.sql) — this is the RPC
  // that actually populates a leader's Team hub roster.
  await as(ERIN_USER, async () => {
    await db.query(`select public.set_member_role('${CAROL_EMP}', 'manager', null)`);
  });
  await as(DAVID_USER, async () => {
    let threw = false;
    try { await db.query(`select public.set_employee_reporting_scope('${CAROL_EMP}', array['${ALICE_EMP}']::uuid[], 'manager')`); } catch { threw = true; }
    ok("David (no employee.manage) cannot set reporting scope", threw);
  });
  await as(ERIN_USER, async () => {
    let threw = false;
    try { await db.query(`select public.set_employee_reporting_scope('${ALICE_EMP}', array['${CAROL_EMP}']::uuid[], 'manager')`); } catch { threw = true; }
    ok("cannot assign manager reports to someone without the Manager/Admin role", threw);
  });
  // David is excluded from this scope test: an earlier, pre-existing test
  // in this file already flipped his status to 'terminated' via a raw
  // update, and set_employee_reporting_scope correctly rejects a
  // non-active target — verified separately below rather than by accident.
  await as(ERIN_USER, async () => {
    const result = await db.query(`select public.set_employee_reporting_scope('${CAROL_EMP}', array['${ALICE_EMP}']::uuid[], 'manager') as result`);
    ok("Erin can assign Carol a manager direct report", result.rows[0].result.direct_report_count === 1);
  });
  await as(CAROL_USER, async () => {
    const reports = await db.query(`select employee_id from public.employee_assignments where manager_employee_id = '${CAROL_EMP}' and end_date is null`);
    ok("Carol's manager reporting scope now includes exactly Alice", reports.rows.length === 1 && reports.rows[0].employee_id === ALICE_EMP);
  });
  await as(ERIN_USER, async () => {
    let threw = false;
    try { await db.query(`select public.set_employee_reporting_scope('${CAROL_EMP}', array['${DAVID_EMP}']::uuid[], 'manager')`); } catch { threw = true; }
    ok("a terminated employee cannot be assigned as a direct report", threw);
  });
  await as(ERIN_USER, async () => {
    const result = await db.query(`select public.set_employee_reporting_scope('${CAROL_EMP}', array[]::uuid[], 'manager') as result`);
    ok("Erin can clear Carol's reporting scope back to zero reports", result.rows[0].result.direct_report_count === 0);
  });
  await as(CAROL_USER, async () => {
    const aliceAssignment = await db.query(`select manager_employee_id from public.employee_assignments where employee_id = '${ALICE_EMP}' and end_date is null`);
    ok("Alice is no longer one of Carol's manager reports after being removed", aliceAssignment.rows[0].manager_employee_id !== CAROL_EMP);
  });

  // --- Work schedules ---
  let scheduleId;
  await as(DAVID_USER, async () => {
    let threw = false;
    try { await db.query(`select * from public.create_work_schedule('${ORG}', 'Evening Shift')`); } catch { threw = true; }
    ok("David (no attendance.manage_policies) cannot create a work schedule", threw);
  });
  await as(ERIN_USER, async () => {
    const schedule = await db.query(`select * from public.create_work_schedule('${ORG}', 'Evening Shift', 'Afternoon coverage', false, array[1,2,3,4,5]::smallint[], '14:00', '22:00', 30)`);
    scheduleId = schedule.rows[0].id;
    ok("Erin can create a new work schedule", !!scheduleId);
  });
  await as(DAVID_USER, async () => {
    let threw = false;
    try { await db.query(`select * from public.assign_employee_schedule('${ALICE_EMP}', '${scheduleId}')`); } catch { threw = true; }
    ok("David (no attendance.manage_policies) cannot assign a schedule", threw);
  });
  await as(ERIN_USER, async () => {
    const assignment = await db.query(`select * from public.assign_employee_schedule('${ALICE_EMP}', '${scheduleId}')`);
    ok("Erin can assign Alice to the new schedule", assignment.rows[0].schedule_id === scheduleId);
  });
  await as(ALICE_USER, async () => {
    const mine = await db.query(`select schedule_id from public.schedule_assignments where employee_id = '${ALICE_EMP}' and end_date is null`);
    ok("Alice has exactly one open schedule assignment after being reassigned", mine.rows.length === 1 && mine.rows[0].schedule_id === scheduleId);
  });

  // --- Organization profile & branding ---
  const currentOrgSlug = (await db.query(`select slug::text from public.organizations where id = '${ORG}'`)).rows[0].slug;
  await as(DAVID_USER, async () => {
    let threw = false;
    try { await db.query(`select * from public.update_organization_profile('${ORG}', 'New Name')`); } catch { threw = true; }
    ok("David (no organization.manage) cannot update the company profile", threw);
  });
  await as(ERIN_USER, async () => {
    const profile = await db.query(`select * from public.update_organization_profile(
      '${ORG}', 'Acme Test Corp', 'Acme Test Corporation Ltd', 'hr@acme.test', '+1 555-0100',
      'https://acme.test', '1 Main St', null, 'Springfield', 'IL', '62701', 'US', 'UTC', 'en'
    )`);
    ok("Erin can update the company profile", profile.rows[0].legal_name === "Acme Test Corporation Ltd" && profile.rows[0].contact_email === "hr@acme.test");
  });
  await as(DAVID_USER, async () => {
    let threw = false;
    try { await db.query(`select * from public.update_organization_branding('${ORG}', '${currentOrgSlug}', true, 'Welcome', 'Sign in below', null, '#101B3D', '#F2B84B')`); } catch { threw = true; }
    ok("David (no organization.manage) cannot update employee portal branding", threw);
  });
  await as(ERIN_USER, async () => {
    const branding = await db.query(`select * from public.update_organization_branding('${ORG}', '${currentOrgSlug}', true, 'Welcome aboard', 'Sign in to get started', null, '#123456', '#ABCDEF')`);
    ok("Erin can update employee portal branding colors", branding.rows[0].primary_color === "#123456" && branding.rows[0].accent_color === "#ABCDEF");
    let threw = false;
    try { await db.query(`select * from public.update_organization_branding('${ORG}', '${currentOrgSlug}', true, 'x', 'y', 'not-a-valid-path.png', '#101B3D', '#F2B84B')`); } catch { threw = true; }
    ok("a logo path outside the organization's own folder is rejected", threw);
  });

  console.log(`\n${passCount} passed, ${failCount} failed.`);
  if (failCount > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
