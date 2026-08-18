# Halomanage

**Halomanage** is a configurable employee lifecycle & workforce-management HRIS —
employee records, attendance, leave, onboarding, performance checkpoints, documents,
and secure import/display of externally-calculated payroll results. It deliberately
contains **no payroll engine**: payroll is calculated outside the system (Excel/CSV
export from an external payroll application) and imported, validated, and reconciled
here.

Source vision documents (kept for reference, not duplicated verbatim in code):

- [`Research Blueprint for a Complete HR Employee Management System.pdf`](./Research%20Blueprint%20for%20a%20Complete%20HR%20Employee%20Management%20System.pdf) — product/business blueprint
- [`Comprehensive HR System Architecture on Supabase — No Payroll Engine.pdf`](./Comprehensive%20HR%20System%20Architecture%20on%20Supabase%20—%20No%20Payroll%20Engine.pdf) — technical architecture

Condensed, working versions of both live in [`docs/`](./docs), and the living build plan is
[`docs/ROADMAP.md`](./docs/ROADMAP.md) — **read that first** to see what's built and what's next.

## Stack

- **Backend**: [Supabase](https://supabase.com) — PostgreSQL + Row Level Security, Auth, Storage, Realtime, Edge Functions, Cron, Queues. See [`supabase/`](./supabase).
- **Frontend**: Next.js (App Router) + TypeScript + Tailwind, in [`web/`](./web). Talks to Supabase directly via the Data API; RLS is the real security boundary, not the frontend.

## Repo layout

```
Halomanage/
├── web/                  Next.js application (Employee / Supervisor / Manager / Admin portals)
├── supabase/
│   ├── migrations/       SQL schema, RLS policies, RPCs — the system of record
│   ├── functions/        Edge Functions for privileged / integration workflows
│   └── tests/database/   pgTAP-style RLS & RPC tests (planned)
├── docs/
│   ├── PRODUCT_BLUEPRINT.md   condensed product scope, modules, permission model
│   ├── ARCHITECTURE.md        condensed technical architecture
│   └── ROADMAP.md             phased build plan + status (source of truth for progress)
└── *.pdf                 original research documents
```

## Getting started (once you have a Supabase project)

1. Create a Supabase project at supabase.com (or run locally with the Supabase CLI + Docker).
2. Copy `web/.env.example` to `web/.env.local` and fill in `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` (and `SUPABASE_SERVICE_ROLE_KEY` for server-only use).
3. Apply the migrations in `supabase/migrations/` in order (via `supabase db push`, the Supabase SQL editor, or the CLI once installed — `npx supabase`).
4. Run `supabase/seed.sql` against a **dev** project only — it creates sample organizations, employees and role assignments for local testing.
5. `cd web && npm install && npm run dev`.

## Non-negotiable design rules

These carry over from the architecture doc and should not be relaxed as the product grows:

1. PostgreSQL is the HR system of record; RLS — not frontend menus — is the authorization boundary.
2. Supervisor/Manager roles are **scoped** (direct reports / org subtree), never blanket org-wide access.
3. Compensation, payroll and confidential HR-case data are separate, independently-permissioned tables — a role never gets that access implicitly.
4. Attendance timestamps come from trusted `SECURITY INVOKER` RPCs using `now()`, never from an editable client field; corrections are additive, not overwrites.
5. Leave types, approval routes, onboarding steps and appraisal checkpoints are **employer-configured data**, never hard-coded application logic.
6. Payroll is **imported, immutable, and revisioned** — this system never calculates gross/tax/net pay.
7. Every sensitive mutation writes an `audit_events` row.
