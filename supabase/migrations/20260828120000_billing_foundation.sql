-- Halomanage — Stripe billing foundation
--
-- Billing mutations are server-only. Organization administrators may read their
-- own subscription summary, while webhook delivery state remains inaccessible
-- through the client-facing Data API.

create table public.organization_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique
    references public.organizations(id) on delete cascade,
  provider text not null default 'stripe'
    check (provider = 'stripe'),
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  stripe_price_id text,
  plan_code text not null default 'starter'
    check (plan_code ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  status text not null default 'trialing'
    check (status in (
      'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused',
      'incomplete', 'incomplete_expired'
    )),
  seats integer not null default 1 check (seats > 0),
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  current_period_started_at timestamptz,
  current_period_ends_at timestamptz,
  cancel_at_period_end boolean not null default false,
  canceled_at timestamptz,
  ended_at timestamptz,
  provider_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    trial_started_at is null
    or trial_ends_at is null
    or trial_ends_at >= trial_started_at
  ),
  check (
    current_period_started_at is null
    or current_period_ends_at is null
    or current_period_ends_at >= current_period_started_at
  ),
  check (stripe_subscription_id is null or stripe_customer_id is not null)
);

alter table public.organization_subscriptions enable row level security;

create index organization_subscriptions_status_idx
  on public.organization_subscriptions (status, trial_ends_at);

create trigger organization_subscriptions_set_updated_at
  before update on public.organization_subscriptions
  for each row execute function private.set_updated_at();

comment on table public.organization_subscriptions is
  'One server-managed Stripe subscription summary per organization. No payment instrument data is stored.';
comment on column public.organization_subscriptions.provider_updated_at is
  'Stripe event creation time last applied; prevents older webhook events from replacing newer state.';

revoke all on table public.organization_subscriptions from anon, authenticated;
grant select on table public.organization_subscriptions to authenticated;
grant select, insert, update, delete on table public.organization_subscriptions to service_role;

create policy "organization admins read subscription"
on public.organization_subscriptions for select to authenticated
using ((select private.has_permission(organization_id, 'organization.manage')));

create table public.billing_webhook_events (
  id bigint generated always as identity primary key,
  stripe_event_id text not null unique,
  event_type text not null,
  stripe_object_id text,
  stripe_api_version text,
  livemode boolean not null,
  stripe_created_at timestamptz not null,
  organization_id uuid references public.organizations(id) on delete set null,
  processing_status text not null default 'processing'
    check (processing_status in ('processing', 'processed', 'ignored', 'failed')),
  attempts integer not null default 1 check (attempts > 0),
  processing_started_at timestamptz not null default now(),
  processed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (last_error is null or char_length(last_error) <= 500)
);

alter table public.billing_webhook_events enable row level security;

create index billing_webhook_events_status_idx
  on public.billing_webhook_events (processing_status, processing_started_at);
create index billing_webhook_events_org_created_idx
  on public.billing_webhook_events (organization_id, stripe_created_at desc)
  where organization_id is not null;

create trigger billing_webhook_events_set_updated_at
  before update on public.billing_webhook_events
  for each row execute function private.set_updated_at();

comment on table public.billing_webhook_events is
  'Minimal Stripe webhook delivery ledger. Full event payloads are intentionally not retained.';

revoke all on table public.billing_webhook_events from anon, authenticated;
grant select, insert, update, delete on table public.billing_webhook_events to service_role;
revoke all on sequence public.billing_webhook_events_id_seq from anon, authenticated;
grant usage, select on sequence public.billing_webhook_events_id_seq to service_role;

-- Give every organization a useful account immediately, including organizations
-- created before billing was introduced. Stripe identifiers remain null until an
-- administrator starts Checkout.
create or replace function private.provision_organization_trial()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.organization_subscriptions (
    organization_id,
    status,
    trial_started_at,
    trial_ends_at
  ) values (
    new.id,
    'trialing',
    now(),
    now() + interval '14 days'
  )
  on conflict (organization_id) do nothing;

  return new;
end;
$$;

revoke execute on function private.provision_organization_trial()
  from public, anon, authenticated, service_role;

create trigger organizations_provision_trial
  after insert on public.organizations
  for each row execute function private.provision_organization_trial();

insert into public.organization_subscriptions (
  organization_id,
  status,
  trial_started_at,
  trial_ends_at
)
select
  o.id,
  'trialing',
  now(),
  now() + interval '14 days'
from public.organizations o
on conflict (organization_id) do nothing;

-- Atomically claim an event. A failed delivery may retry immediately; an event
-- left in processing for ten minutes may be reclaimed after an interrupted run.
create or replace function public.claim_billing_webhook_event(
  p_stripe_event_id text,
  p_event_type text,
  p_stripe_object_id text,
  p_stripe_api_version text,
  p_livemode boolean,
  p_stripe_created_at timestamptz
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_claimed boolean;
begin
  insert into public.billing_webhook_events (
    stripe_event_id,
    event_type,
    stripe_object_id,
    stripe_api_version,
    livemode,
    stripe_created_at
  ) values (
    p_stripe_event_id,
    p_event_type,
    p_stripe_object_id,
    p_stripe_api_version,
    p_livemode,
    p_stripe_created_at
  )
  on conflict (stripe_event_id) do update
  set
    event_type = excluded.event_type,
    stripe_object_id = excluded.stripe_object_id,
    stripe_api_version = excluded.stripe_api_version,
    livemode = excluded.livemode,
    stripe_created_at = excluded.stripe_created_at,
    processing_status = 'processing',
    attempts = public.billing_webhook_events.attempts + 1,
    processing_started_at = now(),
    processed_at = null,
    last_error = null
  where public.billing_webhook_events.processing_status = 'failed'
     or (
       public.billing_webhook_events.processing_status = 'processing'
       and public.billing_webhook_events.processing_started_at < now() - interval '10 minutes'
     )
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

revoke execute on function public.claim_billing_webhook_event(
  text, text, text, text, boolean, timestamptz
) from public, anon, authenticated;
grant execute on function public.claim_billing_webhook_event(
  text, text, text, text, boolean, timestamptz
) to service_role;

-- Apply the latest provider snapshot for an organization. The conditional
-- upsert makes retries safe and prevents delayed events from rolling state back.
create or replace function public.sync_organization_subscription(
  p_organization_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_stripe_price_id text,
  p_plan_code text,
  p_status text,
  p_seats integer,
  p_trial_started_at timestamptz,
  p_trial_ends_at timestamptz,
  p_current_period_started_at timestamptz,
  p_current_period_ends_at timestamptz,
  p_cancel_at_period_end boolean,
  p_canceled_at timestamptz,
  p_ended_at timestamptz,
  p_provider_updated_at timestamptz
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_rows_affected integer;
begin
  insert into public.organization_subscriptions (
    organization_id,
    stripe_customer_id,
    stripe_subscription_id,
    stripe_price_id,
    plan_code,
    status,
    seats,
    trial_started_at,
    trial_ends_at,
    current_period_started_at,
    current_period_ends_at,
    cancel_at_period_end,
    canceled_at,
    ended_at,
    provider_updated_at
  ) values (
    p_organization_id,
    p_stripe_customer_id,
    p_stripe_subscription_id,
    p_stripe_price_id,
    p_plan_code,
    p_status,
    p_seats,
    p_trial_started_at,
    p_trial_ends_at,
    p_current_period_started_at,
    p_current_period_ends_at,
    p_cancel_at_period_end,
    p_canceled_at,
    p_ended_at,
    p_provider_updated_at
  )
  on conflict (organization_id) do update
  set
    stripe_customer_id = excluded.stripe_customer_id,
    stripe_subscription_id = excluded.stripe_subscription_id,
    stripe_price_id = excluded.stripe_price_id,
    plan_code = excluded.plan_code,
    status = excluded.status,
    seats = excluded.seats,
    trial_started_at = excluded.trial_started_at,
    trial_ends_at = excluded.trial_ends_at,
    current_period_started_at = excluded.current_period_started_at,
    current_period_ends_at = excluded.current_period_ends_at,
    cancel_at_period_end = excluded.cancel_at_period_end,
    canceled_at = excluded.canceled_at,
    ended_at = excluded.ended_at,
    provider_updated_at = excluded.provider_updated_at
  where public.organization_subscriptions.provider_updated_at is null
     or public.organization_subscriptions.provider_updated_at <= excluded.provider_updated_at;

  get diagnostics v_rows_affected = row_count;
  return v_rows_affected > 0;
end;
$$;

revoke execute on function public.sync_organization_subscription(
  uuid, text, text, text, text, text, integer, timestamptz, timestamptz,
  timestamptz, timestamptz, boolean, timestamptz, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.sync_organization_subscription(
  uuid, text, text, text, text, text, integer, timestamptz, timestamptz,
  timestamptz, timestamptz, boolean, timestamptz, timestamptz, timestamptz
) to service_role;
