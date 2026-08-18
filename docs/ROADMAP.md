# Halomanage — Build Roadmap & Status

Living document. Update this whenever you finish or start a chunk of work —
it's the thing a fresh session (human or agent) should read first to know
what's real, what's stubbed, and what to do next. Last updated: 2026-08-18.

## Where things stand right now

**Backend (`supabase/migrations/`, `supabase/functions/`): the full MVP data
model + core business logic exists, and has been validated against a real
(if embedded) Postgres engine — not just read for syntax.** This repo has
never been deployed to an actual Supabase project (none has been created
yet), but every migration has been run end-to-end against
[PGlite](https://pglite.dev) (Postgres-in-WASM) via
`supabase/tests/pglite/`, which applies all 17 migrations, seeds five RLS
test personas, and runs 45 assertions with RLS actually enforced across
attendance, leave, payroll import (both flavors), onboarding, and a full
appraisal cycle — including deliberate negative tests (wrong person tries to
approve, unrelated employee tries to read a record). **That process found
and fixed four real bugs** before this was ever "done": a PL/pgSQL
INTO-list error, `management_scope` never refreshing when an account is
linked after its reporting-line assignment already exists (the realistic
order of operations), a missing RLS policy that silently emptied
`current_payroll_records` for ordinary employees, and infinite RLS
recursion from mutual cross-table subqueries in two places. Full detail is
in the comment block at the top of `supabase/tests/pglite/run.mjs` — read it
before assuming any of those classes of bug can't recur elsewhere.

What that suite does *not* cover — because PGlite stubs Auth/Storage rather
than reproducing them — is real Supabase Auth flows (magic links, MFA,
SAML), Storage signed URLs, Realtime, and the Edge Functions. Those need an
actual Supabase project. **The first real task in this project is standing
up one and deploying to it** — treat that as the next integration-test
layer, not a formality; it's plausible (if less likely than before this
validation pass) that something Supabase-specific still needs a small fix
once real Auth/Storage/Realtime are involved instead of stubs.

**Frontend (`web/`): builds and typechecks clean** (`npm run build` passes)
against Next.js 15 / React 18 / TypeScript strict mode. It has **not** been
run against a live backend, so runtime behavior (does the RPC call shape
actually match, does a Realtime subscription need adding, etc.) is
unverified beyond what static types and the backend's own RPC contracts
(now behaviorally tested) suggest.

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
   `npm run dev`, sign in as `erin@acme.test` and walk through: create an
   employee → invite them (needs `invite-employee` deployed,
   `npx supabase functions deploy invite-employee`) → sign in as
   alice/bob/carol and exercise clock in/out, leave request → approval,
   payroll upload → reconcile → approve.
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

Edge Functions (`supabase/functions/`): `invite-employee` (real, deployable),
`payroll-import` (real XLSX/CSV parsing via SheetJS, deployable),
`send-notifications` (real skeleton, needs an email provider wired into
`sendEmail()`), `signature-webhook` (real skeleton, needs a provider chosen
and its actual signature-verification scheme swapped in for the placeholder
equality check).

## What's built (frontend, `web/`)

Auth (sign-in only, no public sign-up), the shared portal shell with
role-driven nav, Employee dashboard (clock in/out, leave balances, recent
requests, notifications), Leave (submit + history), Team (Supervisor/Manager:
pending approvals + today's attendance), Admin → Employees (directory,
create, invite), Admin → Payroll (upload, reconciliation status, approve).

No UI yet for: onboarding (template builder or task checklist), offboarding,
performance/appraisals, documents/acknowledgements, training/certifications,
asset management, org-structure editor, leave-type/policy builder, custom
fields, reporting dashboards beyond what's on the Team page, employee
detail/history page, notification preferences. The backend for all of these
already exists — each is a same-shaped addition to `app/(portal)/`
following the pattern in `app/(portal)/leave/`.

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
- [x] Validate the full schema + core RPCs against a real Postgres engine (`supabase/tests/pglite/`, 45 assertions, 4 real bugs found and fixed)
- [ ] **Deploy + integration-test against an actual Supabase project (real Auth/Storage/Realtime/Edge Functions)** ← you are here
- [ ] Frontend: onboarding UI, appraisal UI, documents UI, org-structure/leave-policy/appraisal-template admin builders
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
