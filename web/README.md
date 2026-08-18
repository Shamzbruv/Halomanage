# Halomanage — web

Next.js (App Router) frontend. Talks to Supabase directly via
`@supabase/supabase-js` / `@supabase/ssr` — there is no custom REST backend
here by design (see `../docs/ARCHITECTURE.md`). Every page's authorization is
enforced twice, on purpose: `middleware.ts` bounces signed-out visitors to
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
  login/                    public — sign-in only, no sign-up (see docs/PRODUCT_BLUEPRINT.md)
  (portal)/                 route group — shared nav shell, requires a session
    dashboard/               Employee home: clock in/out, leave balances, notifications
    leave/                   submit + view own leave requests
    team/                    Supervisor/Manager: pending approvals, team attendance
    admin/employees/         Admin: employee directory, create + invite
    admin/payroll/           Admin: payroll import upload, reconciliation status, approve
lib/
  supabase/                 browser/server Supabase clients + session-refresh middleware helper
  session.ts                getCurrentSession() — the one place that resolves "who is this and what can they do"
components/                 client components (forms/buttons) that call Supabase RPCs directly
```

## What's here vs. what's next

This covers the MVP's core interaction loop end-to-end (auth → attendance →
leave → admin employee management → payroll import) against every table and
RPC defined in `supabase/migrations/`. Onboarding, performance/appraisals,
documents, training/assets, and reporting dashboards have full schemas and
RPCs on the backend already but no UI yet — see `../docs/ROADMAP.md` for the
build order. Adding a page for one of those follows the exact same pattern
as `app/(portal)/leave/`: a server component queries/reads (RLS-scoped
automatically), a small client component calls the relevant RPC for writes.
