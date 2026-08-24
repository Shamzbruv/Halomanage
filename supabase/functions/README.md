# Halomanage Edge Functions

Reserved for operations that need elevated (`service_role`) credentials, file
parsing, or an external network call — everything else is plain Supabase
Data API + RLS from `web/`. See `docs/ARCHITECTURE.md` → "Suggested minimal
Edge Functions / RPC surface" for why each of these exists and why the list
is deliberately short.

| Function | Trigger | Needs these secrets (beyond the auto-injected `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`) |
|---|---|---|
| `invite-employee` | Called by the web app (Admin action) | none |
| `payroll-import` | Called by the web app after a file upload | none |
| `send-notifications` | Supabase Cron, e.g. every 1–2 minutes | `EMAIL_PROVIDER_API_KEY`, `EMAIL_FROM_ADDRESS` |
| `signature-webhook` | External e-signature provider's webhook | `SIGNATURE_PROVIDER_WEBHOOK_SECRET` |

## Deploying

```bash
npx supabase functions deploy invite-employee
npx supabase functions deploy payroll-import
npx supabase functions deploy send-notifications
npx supabase functions deploy signature-webhook

# secrets (never commit these):
npx supabase secrets set EMAIL_PROVIDER_API_KEY=... EMAIL_FROM_ADDRESS=... SIGNATURE_PROVIDER_WEBHOOK_SECRET=...
```

Then schedule `send-notifications` with Supabase Cron (SQL editor, once the
project is linked):

```sql
select cron.schedule(
  'send-notifications-every-2-min',
  '*/2 * * * *',
  $$
  select net.http_post(
    url := 'https://<project-ref>.functions.supabase.co/send-notifications',
    headers := jsonb_build_object('Authorization', 'Bearer ' || '<service_role_key_as_a_vault_secret>')
  );
  $$
);
```

(Store the service role key in Vault rather than inlining it in the cron job
body — see `docs/ARCHITECTURE.md` → Vault / secrets.)

## Local development

```bash
npx supabase start
npx supabase functions serve --env-file ./supabase/.env.local
```

## Why these specific functions use `service_role` and others don't

- `invite-employee` and `payroll-import` **do** authorization first using
  the *caller's* JWT (a client scoped to their own session, subject to
  normal RLS) — only once that lookup proves they're allowed to act do they
  switch to a `service_role` client for the privileged step (Auth admin
  call; file download + bulk staging insert). The authorization check is
  never skipped, just moved earlier.
- `invite-employee` additionally requires the explicit `employee.manage`
  permission. After Auth creates the invited user, employee linking and the
  baseline `employee` role are committed by one service-role-only database
  function; if that transaction fails, the newly-created Auth user is removed
  so the employee can be invited again instead of being left half-connected.
- `send-notifications` and `signature-webhook` have no interactive caller at
  all (Cron and an external provider, respectively) — trust is established
  by the invocation context itself (a scheduled job authenticated by
  Supabase, or a webhook signature check), not a user JWT.
