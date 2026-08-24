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
