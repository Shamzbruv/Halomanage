-- Halomanage — Rewards & Recognition Marketplace (P0)
--
-- Deliberately NOT built around any single gift-card API. The foundation is
-- an organization-owned vendor/catalog model where fulfillment is a vendor
-- property — 'manual' (HR hands over a voucher, arranges delivery with a
-- local supplier, etc.) is a first-class, always-available fulfillment
-- type, exactly as capable as an automated one. Third-party providers
-- (Tremendous, Tango, Giftbit, ...) are optional connectors an org's vendor
-- can point at later, not the thing the schema is built around.
--
-- This migration ships the mocked/manual-first slice: vendors, products,
-- a real points ledger (employees redeem points, not dollars), redemptions,
-- and the admin/fulfillment workflow. No automatic_api provider is seeded
-- active — creating one (with real API credentials living only in Edge
-- Function secrets, never in this database) is future, real-vendor work,
-- gated behind the platform_features mechanism already built for exactly
-- this kind of staged rollout.

-- ============================ PLATFORM-LEVEL PROVIDERS =======================
-- Reward Providers are platform infrastructure (like SSO connections were),
-- configured once by Halomanage staff and available to every organization —
-- never a per-tenant table. An organization picks a provider when creating
-- its own vendor; the provider only decides HOW that vendor's rewards get
-- fulfilled (manually, or through a live API integration later).

create table public.reward_providers (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z][a-z0-9_]{0,63}$'),
  name text not null,
  fulfillment_type text not null check (fulfillment_type in ('manual', 'automatic_api')),
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (key <> 'manual' or fulfillment_type = 'manual')
);
alter table public.reward_providers enable row level security;
create trigger reward_providers_set_updated_at before update on public.reward_providers
  for each row execute function private.set_updated_at();

comment on table public.reward_providers is
  'Platform infrastructure, not tenant data. "manual" is always available and requires no integration. An automatic_api provider row is only useful once a real API key exists in Edge Function secrets — this table never stores credentials.';

-- Any signed-in org member may see which providers exist (needed to create
-- a vendor); only platform staff may add/edit/deactivate one.
create policy "org members read reward providers" on public.reward_providers for select to authenticated
  using (true);
create policy "platform staff manage reward providers" on public.reward_providers for all to authenticated
  using (private.is_platform_staff())
  with check (private.is_platform_staff());

insert into public.reward_providers (key, name, fulfillment_type, notes) values
  ('manual', 'Manual / HR-fulfilled', 'manual', 'HR or a manager hands over the reward directly — a voucher, a gift, arranging pickup with a local supplier. Always available, no integration required.')
on conflict (key) do nothing;

-- ============================ ORG-OWNED VENDORS ===============================

create table public.reward_vendors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider_id uuid not null references public.reward_providers(id) on delete restrict,
  name text not null,
  description text,
  contact_name text,
  contact_email public.citext,
  contact_phone text,
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);
alter table public.reward_vendors enable row level security;
create index reward_vendors_org_idx on public.reward_vendors(organization_id);
create trigger reward_vendors_set_updated_at before update on public.reward_vendors
  for each row execute function private.set_updated_at();

comment on table public.reward_vendors is
  'An organization''s own reward sources — "Fontana Pharmacy", "Local Electronics Supplier" — as real and first-class as any API-integrated provider. Every organization curates its own list.';

create policy "org members read reward vendors" on public.reward_vendors for select to authenticated
  using (private.is_org_member(organization_id));
create policy "manage reward vendors" on public.reward_vendors for all to authenticated
  using (private.has_permission(organization_id, 'rewards.manage_catalog'))
  with check (private.has_permission(organization_id, 'rewards.manage_catalog'));

-- An automatic_api vendor is only useful, and only creatable, once the
-- platform provider behind it is actually active (a real integration
-- exists) — this keeps an org from configuring a reward that can never be
-- fulfilled and then wondering why nothing happens.
create or replace function private.enforce_reward_vendor_provider_active()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider public.reward_providers;
begin
  select * into v_provider from public.reward_providers where id = new.provider_id;
  if v_provider.id is null then
    raise exception 'Reward provider not found';
  end if;
  if v_provider.fulfillment_type = 'automatic_api' and not v_provider.is_active then
    raise exception using errcode = '23514',
      message = 'This provider is not yet connected — use Manual fulfillment until a platform administrator activates it';
  end if;
  return new;
end;
$$;

create trigger reward_vendors_enforce_provider_active
  before insert or update of provider_id on public.reward_vendors
  for each row execute function private.enforce_reward_vendor_provider_active();

-- ============================ ORG-OWNED PRODUCTS ==============================

create table public.reward_products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  vendor_id uuid not null references public.reward_vendors(id) on delete cascade,
  name text not null,
  description text,
  image_url text,
  points_cost integer not null check (points_cost > 0),
  -- null = unlimited/digital; a number = tracked physical stock, decremented
  -- on redemption and restored on cancellation.
  inventory_quantity integer check (inventory_quantity is null or inventory_quantity >= 0),
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.reward_products enable row level security;
create index reward_products_org_idx on public.reward_products(organization_id);
create index reward_products_vendor_idx on public.reward_products(vendor_id);
create trigger reward_products_set_updated_at before update on public.reward_products
  for each row execute function private.set_updated_at();

comment on column public.reward_products.inventory_quantity is
  'Fulfillment type is a property of the vendor (via its provider), not the product — a physical item from a manual vendor tracks stock here regardless.';

create policy "org members read reward products" on public.reward_products for select to authenticated
  using (private.is_org_member(organization_id));
create policy "manage reward products" on public.reward_products for all to authenticated
  using (private.has_permission(organization_id, 'rewards.manage_catalog'))
  with check (private.has_permission(organization_id, 'rewards.manage_catalog'));

-- A product's organization must match its vendor's — never let a product
-- silently attach to another organization's vendor.
create or replace function private.enforce_reward_product_vendor_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_vendor_org uuid;
begin
  select organization_id into v_vendor_org from public.reward_vendors where id = new.vendor_id;
  if v_vendor_org is null or v_vendor_org <> new.organization_id then
    raise exception using errcode = '23514', message = 'A reward product must belong to a vendor in the same organization';
  end if;
  return new;
end;
$$;

create trigger reward_products_enforce_vendor_org
  before insert or update of organization_id, vendor_id on public.reward_products
  for each row execute function private.enforce_reward_product_vendor_org();

-- ============================ REDEMPTIONS + POINTS LEDGER =====================

create table public.reward_redemptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  product_id uuid not null references public.reward_products(id) on delete restrict,
  points_spent integer not null check (points_spent > 0),
  fulfillment_type text not null check (fulfillment_type in ('manual', 'automatic_api')),
  status text not null default 'pending_fulfillment'
    check (status in ('pending_fulfillment', 'fulfilled', 'cancelled', 'failed')),
  fulfillment_note text,
  fulfilled_by uuid references auth.users(id) on delete set null,
  fulfilled_at timestamptz,
  cancelled_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.reward_redemptions enable row level security;
create index reward_redemptions_org_idx on public.reward_redemptions(organization_id, status);
create index reward_redemptions_employee_idx on public.reward_redemptions(employee_id, created_at desc);
create trigger reward_redemptions_set_updated_at before update on public.reward_redemptions
  for each row execute function private.set_updated_at();

comment on table public.reward_redemptions is
  'fulfillment_type is captured at redemption time (not re-derived later) so a later vendor/provider change never rewrites what already happened.';

create policy "read own redemptions" on public.reward_redemptions for select to authenticated
  using (employee_id = private.current_employee_id() and private.has_permission(organization_id, 'rewards.read_self'));
create policy "read team redemptions" on public.reward_redemptions for select to authenticated
  using (private.has_permission(organization_id, 'employee.read_team') and private.in_management_scope(employee_id));
create policy "manage redemptions" on public.reward_redemptions for all to authenticated
  using (private.has_permission(organization_id, 'rewards.fulfill'))
  with check (private.has_permission(organization_id, 'rewards.fulfill'));
-- Employees never write redemption rows directly — only redeem_reward() and
-- fulfill_redemption()/cancel_redemption() do, all SECURITY DEFINER and audited.
revoke insert, update, delete on public.reward_redemptions from authenticated;

create table public.employee_points_ledger (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  entry_type text not null check (entry_type in ('award', 'redemption', 'refund', 'adjustment', 'expiry')),
  amount integer not null check (amount <> 0),
  reason text,
  related_redemption_id uuid references public.reward_redemptions(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.employee_points_ledger enable row level security;
create index employee_points_ledger_employee_idx on public.employee_points_ledger(employee_id);
create index employee_points_ledger_org_idx on public.employee_points_ledger(organization_id);

comment on table public.employee_points_ledger is
  'Append-only balance ledger — never mutate a stored balance in place. employee_points_balance_v sums this per employee, exactly like leave_balance_v does for leave_ledger.';

create policy "read own points ledger" on public.employee_points_ledger for select to authenticated
  using (employee_id = private.current_employee_id() and private.has_permission(organization_id, 'rewards.read_self'));
create policy "read team points ledger" on public.employee_points_ledger for select to authenticated
  using (private.has_permission(organization_id, 'employee.read_team') and private.in_management_scope(employee_id));
create policy "read org points ledger" on public.employee_points_ledger for select to authenticated
  using (private.has_permission(organization_id, 'rewards.award_points'));
-- Writes go only through award_employee_points()/redeem_reward()/
-- cancel_redemption(), all SECURITY DEFINER and audited.
revoke insert, update, delete on public.employee_points_ledger from authenticated;

create view public.employee_points_balance_v
  with (security_invoker = true)
as
select
  l.organization_id,
  l.employee_id,
  coalesce(sum(l.amount), 0) as balance
from public.employee_points_ledger l
group by l.organization_id, l.employee_id;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

create or replace function public.award_employee_points(
  p_employee_id uuid,
  p_amount integer,
  p_reason text default null
)
returns public.employee_points_ledger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  v_entry public.employee_points_ledger;
begin
  select * into v_employee from public.employees where id = p_employee_id;
  if v_employee.id is null then
    raise exception 'Employee not found';
  end if;
  if not private.has_permission(v_employee.organization_id, 'rewards.award_points') then
    raise exception using errcode = '42501', message = 'Not authorized to award points in this organization';
  end if;
  if v_employee.status = 'terminated' then
    raise exception using errcode = '23514', message = 'Cannot award points to a terminated employee';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception using errcode = '22023', message = 'Award amount must be a positive number of points';
  end if;

  insert into public.employee_points_ledger (organization_id, employee_id, entry_type, amount, reason, created_by)
  values (v_employee.organization_id, p_employee_id, 'award', p_amount, nullif(trim(p_reason), ''), (select auth.uid()))
  returning * into v_entry;

  perform private.log_audit_event(
    v_employee.organization_id, 'REWARD_POINTS_AWARDED', 'employee', p_employee_id, null,
    jsonb_build_object('amount', p_amount, 'reason', p_reason)
  );
  return v_entry;
end;
$$;

create or replace function public.redeem_reward(p_product_id uuid)
returns public.reward_redemptions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee_id uuid;
  v_product public.reward_products;
  v_vendor public.reward_vendors;
  v_provider public.reward_providers;
  v_balance integer;
  v_redemption public.reward_redemptions;
begin
  v_employee_id := private.current_employee_id();
  if v_employee_id is null then
    raise exception using errcode = '42501', message = 'You must be an active employee to redeem a reward';
  end if;

  select * into v_product from public.reward_products where id = p_product_id for update;
  if v_product.id is null or not v_product.is_active then
    raise exception using errcode = 'P0002', message = 'This reward is not available';
  end if;
  if not private.has_permission(v_product.organization_id, 'rewards.redeem_self') then
    raise exception using errcode = '42501', message = 'Not authorized to redeem rewards in this organization';
  end if;

  select * into v_vendor from public.reward_vendors where id = v_product.vendor_id;
  if v_vendor.id is null or not v_vendor.is_active or v_vendor.organization_id <> v_product.organization_id then
    raise exception using errcode = '23514', message = 'This reward''s vendor is not currently active';
  end if;
  select * into v_provider from public.reward_providers where id = v_vendor.provider_id;

  if v_product.inventory_quantity is not null and v_product.inventory_quantity <= 0 then
    raise exception using errcode = '23514', message = 'This reward is out of stock';
  end if;

  -- Serialize this employee's balance check-and-spend so two concurrent
  -- redemptions can't both pass the balance check against the same total.
  perform pg_advisory_xact_lock(hashtextextended(v_employee_id::text, 91));

  select coalesce(sum(amount), 0) into v_balance
  from public.employee_points_ledger
  where employee_id = v_employee_id;

  if v_balance < v_product.points_cost then
    raise exception using errcode = '23514', message = 'Not enough points for this reward';
  end if;

  if v_product.inventory_quantity is not null then
    update public.reward_products set inventory_quantity = inventory_quantity - 1 where id = v_product.id;
  end if;

  insert into public.reward_redemptions (
    organization_id, employee_id, product_id, points_spent, fulfillment_type, status
  ) values (
    v_product.organization_id, v_employee_id, v_product.id, v_product.points_cost, v_provider.fulfillment_type,
    'pending_fulfillment'
  )
  returning * into v_redemption;

  insert into public.employee_points_ledger (
    organization_id, employee_id, entry_type, amount, reason, related_redemption_id, created_by
  ) values (
    v_product.organization_id, v_employee_id, 'redemption', -v_product.points_cost,
    'Redeemed: ' || v_product.name, v_redemption.id, (select auth.uid())
  );

  perform private.log_audit_event(
    v_product.organization_id, 'REWARD_REDEEMED', 'reward_redemption', v_redemption.id, null, to_jsonb(v_redemption)
  );
  return v_redemption;
end;
$$;

create or replace function public.fulfill_redemption(
  p_redemption_id uuid,
  p_note text default null
)
returns public.reward_redemptions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_redemption public.reward_redemptions;
begin
  select * into v_redemption from public.reward_redemptions where id = p_redemption_id for update;
  if v_redemption.id is null then
    raise exception 'Redemption not found';
  end if;
  if not private.has_permission(v_redemption.organization_id, 'rewards.fulfill') then
    raise exception using errcode = '42501', message = 'Not authorized to fulfill redemptions for this organization';
  end if;
  if v_redemption.status <> 'pending_fulfillment' then
    raise exception using errcode = '23514', message = 'This redemption is not awaiting fulfillment';
  end if;

  update public.reward_redemptions
  set status = 'fulfilled', fulfillment_note = nullif(trim(p_note), ''), fulfilled_by = (select auth.uid()), fulfilled_at = now()
  where id = p_redemption_id
  returning * into v_redemption;

  perform private.log_audit_event(
    v_redemption.organization_id, 'REWARD_REDEMPTION_FULFILLED', 'reward_redemption', v_redemption.id, null, to_jsonb(v_redemption)
  );
  return v_redemption;
end;
$$;

create or replace function public.cancel_redemption(
  p_redemption_id uuid,
  p_reason text default null
)
returns public.reward_redemptions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_redemption public.reward_redemptions;
begin
  select * into v_redemption from public.reward_redemptions where id = p_redemption_id for update;
  if v_redemption.id is null then
    raise exception 'Redemption not found';
  end if;
  if not private.has_permission(v_redemption.organization_id, 'rewards.fulfill') then
    raise exception using errcode = '42501', message = 'Not authorized to cancel redemptions for this organization';
  end if;
  if v_redemption.status <> 'pending_fulfillment' then
    raise exception using errcode = '23514', message = 'Only a redemption awaiting fulfillment can be cancelled';
  end if;

  update public.reward_redemptions
  set status = 'cancelled', cancelled_reason = nullif(trim(p_reason), '')
  where id = p_redemption_id
  returning * into v_redemption;

  insert into public.employee_points_ledger (organization_id, employee_id, entry_type, amount, reason, related_redemption_id, created_by)
  values (v_redemption.organization_id, v_redemption.employee_id, 'refund', v_redemption.points_spent,
    'Refund: cancelled redemption', v_redemption.id, (select auth.uid()));

  update public.reward_products
  set inventory_quantity = inventory_quantity + 1
  where id = v_redemption.product_id and inventory_quantity is not null;

  perform private.log_audit_event(
    v_redemption.organization_id, 'REWARD_REDEMPTION_CANCELLED', 'reward_redemption', v_redemption.id, null,
    jsonb_build_object('reason', p_reason)
  );
  return v_redemption;
end;
$$;

revoke all on function public.award_employee_points(uuid, integer, text) from public, anon;
revoke all on function public.redeem_reward(uuid) from public, anon;
revoke all on function public.fulfill_redemption(uuid, text) from public, anon;
revoke all on function public.cancel_redemption(uuid, text) from public, anon;
grant execute on function public.award_employee_points(uuid, integer, text) to authenticated;
grant execute on function public.redeem_reward(uuid) to authenticated;
grant execute on function public.fulfill_redemption(uuid, text) to authenticated;
grant execute on function public.cancel_redemption(uuid, text) to authenticated;

-- ============================ FEATURE GATE + PERMISSIONS =======================

insert into public.platform_features (key, name, description) values
  ('rewards_marketplace', 'Rewards & recognition marketplace', 'Lets an organization curate reward vendors/products and employees redeem points for them.')
on conflict (key) do nothing;

insert into public.role_permissions (organization_id, role, permission) values
  -- Every role re-declares its own baseline self-service permissions in
  -- this schema (see compensation.read_self for the same pattern) — being
  -- a Supervisor/Manager/Admin never removes your own right to see and
  -- spend your own points.
  (null, 'employee', 'rewards.read_self'),
  (null, 'employee', 'rewards.redeem_self'),
  (null, 'supervisor', 'rewards.read_self'),
  (null, 'supervisor', 'rewards.redeem_self'),
  (null, 'manager', 'rewards.read_self'),
  (null, 'manager', 'rewards.redeem_self'),
  (null, 'admin', 'rewards.read_self'),
  (null, 'admin', 'rewards.redeem_self'),
  (null, 'admin', 'rewards.award_points'),
  (null, 'admin', 'rewards.manage_catalog'),
  (null, 'admin', 'rewards.fulfill')
on conflict do nothing;
