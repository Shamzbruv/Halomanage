# Halomanage — PGlite integration tests

```bash
cd supabase/tests/pglite
npm install
npm test
```

Applies every file in `supabase/migrations/` against a real embedded
Postgres (via [PGlite](https://pglite.dev), Postgres compiled to WASM — no
Docker, no network, no Supabase project needed), then impersonates five RLS
test personas (Alice/Bob/Carol/David/Erin, matching
`docs/ARCHITECTURE.md`'s testing-strategy example) and runs ~45 assertions
against the real RPCs with RLS actually enforced: attendance clock-in/out,
leave submission/approval/balance, payroll import (both pay-run and
compensation-change flavors) through reconciliation and approval,
onboarding with dependent tasks, and a full appraisal cycle — plus a set of
deliberate negative tests (wrong person tries to approve, unrelated employee
tries to read a record, self-service tries to change a protected field).

This is the fast, CI-friendly layer. `../database/*.sql` is the pgTAP layer
(needs the Supabase CLI + Docker via `supabase test db`) — write new tests
in whichever suite fits, but prefer extending this one first since it needs
no local infrastructure.

**What this does not cover:** real Supabase Auth (`bootstrap.sql` stubs a
minimal `auth.users`/`auth.uid()`), Storage signed URLs, Realtime, or Edge
Functions — those need an actual Supabase project. See
`docs/ROADMAP.md` → "First thing to do next".

Run this after touching anything in `supabase/migrations/` — it has already
caught four real bugs during development (see the comment block at the top
of `run.mjs`) that only surfaced when actually executed against Postgres
with RLS on, not from reading the SQL.
