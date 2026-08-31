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

## Session experience: role changes, schedules, leave, pay visibility, branding

Added 2026-08-29. A user audit surfaced several places where a role change or
a piece of admin configuration had no visible effect anywhere in the product.
Root causes, in order of how much they explain:

1. **`session.roles` never expired.** `role_assignments` is effective-dated —
   a role change closes the old row (`valid_until`) and opens a new one, the
   row is never deleted. `getCurrentSession()` was reading every row for a
   user regardless of validity, so a demoted admin kept looking like an admin
   in navigation indefinitely, and a promotion could look like "nothing
   happened" if the stale role already implied the same nav visibility. Fixed
   by filtering on `valid_from`/`valid_until` the same way RLS and
   `get_effective_permissions()` already did — the database was never wrong,
   only the browser shell's own read of it. `(portal)/layout.tsx`'s
   `canSeeTeam`/`canSeeAdmin` now also read `sessionCan()` instead of
   `session.roles.includes(...)`, for the same reason `admin/payroll` needed
   that fix earlier.
2. **A role change never assigned anyone to be led.** Promoting someone to
   Supervisor/Manager grants the *capability* to see a team; nothing ever
   decided *whose* team. `set_employee_reporting_scope()`
   (`20260829143000_role_reporting_scope.sql`) is the missing piece — an
   audited RPC that assigns/removes direct reports through the same
   effective-dated `employee_assignments` pattern, with a Team hub UI at
   `admin/employees/[id]` (`ReportingScopeForm`) sitting right next to the
   role selector.
3. **Only the founder ever got schedule/leave defaults.** Starter-workspace
   provisioning enrolled the first employee in a default work schedule and
   leave policies; every employee invited afterward got neither.
   `20260829143521_schedule_leave_provisioning.sql` turns that into standing
   behavior — `provision_employee_defaults()` runs on every activation (and
   once, idempotently, for every existing active employee), backed by
   `create_work_schedule()`/`assign_employee_schedule()` audited RPCs and a
   richer Team hub (`(portal)/team`) that surfaces schedule and leave-balance
   gaps per person instead of silently showing nothing.
4. **Compensation had a database but no employee-facing screen.** The
   Compensation & Pay Administration schema (see above) was admin-only.
   `(portal)/pay` is the missing "My pay" page — current rate, next pay date,
   compensation history, active components, and the compensation calendar —
   gated on `compensation.read_self`, which every role already holds by
   default. It required a genuinely new access path:
   `20260829153000_compensation_employee_self_service.sql` adds RLS letting
   an employee read the specific pay group/calendar/periods their *own*
   effective compensation links to (previously only reachable through admin
   permissions), and `create_pay_calendar()` fixes a real two-write race
   (creating a calendar and wiring `pay_groups.pay_calendar_id` used to be
   two separate browser calls that could disagree if the second one failed).
5. **Company profile and portal branding had no UI.** Organization contact/
   address/legal-name fields and per-organization portal branding (title,
   message, logo, colors) are real, typed columns and a dedicated
   `organization_branding` table (`20260829142948_employee_experience_branding.sql`,
   replacing what used to live in `organizations.settings` JSON), reachable
   through `update_organization_profile()`/`update_organization_branding()`.
   `CompanyProfileForm` and an extended `OrganizationPortalCard` (logo
   upload to the public `organization-branding` bucket, color pickers) are
   the admin UI; the public `/portal/[slug]` sign-in page now actually
   renders the uploaded logo and applies the chosen colors instead of a
   generic initials badge on the default palette.

Two bugs specific to this batch, both fixed, both worth remembering:

- **`GRANT ... ON ALL TABLES IN SCHEMA public`** only covers tables that
  exist *at the moment it runs* — a table created in a later migration is
  not retroactively covered and needs its own explicit grant (RLS policies
  alone are moot without the underlying table privilege). Verified this
  project's compensation tables were unaffected in practice (Supabase's
  default-privileges provisioning already covered them), but the pglite
  suite now asserts `has_table_privilege(...)` for every compensation table
  directly, so a future migration that forgets this can't pass silently.
- **`employee_migration_center` (2026-08-26) and its citext follow-up fix
  (2026-08-27) were committed but never applied to the live database** —
  found via `admin/setup` querying a table, `employee_import_batches`, that
  simply didn't exist in production. A committed migration file is not the
  same thing as a deployed one; always cross-check
  `supabase_migrations.schema_migrations` against the migrations directory
  after a gap in deploys, not just before/after the migrations you meant to
  ship that session.

## Rewards & Recognition Marketplace (P0)

Added 2026-08-30. Deliberately not built around any single gift-card API. A
detailed proposal centered the design on Tremendous/Tango/Giftbit as the
foundation; the actual requirement is broader and the schema reflects the
correction: **fulfillment is a property of a vendor, and every organization
owns its own vendor list** — "Fontana Pharmacy" (a local supplier, fulfilled
by HR handing over a voucher) is exactly as first-class as an API-integrated
provider, not a fallback case bolted onto a gift-card-API-shaped schema.

- `reward_providers` — platform infrastructure (`private.is_platform_staff()`
  gated writes, configured from `/platform/reward-providers`), not tenant
  data. `'manual'` is seeded active by default and requires no integration.
  An `automatic_api` provider (Tremendous, Tango, Giftbit, or anything else)
  is real infrastructure metadata only — key, name, active flag — and is
  **not usable until a platform administrator activates it**, which is only
  meaningful once a real API integration with credentials in Edge Function
  secrets actually exists (this table never stores credentials). A trigger
  enforces this: a vendor cannot be created against an inactive
  `automatic_api` provider, so an org can never configure a reward that
  silently can't be fulfilled.
- `reward_vendors` / `reward_products` — organization-owned. Each org
  curates its own vendor list and, per vendor, its own reward catalog with a
  points cost and optional tracked inventory (`inventory_quantity` — `null`
  means unlimited/digital, a number means physical stock that
  `redeem_reward()`/`cancel_redemption()` decrement/restore).
- **A real points economy**, not a price tag: `employee_points_ledger` is
  append-only (same pattern as `leave_ledger`), summed by
  `employee_points_balance_v` (same pattern as `leave_balance_v`).
  `award_employee_points()` is how points enter the system — gated on
  `rewards.award_points`, admin-only by default. Peer-to-peer recognition
  (an employee awarding points to another) is a natural extension of the
  same ledger and RPC shape but is explicitly not built in this pass — this
  phase only covers admin/manager-granted recognition.
- `reward_redemptions` captures `fulfillment_type` at redemption time (not
  re-derived from the vendor later), so a vendor's provider changing after
  the fact never rewrites what already happened. `redeem_reward()` serializes
  each employee's balance check-and-spend with an advisory lock (mirroring
  `set_member_role()`'s pattern) so two concurrent redemptions can't both
  pass a balance check against the same starting total.
- Permissions: `rewards.read_self`/`redeem_self` are in every role's default
  bundle (re-declared per role, same reasoning as `compensation.read_self`);
  `rewards.award_points`/`manage_catalog`/`fulfill` default to admin only —
  a Manager/Supervisor gets none of them until an org explicitly grants it.
- Gated behind the `rewards_marketplace` platform feature
  (`organization_feature_overrides`) — the exact mechanism the Platform
  Console already had, not a new flag system.

Explicitly deferred, not silently skipped: a real `automatic_api` connector
implementation (an Edge Function calling out to a chosen provider — no
vendor has been contracted yet, so nothing to integrate against), peer-to-
peer recognition, redemption budgets/limits, and reporting/analytics on
rewards usage.

**Follow-up pass, same day:** a second proposal re-specified the same
module in `vendors`/`rewards`/`points_ledger` naming and a somewhat finer
permission split (`vendors.manage`/`rewards.manage`/`redemptions.manage`).
Deliberately did not rename anything already shipped and tested — the
existing `reward_*`-prefixed names already match this codebase's
module-prefix convention, and renaming a live, deployed schema for
naming-preference reasons alone would be pure churn. Kept the existing
`rewards.manage_catalog`/`.fulfill` split rather than fragmenting further
into vendor-vs-product permissions, since nothing calls for that
granularity yet and `ALTER TYPE ADD VALUE` is one-way. What *was* genuinely
missing, and got built:

- `fail_redemption()` — the explicit refund-and-restock transition for
  when an automatic fulfillment attempt errors (distinct from `cancel_
  redemption()`, which is "someone decided not to," not "we tried and it
  failed"). Built and tested ahead of any real vendor integration
  existing, so the failure path isn't improvised the day it's first needed.
- Every status-changing action (`award_employee_points`, `redeem_reward`,
  `fulfill_redemption`, `cancel_redemption`, `fail_redemption`) now calls
  the pre-existing `private.create_notification()` helper — the same
  in-app-now/email-via-the-existing-Edge-Function pattern every other
  module already uses (see `notify_leave_decided()` for the precedent).
  Nothing new to build for delivery; this was purely a missing call site.
- A "Points history" ledger view on the employee Rewards page (raw award/
  redemption/refund entries, distinct from redemption-specific history)
  and `image_url` rendering in both the admin and employee catalogs — the
  column already existed and was never read anywhere.

## Peer-to-peer recognition

Added 2026-08-30. The explicit brief for this pass drew one hard line: an
employee's **redeemable points balance** (what `redeem_reward()` spends
against) and an employee's **recognition giving allowance** (what they can
give away to coworkers) are different pools, tracked differently, and must
never be conflated. A giver's allowance is not a balance sitting in a table
row to be debited — it's a monthly quota, computed on demand as
`sum(recognitions.points_given)` for that giver since the start of the
current month, checked against `organization_recognition_settings
.monthly_point_allowance`. Nothing is pre-funded or carried over; there is
no "recognition wallet" to run out of sync with reality.

- `organization_recognition_settings` (one row per org, seeded by a
  new-org trigger the same way `organization_feature_overrides` and other
  per-org defaults are) holds `monthly_point_allowance` (0 = kudos-only —
  the default, so recognition works with zero configuration and zero
  points-budget risk on day one), an optional `max_points_per_recognition`
  cap, an optional `max_recognitions_per_day_per_giver` cap, and
  `default_visibility`. All four are editable by whoever holds
  `rewards.manage_catalog` — no new permission for this, since "who can
  configure the rewards program" is already exactly the right audience.
- `recognition_values` — an org-scoped lookup (e.g. "Teamwork", "Above &
  Beyond") seeded with four starters per existing org. Kept intentionally
  simple (name + description + active flag), matching `leave_types`'
  shape rather than introducing a new lookup-table pattern.
- `recognitions` — `giver_employee_id`, `recipient_employee_id`,
  `recognition_value_id`, a 1-500 character `message`, optional
  `points_given` (default 0), and `visibility` (`public`/`private`). A
  `CHECK (giver_employee_id <> recipient_employee_id)` makes
  self-recognition structurally impossible, not just application-checked.
  RLS lets an org member read any `public` recognition, read their own
  (given or received) regardless of visibility, and lets anyone holding
  `rewards.award_points` read everything — there is deliberately no direct
  `insert`/`update`/`delete` grant on this table for anyone; the only way a
  row is created is through `give_recognition()`.
- `give_recognition(p_recipient_employee_id, p_message,
  p_recognition_value_id, p_points, p_visibility)` is where every rule from
  the brief is enforced, in one transaction:
  - Resolves the caller via `private.current_employee_id()` — a terminated
    or unassigned caller has no employee id and is rejected outright.
  - Requires `recognition.give` (granted to all four roles by default —
    recognition is a peer behavior, not a management privilege).
  - Recipient must be active, in the same organization, and not the giver.
  - If `p_points > 0`: refuses outright when the org's monthly allowance is
    0 (kudos-only mode), enforces `max_points_per_recognition` on this one
    gift, then takes `pg_advisory_xact_lock(hashtextextended(giver_id, 92))`
    and sums the giver's `points_given` across `recognitions` since the
    start of the month to enforce the *remaining* monthly allowance — the
    advisory lock closes the same check-and-spend race window
    `redeem_reward()` already closes for balance checks, applied here to a
    computed-on-read quota instead of a ledger balance.
  - Independently enforces `max_recognitions_per_day_per_giver` via a count
    of the giver's recognitions since midnight, regardless of points —
    this is the anti-abuse control for pure kudos-spam, not just
    points-budget protection.
  - On success: inserts the `recognitions` row; if points were given,
    inserts a positive `employee_points_ledger` entry
    (`entry_type = 'recognition'`, `related_recognition_id` set) — so a
    recognition with points shows up in the same "Points history" view as
    an admin-granted award or a redemption, from the recipient's side,
    without the giver's allowance ever touching the ledger; calls
    `private.create_notification()` (`type = 'recognition.received'`,
    linking to `/recognition`); and logs a `RECOGNITION_GIVEN` audit event
    — recognition gets the same audit trail every other write path in the
    system has, not a bespoke one.
- `/recognition` (new employee-facing page, gated on `recognition.give`)
  shows the caller's remaining monthly allowance, a form to recognize a
  coworker, and a feed of visible recognitions (their own given/received
  plus every public recognition in the org). Admins configure the program
  from the existing `/admin/rewards` page, in a new "Peer-to-peer
  recognition" settings section and a "Recognition values" manager — kept
  on the same page as the reward catalog rather than a new admin route,
  since it's the same audience configuring the same overall program; the
  page now also relabels the pre-existing admin-grant form
  "Admin-granted points" so the two point-granting paths (admin-granted
  vs. peer-given) read as clearly distinct in the UI, not as duplicates.
- The reward catalog / vendor model (`reward_providers`, `reward_vendors`,
  `reward_products`, `reward_redemptions`) is untouched by this pass, as
  directed — recognition and redemption share only the points ledger and
  the notification helper, nothing else.

Explicitly deferred, not silently skipped: recognition-triggered badges or
levels, an admin approval step before a recognition posts (every gift is
final and immediate, same as an admin-granted point award), and reporting/
analytics on recognition volume or program health beyond the raw feed.

## Custom organization roles, and the route-guard audit that made them matter

Added 2026-08-31. Prompted by a direct user finding while auditing the
Overview tab: there was no "HR" role, and no page anywhere to configure
what a role can actually do. Investigating turned up two separate problems
that both needed fixing together — a schema gap (no way to create a named
role beyond the fixed 4) and a much bigger latent bug (most of the app
gated on a literal role string instead of the permission its own RPCs
enforced, which would have made a permission editor pointless even after
building one).

**The route-guard bug, fixed first because it's a prerequisite:**
`sessionCan()` already existed (added for the compensation module, with a
code comment explicitly warning about this exact pattern) but was never
rolled out past a handful of pages. 22 call sites across ~18 files —
every `/admin/*` page's access gate, plus several employee-facing "here's
an admin shortcut" links — still checked `session.roles.includes("admin")`
literally instead of the specific permission each page's own RPCs already
enforced (`documents.manage_org` for the document library,
`appraisal.manage_cycles` for performance setup, `reports.org` for
reports, and so on). This meant an org's permission customization —
built-in or custom — could never actually change who gets into a page,
only what they could do once the literal-role check already let them in.
All 22 sites now check the specific permission via `sessionCan()`,
matching the pattern the compensation module already established.

Two more bugs surfaced by the same audit, both in `(portal)/layout.tsx`:
`session.roles.length === 0` was used as "does this person hold any role
at all" to decide whether to bounce someone into workspace repair — but
`session.roles` only ever holds the 4 built-in values, so a person holding
*only* a custom role would look roleless and get stuck in a repair loop
forever, never reaching a single page. Fixed by checking the new
`session.roleLabels` (below) instead, which covers both. Separately,
`canSeeAdmin` (whether the "Manage" nav section renders at all) checked
only `organization.manage` — so a custom role granted, say, just
`roles.manage` or `payroll.import` would never see the section header
needed to reach the one admin page it's actually authorized for. Widened
to an OR across every permission that gates at least one admin page.
Deliberately not fixed in this pass: `adminItems` itself is still an
unfiltered flat list once `canSeeAdmin` is true, so a narrowly-scoped
custom role sees nav entries it can't open — clicking one safely redirects
to `/dashboard` via that page's own gate rather than erroring, so this is
a cosmetic rough edge (a stray dead link), not a security or correctness
gap; per-item nav filtering is a reasonable follow-up, not done here.

**Schema** (`20260831100000_custom_organization_roles.sql`): the 4
built-in roles remain permanent, unrenamed, and un-deletable — several
places in the schema (starter-workspace seeding on first admin, the
supervisor/manager/admin tiering in `set_employee_reporting_scope()`)
legitimately mean "the literal built-in Admin/Manager/Supervisor role,"
not "whichever role has the most permissions," and rewriting those to be
fully generic wasn't worth the risk for what they actually do. Custom
roles sit alongside them instead of replacing them:

- `organization_roles` — an org's own named roles (id, name, description,
  is_active). `role_assignments` and `role_permissions` both gain a
  nullable `custom_role_id` FK alongside the now-nullable `role` enum
  column, with a `CHECK` that exactly one of the two is set per row —
  every assignment or permission-bundle row is either built-in or custom,
  never both, never neither.
- `private.role_grants_permission()` / `private.custom_role_grants_permission()`
  — the override-aware "does this role grant this permission" resolution,
  factored out so `has_permission()`, `get_effective_permissions()`, and
  the invariant checks below all resolve it identically instead of
  duplicating the logic a third time.
- `private.user_has_permission(org, user_id, permission)` — the same
  check `has_permission()` already did, but parameterized by user instead
  of always `auth.uid()`, so the "does anyone else still hold this"
  invariant checks below can ask the question about a *different* org
  member than the caller.
- Direct writes to `role_permissions` were technically RLS-permitted
  before (an unused policy — no UI ever exercised it); now revoked in
  favor of audited RPCs only, matching `role_assignments`' already-hardened
  pattern from the lifecycle RBAC migration.

**The "last person able to manage roles" invariant, generalized.**
`set_member_role()`/`terminate_employee()` previously checked literally
`role = 'admin'` to stop an org's last administrator from being demoted,
expired, or terminated out from under it. That's now resolved through
`roles.manage` permission ownership instead — which behaves identically
for every org that hasn't customized anything (only the default Admin
bundle grants `roles.manage`), but now also protects an org that granted
`roles.manage` to a custom role instead of relying on built-in Admin. The
same protection was added at the *bundle* level in
`set_organization_role_permissions()`/`set_default_role_permissions()`:
stripping `roles.manage` from a role's permission set is blocked if doing
so would leave the organization with nobody able to manage roles, since
that's a single action that can affect every current holder of that role
at once, not just one person's assignment.

**RPCs**: `create_organization_role()`, `update_organization_role()`,
`set_organization_role_permissions()` (replace-all — an empty set on a
custom role unambiguously means "grants nothing," since there's no
global-default fallback to worry about the way there is for a built-in
role), `set_organization_role_active()` (blocks deactivation while anyone
actively holds the role), `set_default_role_permissions()` /
`reset_default_role_permissions()` (an org's override of one of the 4
built-in bundles — rejects an empty set here specifically, since deleting
every override row falls straight through to the global default rather
than meaning "nothing," a footgun worth a clear error over). `set_member_role()`
gained an optional `p_custom_role_id`, mutually exclusive with `p_role`.
`set_employee_reporting_scope()`'s supervisor/manager-role gate now also
accepts a custom role carrying `employee.read_team`/`employee.read_org` —
copied from the original function and modified at exactly those two
checks, not reimplemented from scratch (an earlier draft of this same
migration *did* reimplement it from a partial read and silently dropped
the circular-reporting-line check, the 500-report cap, and the real
effective-dated history preservation in the process — caught by rerunning
the full pre-existing pglite suite, not by anything new, which is exactly
why that suite exists).

**Frontend**: a new `/admin/roles` ("Roles & permissions") page — an
editable checklist per built-in role (grouped by permission domain, via
`lib/permissions.ts`) plus a custom-role manager (create, rename,
re-permission, deactivate/reactivate), gated on `roles.manage`.
`RoleAssignmentForm` now offers built-in and custom roles in one dropdown.
`ReportingScopeForm` takes a `canLead` boolean computed by its parent
page (built-in tier or custom-role permission) instead of inferring it
from a fixed role union internally. `session.ts` adds `roleLabels: string[]`
(built-in display names plus any held custom role names) for display —
`permissions` remains the only thing anything actually authorizes against.

Explicitly deferred: per-item admin-nav filtering (noted above), a
confirmation step warning an admin before they remove their *own* last
permission to reach a page they're standing on, and letting a custom
role's assignment carry a management-scope tier distinction the way
built-in Supervisor/Manager/Admin do (a custom role with team-visibility
permissions can lead either relationship tier — see
`set_employee_reporting_scope()` above — rather than being restricted the
way a bare Supervisor can't take Manager-tier reports).
