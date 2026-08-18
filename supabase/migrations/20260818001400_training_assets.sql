-- Halomanage — training/certifications and equipment/asset tracking
-- Ref: PRODUCT_BLUEPRINT.md modules "Training/Certifications", "Asset Management".

create table public.training_courses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  description text,
  is_required boolean not null default false,
  validity_months integer,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.training_courses enable row level security;
create index training_courses_org_idx on public.training_courses(organization_id);

create table public.employee_training (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  course_id uuid not null references public.training_courses(id) on delete cascade,
  status text not null default 'assigned' check (status in ('assigned', 'in_progress', 'completed', 'expired')),
  completed_at timestamptz,
  expires_on date,
  certificate_document_id uuid references public.documents(id),
  created_at timestamptz not null default now()
);
alter table public.employee_training enable row level security;
create index employee_training_employee_idx on public.employee_training(employee_id);
create index employee_training_expiry_idx on public.employee_training(organization_id, expires_on) where expires_on is not null;

create table public.certifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  name text not null,
  issuing_body text,
  issued_on date,
  expires_on date,
  document_id uuid references public.documents(id),
  created_at timestamptz not null default now()
);
alter table public.certifications enable row level security;
create index certifications_employee_idx on public.certifications(employee_id);
create index certifications_expiry_idx on public.certifications(organization_id, expires_on) where expires_on is not null;

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  category text not null check (category in ('laptop', 'phone', 'access_card', 'key', 'uniform', 'vehicle', 'other')),
  name text not null,
  serial_number text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.assets enable row level security;
create index assets_org_idx on public.assets(organization_id);

create table public.employee_asset_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  asset_id uuid not null references public.assets(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  returned_at timestamptz,
  condition_notes text,
  created_by uuid references auth.users(id)
);
alter table public.employee_asset_assignments enable row level security;
create index employee_asset_assignments_employee_idx on public.employee_asset_assignments(employee_id);
create unique index employee_asset_assignments_one_open on public.employee_asset_assignments(asset_id) where returned_at is null;

create policy "org members read training courses" on public.training_courses for select to authenticated
  using (private.is_org_member(organization_id));
create policy "admins manage training courses" on public.training_courses for all to authenticated
  using (private.has_permission(organization_id, 'training.manage'))
  with check (private.has_permission(organization_id, 'training.manage'));

create policy "read own training" on public.employee_training for select to authenticated
  using (employee_id = private.current_employee_id());
create policy "read team training" on public.employee_training for select to authenticated
  using (private.has_permission(organization_id, 'training.manage') and private.in_management_scope(employee_id));
create policy "admins manage training" on public.employee_training for all to authenticated
  using (private.has_permission(organization_id, 'training.manage'))
  with check (private.has_permission(organization_id, 'training.manage'));

create policy "read own certifications" on public.certifications for select to authenticated
  using (employee_id = private.current_employee_id());
create policy "read team certifications" on public.certifications for select to authenticated
  using (private.has_permission(organization_id, 'training.manage') and private.in_management_scope(employee_id));
create policy "admins manage certifications" on public.certifications for all to authenticated
  using (private.has_permission(organization_id, 'training.manage'))
  with check (private.has_permission(organization_id, 'training.manage'));

create policy "org members read assets" on public.assets for select to authenticated
  using (private.is_org_member(organization_id));
create policy "admins manage assets" on public.assets for all to authenticated
  using (private.has_permission(organization_id, 'assets.manage'))
  with check (private.has_permission(organization_id, 'assets.manage'));

create policy "read own asset assignments" on public.employee_asset_assignments for select to authenticated
  using (employee_id = private.current_employee_id());
create policy "admins manage asset assignments" on public.employee_asset_assignments for all to authenticated
  using (private.has_permission(organization_id, 'assets.manage'))
  with check (private.has_permission(organization_id, 'assets.manage'));
