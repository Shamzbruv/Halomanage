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
  audit event, editable business structure, schedule, leave policies/balances, starter onboarding and
  appraisal templates, and assigned orientation training. It is authenticated-only, idempotent per
  user, validation-guarded, and uses an explicit empty `search_path`.
- Historical partial memberships self-repair through `repair_current_workspace()`; incomplete data
  produces a clear recovery screen and never a blank portal shell.
- Employees do not self-enrol in an organization. HR creates their employee record and uses the
  `invite-employee` Edge Function to issue access. Permission is checked explicitly and the employee
  link plus baseline role are written transactionally.
- Every organization has a customizable `/portal/{slug}` employee sign-in page. Admins can copy,
  preview, and change that address from Setup or Organization. The example
  `/portal/icssportal-halomanage` is supported; branded portals reject accounts from other tenants.
- Password recovery returns through the same guarded callback flow and ends at `/update-password`.

### Frontend delivered

- Public landing page with a clear value proposition and separate Sign in/Create workspace actions.
- Split-screen sign-in, organization signup, confirmation, callback-error, and password-update views.
- Responsive desktop sidebar and mobile drawer with role-aware navigation.
- Employee dashboard with attendance status, organization launch guidance, leave, onboarding,
  appraisals, and notifications.
- Employee areas: dedicated time/attendance with correction requests, leave, onboarding,
  appraisals, learning/assets, documents, and profile.
- Manager area: leave approvals and current team attendance.
- Admin areas: interactive Setup Guide and employee-portal controls, employee directory and detail,
  organization structure, leave types, onboarding and appraisal builders, documents, external
  pay-record imports, and reporting.
- Context-rich first-use and empty states replace every former blank-tab outcome with an explanation
  and, where authorized, the next useful action.
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
- Idempotent starter-workspace seeding, public-safe branded portal lookup, portal customization,
  partial-membership recovery, and transactional invited-account linking.
- Edge Function implementations for employee invitations, pay-record parsing, notification delivery,
  and signature webhooks. Provider secrets/configuration are still deployment work.

## Verification completed

- `web`: ESLint passes.
- `web`: TypeScript passes with `tsc --noEmit`.
- `web`: Next.js 16.3.2 production build passes for all routes.
- `web`: `npm audit` reports 0 vulnerabilities.
- `supabase/tests/pglite`: 75/75 database assertions pass, including starter workspace contents,
  portal lookup/customization, partial-membership repair, invitation permission separation,
  transactional linking, cross-organization provisioning, and duplicate-provisioning rejection.
- Browser visual QA passes for the landing page and organization employee portal at 1440px and
  390px widths.

## Deployment checklist

These steps require the project owner's credentials and are intentionally not performed from a local
code-only session.

1. Apply all pending migrations through
   `20260824212436_organization_portal_and_starter_workspace.sql` to the target Supabase project.
2. Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `NEXT_PUBLIC_SITE_URL` in the
   hosting environment. Never expose `SUPABASE_SERVICE_ROLE_KEY` to the Next.js client.
3. In Supabase Auth, enable email signup and add the production `/auth/callback` URL to the allow list.
4. Configure confirmation and password-recovery email templates to use the callback/confirmation
   routes in `web/app/auth/`.
5. Redeploy `invite-employee` (its new transactional linker depends on the latest migration), plus
   `payroll-import`, `send-notifications`, and `signature-webhook`, then set their provider secrets.
6. Run a real click-through: owner signup → Setup Guide/starter initialization → customize/copy the
   employee portal → employee creation/invite → branded employee sign-in → shift clock and correction
   → leave/onboarding/appraisal/document/learning flow → external pay-record import.
7. Run Supabase security and performance advisors after the migration is deployed.

## Remaining product work

The current application is a strong, coherent MVP, not the end of the complete blueprint. The most
valuable next tranche is:

1. Offboarding checklist screens and access-revocation scheduling.
2. Admin authoring/assignment screens for training, certifications, and equipment/assets (employee
   visibility is now delivered).
3. Per-row pay-import reconciliation and mapping UI.
4. Notification preferences and production email/SMS provider integration.
5. Reusable employer-configurable workflow routing beyond the current leave-specific chain.
6. Manager org-subtree visibility and per-user permission grants (HR Admin/System Admin/Pay Importer).
7. Scheduled accrual, expiry, appraisal, probation, and escalation jobs.
8. Employee-relations cases, announcements, surveys, recognition, integrations, and mobile/PWA work
   in the later phases defined by `PRODUCT_BLUEPRINT.md`.

Recruitment/ATS and payroll calculation remain intentionally out of the first release.
