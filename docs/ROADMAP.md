# Halomanage — Build Roadmap & Status

Living document. Update this whenever you finish or start a chunk of work —
it's the thing a fresh session (human or agent) should read first to know
what's real, what's stubbed, and what to do next. Last updated: 2026-08-18
(session 3 — full admin-configuration + self-service frontend build-out).

## Where things stand right now

**Backend (`supabase/migrations/`, `supabase/functions/`): the full MVP data
model + core business logic exists, and has been validated against a real
(if embedded) Postgres engine — not just read for syntax.** This repo has
never been deployed to an actual Supabase project (none has been created
yet), but every migration has been run end-to-end against
[PGlite](https://pglite.dev) (Postgres-in-WASM) via
`supabase/tests/pglite/`, which applies all 18 migrations, seeds five RLS
test personas, and runs 51 assertions with RLS actually enforced across
attendance, leave, payroll import (both flavors), onboarding, a full
appraisal cycle, and employee transfers/promotions — including deliberate
negative tests (wrong person tries to approve, unrelated employee tries to
read a record). **That process found and fixed four real bugs** before this
was ever "done": a PL/pgSQL INTO-list error, `management_scope` never
refreshing when an account is linked after its reporting-line assignment
already exists (the realistic order of operations), a missing RLS policy
that silently emptied `current_payroll_records` for ordinary employees, and
infinite RLS recursion from mutual cross-table subqueries in two separate
places. Full detail is in the comment block at the top of
`supabase/tests/pglite/run.mjs` — read it before assuming any of those
classes of bug can't recur elsewhere (they did recur once, in a different
module, before being caught the same way).

What that suite does *not* cover — because PGlite stubs Auth/Storage rather
than reproducing them — is real Supabase Auth flows (magic links, MFA,
SAML), Storage signed URLs, Realtime, and the Edge Functions. Those need an
actual Supabase project. **The first real task in this project is standing
up one and deploying to it** — treat that as the next integration-test
layer, not a formality; it's plausible (if less likely than before this
validation pass) that something Supabase-specific still needs a small fix
once real Auth/Storage/Realtime are involved instead of stubs.

**Frontend (`web/`): builds and typechecks clean** (`npm run build` passes,
20 routes) against Next.js 15 / React 18 / TypeScript strict mode, and now
covers every Phase-1 module end-to-end, including the admin configuration
screens (org structure, leave types, onboarding/appraisal template
builders) that were the biggest gap as of the previous session — an admin
can now actually set up the product through the UI instead of writing SQL
by hand. It has **not** been run against a live backend beyond the login
page (screenshotted with Playwright in the prior session; the newer pages
have not been screenshotted), so runtime behavior for anything past login
is unverified beyond what static types and the backend's own RPC contracts
(behaviorally tested) suggest. Two real PostgREST-embedding bugs (querying
a view instead of the underlying table for automatic relationship
embedding — see `docs/ARCHITECTURE.md` rule and the inline comments at each
fix site) were caught and fixed *during* this build purely by code review,
without a live backend to catch them empirically the way the pglite suite
catches backend bugs — that asymmetry is exactly why "run it against a real
project" is still the top of the next-steps list, not optional polish.

## First thing to do next

1. Create a Supabase project (or `npx supabase init` + `supabase start` for
   local Docker-based dev).
2. `npx supabase link --project-ref <ref>` then `npx supabase db push`
   (or apply each file in `supabase/migrations/` in order via the SQL
   editor). This should go smoothly — see "Where things stand" above — but
   if something Supabase-specific still trips (a real `pg_cron`/
   `supabase_realtime` behavior difference, an actual Auth schema
   difference from the PGlite stub), fix it and add a regression case to
   `supabase/tests/pglite/run.mjs` if the bug class is generic, or
   `supabase/tests/database/` if it's genuinely Supabase-specific.
3. Run `supabase/seed.sql`, then `supabase/seed_auth_users.sql` (local only
   — see the caveats in that file) to get five working logins
   (alice/bob/carol/david/erin @acme.test, password `Halomanage123!`).
4. `cd web && cp .env.example .env.local`, fill in the project URL/anon key,
   `npm run dev`, sign in as `erin@acme.test` and walk through: Admin →
   Organization (add a department/position/location) → Employees (create
   one, assign it via the new employee detail page, invite them — needs
   `invite-employee` deployed first, `npx supabase functions deploy
   invite-employee`) → Admin → Onboarding (build a template, start it for
   the new hire) → sign in as alice/bob/carol and exercise clock in/out,
   leave request → approval, onboarding task completion, an appraisal
   cycle end-to-end (launch → self-review → supervisor review → manager
   review → acknowledge), a document upload/acknowledge, payroll upload →
   reconcile → approve. This is the first time any of that will have run
   against real Auth/Storage/Realtime — expect to find and fix something.
5. Keep `supabase/tests/pglite/` passing (`cd supabase/tests/pglite && npm
   test`) as you go — it's fast enough to run on every migration change.
   Then work through `supabase/tests/database/employee_rls_test.sql` via
   `npx supabase test db` for the Supabase-CLI-specific layer — see
   "Testing debt" below.

## What's built (backend)

Every module below has tables + RLS + the RPCs a UI needs, per
`docs/ARCHITECTURE.md`'s schema. File: `supabase/migrations/<file>`.

| Module | File | Notes |
|---|---|---|
| Extensions, `private` schema | `..000100` | pgcrypto, citext |
| Organization structure | `..000200` | orgs, org_units (hierarchical), locations, positions |
| Employees | `..000300` | `employees` / `employee_private` split, effective-dated `employee_assignments` |
| RBAC | `..000400` | `app_role`, `app_permission`, `role_assignments`, org-overridable `role_permissions`, `management_scope` (direct supervisor/manager only — **no org-subtree recursion yet**, see below), all `private.*` RLS helper functions |
| Audit | `..000500` | `audit_events`, write-only via `private.log_audit_event()` |
| Attendance | `..000600` | schedules, `attendance_sessions`/`events`/`adjustments`, `clock_in()`/`clock_out()` RPCs, one-open-session DB constraint |
| Leave | `..000700` | configurable `leave_types`/`leave_policies`, ledger-based balances, `submit_leave()`/`decide_leave_request()`/`cancel_leave_request()` — **two-step Supervisor→Manager routing is hard-coded here**, not yet the fully generic cross-module engine (see below) |
| Onboarding | `..000800` | versioned templates/steps, `onboarding_runs`/`tasks`, `start_onboarding()`/`complete_onboarding_task()` |
| Offboarding | `..000900` | same pattern as onboarding; **auto-launches** on `employees.status → 'terminated'` |
| Performance | `..001000` | templates/sections/questions, cycles/instances/reviewers/responses, `launch_appraisal_cycle()`/`submit_appraisal()`/`acknowledge_appraisal()` |
| Documents | `..001100` | versioned docs, acknowledgements, signature_requests (external provider integration is a stub) |
| Payroll import | `..001200` | **Pay Run Results** vs **Compensation Change** kept as separate staging tables per the blueprint's explicit warning; immutable/revisioned batches; effective-dated `employee_compensation`; full RPC set |
| Notifications | `..001300` | in-app table + Realtime; representative triggers wired for leave + onboarding-task-assigned only (see below) |
| Training/assets | `..001400` | courses, certifications, equipment assignment |
| Custom fields | `..001500` | employer-defined extra employee fields |
| Reporting views | `..001600` | all `security_invoker = true` — self-scoping via caller's own RLS |
| Storage | `..001700` | 6 private buckets + path-scoped `storage.objects` policies |
| Employee assignment | `..001800` | `change_employee_assignment()` — atomic close-old/open-new transfer + audit, so admin UI never does a raw two-step update |

Edge Functions (`supabase/functions/`): `invite-employee` (real, deployable),
`payroll-import` (real XLSX/CSV parsing via SheetJS, deployable),
`send-notifications` (real skeleton, needs an email provider wired into
`sendEmail()`), `signature-webhook` (real skeleton, needs a provider chosen
and its actual signature-verification scheme swapped in for the placeholder
equality check).

## What's built (frontend, `web/`)

Auth (sign-in only, no public sign-up), the shared portal shell with a
role-driven nav (now with an "Admin ▾" dropdown, `components/NavDropdown.tsx`,
since the flat list outgrew a single row).

| Area | Routes | What it does |
|---|---|---|
| Self-service | `/dashboard`, `/leave`, `/onboarding`, `/appraisals` (+ `/appraisals/[id]`), `/documents`, `/profile` | Clock in/out, leave request + history + balances, complete assigned onboarding tasks (with dependency ordering enforced), fill/submit a checkpoint review or acknowledge a completed one, view/download/acknowledge documents, edit own profile + private info |
| Supervisor/Manager | `/team` | Pending leave approvals, today's team attendance |
| Admin — configure the product | `/admin/organization`, `/admin/leave-types`, `/admin/onboarding` (+ `templates/[id]`), `/admin/appraisals` (+ `templates/[id]`) | Departments/positions/locations, leave-type builder (all the fields `submit_leave()` reads), onboarding template + step builder with dependency selection, appraisal template + section + question builder, cycle creation + launch |
| Admin — manage people | `/admin/employees` (+ `/admin/employees/[id]`) | Directory, create, invite, **and now**: full assignment history + a transfer/promotion form (`ChangeAssignmentForm` → `change_employee_assignment()`), leave-balance grants |
| Admin — payroll & documents | `/admin/payroll`, `/admin/documents` | Upload/reconcile/approve (aggregate counts only — see below), org-wide or employee-specific document upload |
| Admin — visibility | `/admin/reports` | Headcount, pending leave, onboarding completion, expiring documents/certs/training, recent payroll batches — built entirely on the reporting views from `20260818001600` |

The employee-detail page (`/admin/employees/[id]`) closes what was the
single biggest gap as of the previous session: previously, `NewEmployeeForm`
only ever created a bare `employees` row with no department, position, or
supervisor — meaning leave approval routing had nobody to route to.

**Still no UI for:** offboarding task checklists (backend auto-triggers on
termination and the RPCs exist, but nobody can *see or complete* the
resulting tasks yet — this is now the most glaring remaining gap, more so
than anything above it), training/certifications, asset/equipment
management, custom fields, notification preferences, and per-row payroll
reconciliation drill-in (`resolve_payroll_row_match()`/
`resolve_compensation_row_match()` exist but `/admin/payroll` only shows
aggregate counts, not a way to fix an individual unmatched row without SQL).

## Known simplifications to revisit (don't be surprised by these)

- **`management_scope` covers direct reports only.** The blueprint's "a
  Manager might see the Supervisor's teams underneath them" (org-subtree
  visibility) is not implemented — `private.refresh_management_scope()` in
  `20260818000400_authorization.sql` only inserts direct
  supervisor/manager relationships. Extending it to walk `org_units`
  recursively is additive (bigger query in that one function), not a schema
  change.
- **Leave approval routing is hard-coded** (Supervisor, then Manager if
  unpaid or over a configurable day threshold) inside `submit_leave()`. The
  blueprint calls for one fully generic, employer-configurable routing-rules
  engine reused by leave, attendance corrections, onboarding approvals,
  appraisal approvals, and HR requests. Leave's implementation is the
  reference pattern to generalize — extract a `workflow_rules` /
  `approval_chain_instances` table pair once a second module (attendance
  corrections is the natural next one, since `attendance_adjustments`
  already has an analogous but separately-coded approve/reject flow) needs
  the same shape.
- **Cron-driven automations are mostly unwritten.** `private.create_notification()`
  and the notification tables are ready, and leave/onboarding events are
  wired via row triggers, but the *time-based* automations from
  PRODUCT_BLUEPRINT.md — appraisal-due reminders, overdue escalation,
  certification/document expiry alerts (`expiring_items_v` already exists
  and is exactly what such a job would scan), probation-checkpoint
  triggers, leave accrual — need actual `supabase/functions/` +
  `cron.schedule(...)` wiring once a project exists to schedule against.
- **Compensation-change and payroll-row reconciliation UI is table-only** —
  `resolve_payroll_row_match()`/`resolve_compensation_row_match()` RPCs
  exist for HR to manually match an unmatched row to an employee, but
  `app/(portal)/admin/payroll/` doesn't yet expose the per-row drill-in to
  call them.
- **RLS/RPC behavior has real coverage now (`supabase/tests/pglite/`, 45
  assertions), but it's not exhaustive.** Covered: employee directory scope,
  private-PII isolation, attendance (double clock-in, team visibility),
  leave (full approval chain, wrong-approver rejection, balance ledger),
  payroll (both import types, unmatched-row blocking, cross-employee
  isolation, permission checks), onboarding (dependency ordering,
  auto-completion), and a full appraisal cycle (including the RLS-recursion
  edge case). Not yet covered: attendance correction requests/approvals
  (`attendance_adjustments`), documents/Storage object policies, custom
  fields, training/assets, and multi-org isolation (two different
  `organizations` rows, confirming zero cross-tenant leakage). Extend
  `supabase/tests/pglite/run.mjs` for any of those before trusting them: it
  needs no Docker and already found 4 real bugs (see its header comment).
  `supabase/tests/database/employee_rls_test.sql` is the separate pgTAP
  starter for the Supabase-CLI layer specifically — extend both suites,
  they cover different things (see `supabase/tests/pglite/README.md`).
- **No column-level privilege lockdown yet.** Self-editable columns on
  `employees` are protected by the `employees_protect_columns` trigger
  (raises on protected-field changes without `employee.manage`), which is
  correct but coarser than Postgres column-level `GRANT`s
  (ARCHITECTURE.md mentions this as an option). Current approach is fine;
  revisit only if a real need for finer control shows up.
- **No multi-tenant billing/provisioning flow.** Every table is
  `organization_id`-scoped and RLS-isolated (verified by design, not yet by
  a cross-tenant pgTAP test — add one), but there's no signup flow that
  creates a new `organizations` row; today that's a manual insert. Fine for
  a single-employer deployment; needed before onboarding a second employer.
- **RBAC granularity stops at the role, not the person — the blueprint's
  "HR Admin vs. System Admin" split and dedicated "Payroll Importer" role
  are not actually achievable yet.** `role_permissions` lets an *org*
  override what a role's bundle means, but every person holding that role
  in that org shares the exact same permissions — there's no per-user grant
  table, and `app_role` is a fixed 4-value enum. Giving one specific Admin
  `payroll.import` without giving it to every Admin, or giving a non-admin
  employee *only* `payroll.import`, needs either a `user_permission_grants`
  table (additive grants layered on top of the role bundle in
  `private.has_permission()`) or new `app_role` enum values with their own
  default bundles — sketched but not built. Flagged explicitly to the user
  as a real gap; not addressed in this pass, which prioritized the
  admin-can't-configure-anything gap instead.
- **Appraisal reviewers can't see each other's in-progress responses,
  including in the Manager stage.** This falls directly out of RLS being
  correctly strict (`appraisal_reviewers` policies scope by
  `reviewer_user_id = self`), and is defensible as independent-review
  integrity — but PRODUCT_BLUEPRINT.md's "Manager review/calibration" stage
  name implies the Manager might be expected to see the Supervisor's
  already-submitted review for calibration. Currently only the subject and
  HR see everything, and only once every stage is done. Revisit if calibration
  visibility turns out to matter more than reviewer independence.
- **PostgREST relationship-embedding through a view is a recurring trap —
  hit and fixed three separate times now** (`leave_balance_v` in the
  original build; `employee_current_assignment_v` and
  `onboarding_progress_v` in this session, both caught by code review before
  shipping, not by a live backend). The rule going forward:
  **never write `.select("*, related_table(...)")` against a `_v` view** —
  embedding needs a real foreign-key constraint, which views don't carry
  even when the underlying table does. Query the base table directly, or
  denormalize the needed columns into the view itself (the pattern
  `leave_balance_v` and every view in `20260818001600_reporting_views.sql`
  already follow).
- **Training/certifications and asset/equipment management have zero UI**
  despite full backend support (`20260818001400_training_assets.sql`) —
  not started this pass; same shape as everything else, lowest priority of
  what's left since it wasn't called out as the top gap.

## Roadmap (mirrors PRODUCT_BLUEPRINT.md's MVP → v2 → later phases)

- [x] Phase 0 — repo scaffold, docs, Supabase project structure, Next.js app
- [x] Phase 1 — foundation: org structure, employees, RBAC/RLS, audit
- [x] Phase 1 — attendance (clock in/out, corrections)
- [x] Phase 1 — leave (configurable types, ledger, approval)
- [x] Phase 1 — onboarding engine (templates, versioned runs)
- [x] Phase 1 — performance checkpoints (configurable templates/cycles)
- [x] Phase 1 — documents (versioned, acknowledgements)
- [x] Phase 1 — payroll import (two-type, immutable/revisioned, reconciliation)
- [x] Phase 1 — notifications (in-app + Realtime; email delivery skeleton)
- [x] Phase 1 — reporting views; audit trail
- [x] Phase 1 (bonus, blueprint calls it "High" not "Essential") — offboarding, training/assets
- [x] Validate the full schema + core RPCs against a real Postgres engine (`supabase/tests/pglite/`, now 51 assertions, 4 real bug categories found and fixed)
- [x] Frontend: org-structure + leave-type admin builders, employee assignment/transfer UI, self-service profile
- [x] Frontend: onboarding UI (template builder + employee task view), appraisal UI (template/cycle builder + review flow), documents UI (upload + view + acknowledge), reporting dashboard
- [ ] **Deploy + integration-test against an actual Supabase project (real Auth/Storage/Realtime/Edge Functions)** ← you are here
- [ ] Frontend: offboarding task UI (now the top gap — backend auto-triggers but nothing surfaces the checklist), training/assets UI, per-row payroll reconciliation drill-in, notification preferences
- [ ] RBAC: per-user permission grants and/or HR-Admin/System-Admin/Payroll-Importer role split (see "Known simplifications" — real gap, explicitly flagged, not yet built)
- [ ] Cron jobs: expiry reminders, appraisal reminders/escalation, leave accrual, probation checkpoints
- [ ] Generalize the leave approval-routing pattern into a reusable workflow engine (v2 per blueprint)
- [ ] `management_scope` org-subtree recursion for Manager visibility
- [ ] Expand pgTAP RLS test coverage across all modules
- [ ] Employee Relations Cases (confidential grievance/discipline records) — v2/High in blueprint, not started
- [ ] Announcements, Surveys/Engagement, Recognition — Medium priority, not started
- [ ] Recruitment/ATS — explicitly deferred per blueprint ("does not need to be in the first version")

## Product & architecture reference

Don't re-derive scope decisions — they're already made and documented:
`docs/PRODUCT_BLUEPRINT.md` (what & why) and `docs/ARCHITECTURE.md` (how, on
Supabase). The original two source PDFs are kept at the repo root for
anything the condensed docs don't cover.
