# Halomanage — Product Blueprint (condensed)

Condensed from *Research Blueprint for a Complete HR Employee Management System*. Full document
is the source of truth for nuance; this file is the quick-reference used while building.

## What Halomanage is

An **employee lifecycle and workforce-management HRIS** — the system of record an employer uses to
manage employees from onboarding through attendance, leave, performance, documents, development
and offboarding. Payroll *calculation* stays in an external payroll/accounting application; Halomanage
imports and displays the finalized results ("Pay Records", never "Payroll Processing").

Strongest version of the vision:

> Employee master record → organization structure → attendance and leave → onboarding →
> performance checkpoints → documents/training → external pay records → reporting → offboarding,
> all tied together through one workflow, approval, permissions, notification and audit system.

Recruitment/ATS is explicitly out of scope for v1 — the lifecycle begins once someone is hired.

## Employee Profile — the central object

| Area | Holds |
|---|---|
| Identity | Employee ID, legal/preferred name, contact, emergency contact |
| Employment | Hire date, status, probation dates, employment type |
| Organization | Company, branch/location, department, team, position, manager, supervisor |
| Work | Schedule, shift, work location, attendance rules |
| Leave | Policies, balances, requests, history |
| Performance | Goals, checkpoints, appraisals, feedback, development plans |
| Documents | Contract, policies, certificates, HR letters, acknowledgements |
| Development | Skills, training, qualifications, certification expiry |
| Compensation | Current salary/rate (if employer records it) |
| Pay Records | Imported external payroll results — not calculations |
| Equipment | Laptop, phone, access card, keys, uniform |
| Employee Relations | Restricted disciplinary/grievance/HR case records |
| Lifecycle | Onboarding, transfers/promotions, offboarding |

## The one architectural idea that matters most

**Everything is employer-configurable, nothing is hard-coded.** Approval chains, leave types,
onboarding steps, appraisal checkpoints, and country leave law all live as employer data, driven by
one reusable workflow/approval engine — not bespoke logic per module.

```
Company A: Employee → Supervisor → Manager → HR approval
Company B: Employee → Manager approval
Company C: Employee → Department Head → HR
Company D: Supervisor approves sick leave; vacation > 5 days needs Manager approval
```

## Permission model: Role + relationship + scope + action

Not a flat Employee/Admin switch. Being a Supervisor means acting on **employees who report to
that supervisor**, not the whole company. Recommended granular permission bundles (see
`app_permission` in the DB schema, mirrored in [ARCHITECTURE.md](./ARCHITECTURE.md)):

- Compensation/payroll visibility is **never implied** by Supervisor/Manager — it's a separate grant.
- Admin splits into **HR Admin** (employee records, HR workflows, leave, appraisals, onboarding,
  documents) and **System Admin** (users, auth, integrations, technical config) — an IT admin resetting
  a login shouldn't thereby see medical documents or salaries.
- A dedicated **Payroll Importer** permission uploads pay records without needing appraisal/case access.

Portal capability matrix (Employee / Supervisor / Manager / Admin) is implemented as RLS policies +
an `app_permission` grant table, not as four separate applications — see ARCHITECTURE.md.

## Core modules (priority from the blueprint)

**Essential (v1 / MVP):** Employee Management, Organization Structure, Authentication & Access,
Attendance, Leave & Absence, Onboarding, Performance, Documents, Pay Records Import,
Workflow/Approvals, Notifications, Reporting & Dashboards, Audit.

**High (v2):** Offboarding, Employee Requests, Training/Certifications, Asset Management,
Employee Relations Cases, shift scheduling, 360° feedback, goals/check-ins, custom report builder,
calendar integrations, public API/webhooks, SSO, mobile/PWA.

**Medium/Later:** Announcements, Surveys/Engagement, Recognition, Recruitment/ATS, offer-letter
generation, LMS integration, succession/workforce planning, multi-country policy packs, white-label.

## Key module behaviors worth remembering while building

- **Attendance**: never silently overwrite a punch — corrections are additive
  (`original → correction requested → reason → approved by → approval timestamp`), preserving full
  history. Attendance and Leave must talk to each other (approved leave ⇒ no "unresolved absence"
  flag on those dates).
- **Leave**: one configurable `leave_types` table, not bespoke code per type. Per type: paid/unpaid,
  entitlement, accrual, carryover, max balance, min notice, max consecutive days, attachment
  requirement, approval chain, eligible employees, blackout dates, half-day/hourly, negative balances.
- **Onboarding**: employer-built templates (steps with owner/instructions/due date/dependencies/
  form/required flag/approval/completion evidence), versioned so an in-flight run keeps the template
  version it started with.
- **Performance**: appraisals are **employer-created checkpoints** (30/60/90-day, quarterly,
  twice-yearly, probation, PIP) built from a template (goals, competencies, questions, rating scale),
  not a single hard-coded annual review. Support self-review → supervisor review → manager
  moderation → acknowledgement, plus checkpoint-over-checkpoint comparison. Finalized appraisals are
  not freely editable — reopen with authorization, or version.
- **Documents**: central repository with per-category visibility, expiration dates + alerts, and
  policy acknowledgement with timestamp/version, not just a stored PDF.
- **Pay Records Import**: two distinct import types that must never be conflated —
  **Pay Run Results Import** (what someone was paid this period; informational) vs.
  **Compensation Change Import** (changes the underlying salary/rate record going forward).
  Flow is always `Upload → Validate → Map → Preview → Approve → Post → Audit`, matched by immutable
  Employee ID (never name), never silently creating a new employee from a payroll row, and every
  import is an immutable, auditable, revisable batch — corrections supersede, they don't overwrite.
- **Offboarding**: triggered checklist (final work date → leave reviewed → assets returned →
  documents completed → exit interview → access disabled → reporting reassigned → archived).
  Former employees are deactivated, never deleted.

## Automation examples (the payoff of one connected data model)

```
Employee created        → portal account + onboarding template assigned + supervisor notified
Leave approved           → balance deducted + team calendar updated + attendance marked + notified
Appraisal due in 7 days  → notify employee + supervisor; overdue → escalate after N days
Certification expiring   → notify employee + supervisor
Termination entered      → offboarding checklist launched + access scheduled for revocation
```

## Compliance posture (Jamaica-aware, not Jamaica-locked)

- MFA (esp. admins/payroll), rate limiting, safe password storage, encryption in transit & at rest,
  full audit trails, session controls with immediate revocation on termination, tenant isolation,
  backups/DR, upload malware/type validation, CSV-injection-safe exports, least privilege throughout.
- Country/employer leave policy is **data**, never hard-coded law (e.g. Jamaica's statutory 10 sick
  days lives in a policy template, not in application code).
- Biometric/GPS attendance is optional and policy-controlled, never a forced default — data minimization.
- No AI autonomously decides promotions, discipline, or termination — human-in-the-loop only, given
  protections around solely-automated decisions that significantly affect individuals.
- Target WCAG 2.2 AA across the whole app, not just static pages.

## MVP acceptance bar

A legitimate v1 needs *all* of: company config, employee records, reporting structure, secured auth
w/ MFA for privileged roles, the four scoped portals, attendance with corrections, configurable leave,
onboarding templates, configurable performance checkpoints, documents with acknowledgement, pay
records import, a shared workflow/approval engine, notifications, core reports, and audit. That bar —
not screen count — is what makes this "a real HRIS" rather than an attendance app with extra pages.
