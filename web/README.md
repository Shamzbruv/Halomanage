# Halomanage — web

Next.js (App Router) frontend. Talks to Supabase directly via
`@supabase/supabase-js` / `@supabase/ssr` — there is no custom REST backend
here by design (see `../docs/ARCHITECTURE.md`). Every page's authorization is
enforced twice, on purpose: `proxy.ts` bounces signed-out visitors to
`/login` as a UX convenience, and Postgres RLS is the actual security
boundary underneath every query.

## Run locally

```bash
npm install
cp .env.example .env.local   # fill in your Supabase project URL/anon key
npm run dev
```

## Layout

```
app/
  login/                          public sign-in and password recovery
  signup/                         organization-owner workspace creation
  auth/                           email confirmation and PKCE callback routes
  (portal)/                       route group — shared nav shell, requires a session
    dashboard/                     Employee home: clock in/out, leave balances, notifications
    time/                          schedule, shift clock, attendance history + correction requests
    leave/                         submit + view own leave requests
    onboarding/                    complete own/assigned onboarding tasks
    appraisals/, appraisals/[id]/  own checkpoints + reviews awaiting you; fill/submit/acknowledge
    documents/                     view, download, acknowledge documents visible to you
    development/                   assigned learning, certifications, and company assets
    profile/                       edit own preferred name/phone + private info (address, emergency contact)
    team/                          Supervisor/Manager: pending approvals, team attendance
    admin/setup/                   Admin: launch checklist, starter setup, employee portal link
    admin/organization/            Admin: departments/teams, positions, locations
    admin/leave-types/             Admin: leave type builder
    admin/employees/, [id]/        Admin: directory, create, invite, assignment history + transfer form
    admin/onboarding/, templates/[id]/    Admin: template + step builder, start onboarding, progress list
    admin/appraisals/, templates/[id]/    Admin: template/section/question builder, cycle create + launch
    admin/documents/               Admin: upload (org-wide or employee-specific)
    admin/payroll/                 Admin: payroll import upload, reconciliation status, approve
    admin/reports/                 Admin: headcount, pending leave, onboarding %, expiring items, recent imports
  portal/[slug]/                  public-safe, organization-branded employee sign-in page
lib/
  supabase/                 browser/server Supabase clients + session-refresh middleware helper
  session.ts                getCurrentSession() — the one place that resolves "who is this and what can they do"
  ui.ts                      statusBadgeClass()/roleBadgeClass() — shared badge-class mapping, not copy-pasted per page
components/                 client components (forms/buttons) that call Supabase RPCs directly
```

## What's here vs. what's next

Covers every Phase-1 module end-to-end, including the admin configuration
screens (org structure, leave types, onboarding/appraisal template
builders) plus a guided launch checklist and branded employee portal. New
workspaces receive editable starter content so the first visit is useful.
Still missing: offboarding task UI (backend auto-triggers on termination but
nothing surfaces the resulting checklist — currently the top gap), admin
assignment/authoring UI for training/certifications and asset/equipment
management (employees can now see their assignments), notification preferences, and per-row payroll reconciliation
(admin sees aggregate match counts but can't fix an individual unmatched
row without SQL). See `../docs/ROADMAP.md` for the full, current list.
Adding a page for one of those follows the exact same pattern as
`app/(portal)/leave/` or `app/(portal)/admin/onboarding/`: a server
component queries/reads (RLS-scoped automatically), a small client
component calls the relevant table insert/update or RPC for writes.

**One recurring pitfall worth knowing before adding more:** never
`.select("*, related_table(...)")` against a `_v` reporting view —
PostgREST's automatic relationship embedding needs a real foreign-key
constraint, which views don't carry even when the table underneath does.
Query the base table directly (see `admin/employees/[id]/page.tsx`'s
comment) or join in JS against a lookup map (see `admin/onboarding/page.tsx`).
Hit three times across this codebase already.
