-- Halomanage — organizations, org structure, positions
-- Ref: PRODUCT_BLUEPRINT.md "Organization Structure"; ARCHITECTURE.md "Core schema comparison".
--
-- RLS is enabled on every table here but no policies are attached yet —
-- that makes the tables fail closed (no access at all except service_role)
-- until 20260818000400_authorization.sql adds the real policies once the
-- private.has_org_role()/private.current_employee_id() helpers exist.

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug citext not null unique,
  timezone text not null default 'UTC',
  country_code text,
  settings jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.organizations enable row level security;

create table public.org_units (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  parent_id uuid references public.org_units(id) on delete restrict,
  name text not null,
  -- company | division | department | team | other
  type text not null default 'department',
  code text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);
alter table public.org_units enable row level security;
create index org_units_org_idx on public.org_units(organization_id);
create index org_units_parent_idx on public.org_units(parent_id);

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  address_line1 text,
  address_line2 text,
  city text,
  region text,
  country_code text,
  postal_code text,
  timezone text,
  latitude double precision,
  longitude double precision,
  geofence_radius_meters integer,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.locations enable row level security;
create index locations_org_idx on public.locations(organization_id);

create table public.positions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  title text not null,
  job_code text,
  description text,
  grade text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.positions enable row level security;
create index positions_org_idx on public.positions(organization_id);

create or replace function private.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function private.set_updated_at();

create trigger org_units_set_updated_at
  before update on public.org_units
  for each row execute function private.set_updated_at();

create trigger positions_set_updated_at
  before update on public.positions
  for each row execute function private.set_updated_at();
