# Halomanage — Technical Architecture (condensed)

Condensed from *Comprehensive HR System Architecture on Supabase — No Payroll Engine*. This is the
implementation reference kept in sync with `supabase/migrations/`; when they disagree, the migrations
(actual running code) win and this file should be updated to match.

## Executive summary

One HR platform, one identity system, one permission/scope model — **not** four separate apps for
Employee/Supervisor/Manager/Admin. The frontend renders a different portal experience per person, but
PostgreSQL **Row Level Security is the only real authorization boundary**. Supabase supplies nearly the
whole backend:

| Supabase capability | Use in Halomanage |
|---|---|
| PostgreSQL | HR system of record — every domain table |
| Auth | Login (password/magic link/OTP), MFA, SAML SSO for enterprise orgs |
| Row Level Security | Employee/Supervisor/Manager/Admin authorization, enforced in the DB |
| Storage (private buckets) | Contracts, certificates, payroll workbooks, appraisal attachments |
| Realtime | Live dashboard updates, attendance status, notifications — **not** the attendance system of record |
| Edge Functions | Privileged ops: invitations, Excel/XLSX parsing, external notification delivery, e-signature webhooks |
| Cron (`pg_cron`) | Accruals, reminders, appraisal-cycle generation, overdue scans |
| Queues | Reliable async delivery/import orchestration |
| Vault / secrets | External API credentials |

## Foundational design decisions

- **Organization-aware from day one.** Every HR-domain row carries `organization_id`, even for a
  single-tenant deployment — multi-employer support later shouldn't require a schema rewrite.
- **`auth.users` (login identity) ≠ `employees` (HR record).** `employees.user_id` is nullable so HR
  can create a pre-hire employee before an account exists; linked on invitation acceptance.
- **Effective-dated / historical, never overwritten in place:** compensation, position, department,
  manager, schedule, and leave-policy assignment all need history so past reports stay correct after
  an employee moves. `employee_assignments` rows are opened/closed with `start_date`/`end_date`
  rather than mutated.
- **Normalized schema.** Employment, position, leave, attendance, payroll and performance each have
  independent history/access/retention needs — not one giant `employees` table.
- **Sensitive data is column- and table-separated**, not just permission-checked inline: ordinary
  directory info (`employees`) vs. PII (`employee_private`) vs. payroll (`payroll_import_rows`) vs.
  audit (`audit_events`) are separately grantable.

## Auth strategy

- **Two deliberate entry paths:** an organization owner can create a new workspace through `/signup`;
  ordinary employees cannot join an organization through public signup. The owner flow creates the
  Auth identity first and then calls the guarded `create_organization_workspace()` RPC to atomically
  create the organization, owner employee record, Admin role, and audit event.
- Employee access is employer-controlled. An Admin creates the `employees` row first, then the
  server-side `invite-employee` Edge Function performs the privileged Auth admin call, links
  `employees.user_id`, and records an audit event. Service-role/secret credentials never reach the
  browser.
- Standard orgs: email + password or magic link/OTP. Security-conscious orgs: require MFA (TOTP or
  phone) for Admins/Managers. Enterprise: SAML 2.0 SSO.
- Extremely sensitive actions (payroll import, role changes, bulk export, opening restricted
  documents) should be able to require an MFA-authenticated `aal2` session, checked directly in RLS
  via the JWT `aal` claim.

## RBAC model

Broad roles: `employee`, `supervisor`, `manager`, `admin` — stored per-organization, per-scope in
`role_assignments` (a person can hold more than one role/scope, e.g. Employee everywhere + Supervisor
over one team). Underneath, granular permissions (`app_permission` enum) such as
`employee.read_team`, `leave.approve_direct_reports`, `payroll.import`, `payroll.read_org`,
`roles.manage`, `documents.manage_org` — so e.g. Admin can be split into HR Admin vs. System Admin
without new code. **Manager/Supervisor never implies payroll or confidential-document access.**

RLS enforces scope via a `private.has_org_role()` / `private.current_employee_id()` helper (SQL,
`SECURITY DEFINER`, `search_path = ''`, in a non-exposed `private` schema) plus, at scale, a
precomputed `management_scope(actor_user_id, employee_id)` table so supervisor/manager checks are an
indexed `EXISTS` instead of a recursive org-tree walk.

## Domain model (see migrations for authoritative DDL)

```
organizations → org_units (hierarchical) → positions
employees (+ employee_private) → employee_assignments (effective-dated: org_unit, position,
  supervisor, manager, location) → role_assignments (scoped RBAC)

attendance_sessions / attendance_events   (append-only; corrections are additive rows)
leave_types / leave_policies / leave_requests / leave_ledger   (ledger, not a mutable balance int)
onboarding_templates(+versions/steps) / onboarding_runs / onboarding_tasks
appraisal_templates / appraisal_cycles / appraisal_instances / appraisal_responses
documents / document_versions / document_acknowledgements
payroll_import_batches / payroll_import_rows / payroll_column_maps   (immutable, revisioned)
employee_compensation (effective-dated) / employee_compensation_components (effective-dated)
pay_groups / pay_calendars / pay_periods / pay_grades / compensation_components /
  compensation_change_reasons   (see "Compensation & Pay Administration" below)
notifications / notification_preferences
audit_events
```

Full field lists are in the migrations themselves (each migration file has a header comment pointing
back to the relevant section of the architecture PDF).

## Non-negotiable implementation rules

1. Attendance timestamps are set by `SECURITY INVOKER` RPCs (`clock_in()`, `clock_out()`) using
   `now()` server-side — never a client-writable column. A partial unique index enforces one open
   session per employee at the database level, not just a disabled button.
2. Never grant direct `UPDATE` on `attendance_sessions.clock_in_at`/`clock_out_at` — state
   transitions only happen through RPCs.
3. Payroll import is **strictly two distinct concepts**: *Pay Run Results Import* (informational,
   period-scoped) vs. *Compensation Change Import* (changes the ongoing rate) — never the same table
   or the same upload flow. The system never computes gross→tax→net; it only stores and reconciles
   what the external payroll run produced.
4. Payroll rows match employees by immutable `employee_number`/`external_payroll_id`, never by name.
   Unmatched rows block posting; nothing silently creates a new employee from a spreadsheet row.
5. Every exposed reporting view is created `with (security_invoker = true)` — a bare view owned by a
   privileged role otherwise bypasses RLS.
6. Every exposed table has RLS **enabled and has policies**; grants and RLS are separate layers and
   both must be least-privilege. No `service_role`/secret key ever ships to browser or mobile code.
7. Storage buckets holding HR documents/payroll files are **private**; access goes through Storage
   RLS policies keyed off `{organization_id}/{employee_id}/...` path segments, never a public bucket.
8. Index every column an RLS policy filters on (`organization_id`, `user_id`, `employee_id`,
   `manager_employee_id`, `supervisor_employee_id`, `org_unit_id`, the `role_assignments` and
   `management_scope` lookup columns) and wrap `auth.uid()` in `select` inside policies per Supabase's
   RLS performance guidance.
9. Three separate audit layers: application `audit_events` (business actions), Supabase Auth audit
   logs (authentication events, automatic), and — optionally — PGAudit/Platform audit logs. Don't
   conflate them.
10. Supabase's own DB backups **do not cover Storage objects** — document/file backup needs an
    independent replication story, tracked separately from Postgres PITR.
11. Compensation is structure and scheduling, never calculation. Halomanage stores pay type, rate,
    frequency, pay groups/calendars/periods, grades, and components, and can export them to an
    external payroll system — it never computes gross-to-net, tax, or statutory deductions. Any
    change here that starts computing money belongs in a payroll provider integration, not this schema.

## Compensation & Pay Administration

Added 2026-08-29, extending the original `employee_compensation` table rather than replacing it —
see `supabase/migrations/20260829100000_compensation_permissions_enum.sql` and
`20260829110000_compensation_pay_administration.sql` for the authoritative DDL.

**What changed and why.** The original `employee_compensation.pay_frequency` column conflated
compensation *basis* (`hourly`, `annual`) with actual payment *cadence* (`weekly`, `biweekly`,
`semimonthly`, `monthly`) in one check-constrained column. The migration splits these into:

- `pay_type` — the compensation basis (`salaried`, `hourly`, `daily`, `weekly_rated`,
  `monthly_rated`, `piece_rate`, `commission`, `contract_fixed_fee`, `other` + `pay_type_other_label`
  for anything not on the list).
- `rate_unit` — what the rate amount is *per* (`hour`, `day`, `week`, `month`, `year`, `piece`,
  `contract`). Deliberately not cross-validated against `pay_type` by a DB constraint — the
  combinations that make sense in practice are broader than a rigid pairing table would capture; the
  Change Compensation form suggests sensible defaults instead.
- `pay_frequency` — now cadence-only (`weekly`, `biweekly`, `semimonthly`, `monthly`, `quarterly`,
  `annual`, `custom`).

Every pre-existing row was backfilled with a best-effort `pay_type`/`rate_unit` inferred from its old
`pay_frequency` value (this is inherently lossy — the old schema never recorded enough to reconstruct
perfectly) and flagged `needs_review = true`, surfaced as a prompt on the Compensation tab rather than
silently guessed and left unmarked. One `COMPENSATION_SCHEMA_BACKFILLED` audit event was logged per
affected organization.

**New structural tables**, all organization-scoped with RLS enabled, all following the existing
effective-dating pattern where relevant:

- `pay_groups` — currency, cadence, external payroll/provider reference, and which `pay_calendar_id`
  currently governs it.
- `pay_calendars` + `pay_periods` — the actual period rows (start/end, timesheet cutoff, manager
  approval deadline, payroll export deadline, pay date, status). `generate_pay_periods()` is pure date
  arithmetic (weekly/biweekly/semimonthly/monthly/quarterly/annual cadences) — scheduling, never a
  payroll calculation. HR can hand-edit any generated period afterward (e.g. to shift a pay date
  around a holiday).
- `pay_grades` — name/code/level/location/currency, minimum/midpoint/maximum, effective-dated;
  `positions.pay_grade_id` links a position to one (positions themselves stay a flat lookup table —
  effective-dated position-to-grade history is a documented future enhancement, not built here).
- `compensation_components` — configurable pay elements (allowances, premiums, bonuses, commission),
  each recurring-or-one-time, fixed-amount-or-percentage, employee-payable-or-employer-cost, with an
  external payroll code. Never computes tax or net pay from any of this.
- `employee_compensation_components` — effective-dated component assignments per employee. A
  *recurring* component can only have one open assignment per employee at a time (enforced by
  trigger, since a partial unique index can't reference another table's `recurrence` column to decide
  whether the rule even applies); a *one-time* component (a single bonus) has no such "current" concept.
- `compensation_change_reasons` — an organization-configurable lookup, not a fixed enum, managed from
  Compensation Settings.

**The manual Change Compensation workflow** (`change_employee_compensation()`) closes the employee's
current open `employee_compensation` row (`end_date = new_effective_date - 1`) and inserts the new one
in the same transaction, exactly like `employee_assignments`/`set_member_role()` already do — history
is never overwritten. A **separate two-step submit-then-approve queue** ("submit/approve where an
approval workflow is enabled") was scoped out of this pass: either `compensation.manage` or
`compensation.approve` can call the RPC directly today, and the change takes effect immediately. This
is a deliberate, documented scope cut, not an oversight — building a first-class pending-approval
state machine is reasonable follow-up work layered onto the same table.

**Permissions.** `employee.manage` is no longer sufficient to read or write compensation — see the new
`app_permission` values: `compensation.read_self/_team/_org`, `compensation.manage`,
`compensation.approve`, `compensation.manage_structure`, `pay_calendar.read/.manage`, `payroll.export`.
`compensation.manage_structure` (configuring pay groups/grades/components) is deliberately a
*different* grant from `compensation.manage`/`.approve` (changing one employee's actual pay) — holding
one implies nothing about the other. Supervisors and Managers get **no** compensation permission by
default, matching the existing rule that Supervisor/Manager never implies HR/payroll visibility;
`compensation.read_self` is the one exception, re-declared for every role (employee/supervisor/
manager/admin) individually, because being a Supervisor never removes your own right to see your own
pay — roles in this schema don't inherit from one another, so each one repeats its own baseline
self-service permissions (the same pattern `payroll.read_self` already used).

**`get_effective_permissions(org_id)`** is new: it returns the caller's full resolved permission set
for an organization, exposed through `session.permissions` (`web/lib/session.ts`) and checked via
`sessionCan(session, "...")`. This is the fix for a wider, pre-existing pattern: every admin page in
the app gated on `session.roles.includes("admin")` rather than the actual permission its RPCs enforce
— `/admin/payroll` (checking the Admin role while its RPCs enforced `payroll.import`) was the
concrete example that surfaced it, now fixed; the new Compensation pages are the first to be built
permission-first from the start. Other existing admin pages still gate on role and are unchanged —
a broader migration of every route guard to `sessionCan()` is follow-up work, not done here.

**Payroll import linkage.** `payroll_import_batches` gained nullable `pay_group_id`/`pay_period_id`
columns, additive only — existing approved batches are untouched, and nothing about batch immutability
changed (a correction is still a new batch with `supersedes_batch_id` set, never an in-place edit).

**Explicitly deferred, not silently skipped** (see the phased audit this responds to for the full
plan): wiring `build_payroll_export()`'s regular/overtime/paid-leave/unpaid-leave hour classification
to real attendance and leave data (`attendance_sessions` has no `worked_hours`/overtime classification
today — that needs its own design, not a guessed join); a dedicated Pay Ranges UI beyond what
Compensation Settings already exposes for Pay Grades; a Payroll Provider Mappings admin page (the
underlying `payroll_column_maps` table already exists and is functional, just without its own
dedicated screen); compensation reporting (hourly-vs-salaried mix, compa-ratio, range penetration,
FTE cost, etc.).

## Suggested Edge Function / RPC surface (keep this list short — most CRUD is plain Data API + RLS)

| Name | Kind | Purpose |
|---|---|---|
| `invite-employee` | Edge Function | Privileged Auth invite + `employees.user_id` link |
| `clock_in` / `clock_out` | Postgres RPC | Atomic attendance state transition |
| `request_attendance_adjustment` / `decide_attendance_adjustment` | RPC | Correction workflow |
| `submit_leave` / `decide_leave_request` | RPC | Validate + transactional approval |
| `start_onboarding` / `complete_onboarding_task` | RPC/Edge | Instantiate template, validate step |
| `launch_appraisal_cycle` / `submit_appraisal` | RPC | Create instances, lock response stage |
| `payroll-import` | Edge Function | Parse/validate uploaded workbook into staged rows |
| `approve_payroll_import` | RPC | Atomically activate a reconciled batch |
| `send-notifications` | Edge Function | External email/SMS/push delivery |
| `signature-webhook` | Edge Function | Receive external e-signature status |
| `export-report` | Edge Function | Sensitive/large exports (CSV-injection-safe) |

## Repo ↔ architecture mapping

```
supabase/migrations/   ↔ "Core schema comparison" + "Sample Supabase SQL foundation" sections
supabase/functions/    ↔ "Suggested minimal Edge Functions / RPC surface"
supabase/tests/        ↔ "Testing strategy" (pgTAP: RLS denial tests are first-class product code)
web/                   ↔ "Portals, RBAC and RLS authorization" (four portals, one data model)
```
