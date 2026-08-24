# Halomanage — Build Status and Roadmap

Living handoff document. Last updated: 2026-08-24.

## Current product state

Halomanage is a responsive Next.js HR workspace backed by Supabase. The August 2026 product-rescue
pass replaced the former ornamental interface with a clear public site, explicit account paths, a
responsive application shell, and modern dashboards for employees, managers, and HR administrators.

The product intentionally has no payroll engine. It imports and displays pay records calculated by
an external payroll or accounting system.

### Account model

- Organization owners choose **Create workspace** at `/signup`.
- Email confirmation returns through `/auth/confirm` or `/auth/callback` and completes provisioning at
  `/signup/complete`.
- `create_organization_workspace()` atomically creates the organization, owner employee, Admin role,
  and audit event. It is authenticated-only, idempotent per user, validation-guarded, and uses an
  explicit empty `search_path`.
- Employees do not self-enrol in an organization. HR creates their employee record and uses the
  `invite-employee` Edge Function to issue access.
- Password recovery returns through the same guarded callback flow and ends at `/update-password`.

### Frontend delivered

- Public landing page with a clear value proposition and separate Sign in/Create workspace actions.
- Split-screen sign-in, organization signup, confirmation, callback-error, and password-update views.
- Responsive desktop sidebar and mobile drawer with role-aware navigation.
- Employee dashboard with attendance status, leave, onboarding, appraisals, and notifications.
- Employee areas: leave, onboarding, appraisals, documents, and profile.
- Manager area: leave approvals and current team attendance.
- Admin areas: employee directory and detail, organization structure, leave types, onboarding and
  appraisal builders, documents, external pay-record imports, and reporting.
- A shared visual system for buttons, fields, cards, status badges, tables, dialogs, typography,
  spacing, colors, focus states, and responsive behavior.

### Backend delivered

- Organization-aware employee records and effective-dated assignments.
- Scoped RBAC/RLS, confidential-data separation, and application audit events.
- Attendance, additive corrections, leave ledger and approvals.
- Versioned onboarding and appraisal engines.
- Private documents and acknowledgements.
- Immutable/revisioned pay-record and compensation-change imports with reconciliation.
- Notifications, reporting views, offboarding, training/certification, and asset schemas.
- Edge Function implementations for employee invitations, pay-record parsing, notification delivery,
  and signature webhooks. Provider secrets/configuration are still deployment work.

## Verification completed

- `web`: ESLint passes.
- `web`: TypeScript passes with `tsc --noEmit`.
- `web`: Next.js 16.3.2 production build passes for all routes.
- `web`: `npm audit` reports 0 vulnerabilities.
- `supabase/tests/pglite`: 61/61 database assertions pass, including cross-organization workspace
  provisioning and duplicate-provisioning rejection.

## Deployment checklist

These steps require the project owner's credentials and are intentionally not performed from a local
code-only session.

1. Apply the new migration `20260824182946_create_organization_workspace.sql` to the target Supabase
   project.
2. Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `NEXT_PUBLIC_SITE_URL` in the
   hosting environment. Never expose `SUPABASE_SERVICE_ROLE_KEY` to the Next.js client.
3. In Supabase Auth, enable email signup and add the production `/auth/callback` URL to the allow list.
4. Configure confirmation and password-recovery email templates to use the callback/confirmation
   routes in `web/app/auth/`.
5. Deploy `invite-employee`, `payroll-import`, `send-notifications`, and `signature-webhook`, then set
   their provider secrets.
6. Run a real click-through: owner signup → organization setup → employee creation/invite → employee
   sign-in → attendance/leave/onboarding/appraisal/document flow → external pay-record import.
7. Run Supabase security and performance advisors after the migration is deployed.

## Remaining product work

The current application is a strong, coherent MVP, not the end of the complete blueprint. The most
valuable next tranche is:

1. Offboarding checklist screens and access-revocation scheduling.
2. Training/certification and equipment/asset screens.
3. Per-row pay-import reconciliation and mapping UI.
4. Notification preferences and production email/SMS provider integration.
5. Reusable employer-configurable workflow routing beyond the current leave-specific chain.
6. Manager org-subtree visibility and per-user permission grants (HR Admin/System Admin/Pay Importer).
7. Scheduled accrual, expiry, appraisal, probation, and escalation jobs.
8. Employee-relations cases, announcements, surveys, recognition, integrations, and mobile/PWA work
   in the later phases defined by `PRODUCT_BLUEPRINT.md`.

Recruitment/ATS and payroll calculation remain intentionally out of the first release.
