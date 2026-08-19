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
    await db.exec(`reset role;`);
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
  });
  await as(BOB_USER, async () => {
    const priv = await db.query(`select count(*) from public.employee_private where employee_id = '${ALICE_EMP}'`);
    ok("Bob (Supervisor, no employee.manage) cannot see Alice's private PII", Number(priv.rows[0].count) === 0);
  });

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
    const res = await db.query(`select * from public.submit_leave(
      (select id from public.leave_types where organization_id = '${ORG}' and code = 'VAC'),
      (current_date + 5)::date, (current_date + 6)::date, false, 'Family trip', null
    )`);
    leaveRequestId = res.rows[0].id;
    leaveTotalDays = Number(res.rows[0].total_days);
    ok("Alice can submit a vacation request", res.rows[0].status === "pending_supervisor");
    ok("total_days excludes weekends", leaveTotalDays === 1 || leaveTotalDays === 2);
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

  console.log(`\n${passCount} passed, ${failCount} failed.`);
  if (failCount > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
