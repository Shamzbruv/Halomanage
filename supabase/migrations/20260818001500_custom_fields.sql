-- Halomanage — employer-defined custom fields
-- Ref: ARCHITECTURE.md "Custom employer fields" — avoid a schema migration
-- every time one employer needs one more HR field on the employee record.

create table public.custom_field_definitions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  entity_type text not null default 'employee' check (entity_type in ('employee')),
  field_key text not null,
  label text not null,
  field_type text not null check (field_type in ('text', 'number', 'date', 'boolean', 'select')),
  options jsonb,
  is_required boolean not null default false,
  sequence integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, entity_type, field_key)
);
alter table public.custom_field_definitions enable row level security;
create index custom_field_definitions_org_idx on public.custom_field_definitions(organization_id, entity_type);

create table public.employee_custom_field_values (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  field_definition_id uuid not null references public.custom_field_definitions(id) on delete cascade,
  value_text text,
  value_number numeric,
  value_date date,
  value_boolean boolean,
  updated_at timestamptz not null default now(),
  unique (employee_id, field_definition_id)
);
alter table public.employee_custom_field_values enable row level security;
create index employee_custom_field_values_employee_idx on public.employee_custom_field_values(employee_id);
create trigger employee_custom_field_values_set_updated_at
  before update on public.employee_custom_field_values
  for each row execute function private.set_updated_at();

create policy "org members read custom field definitions" on public.custom_field_definitions for select to authenticated
  using (private.is_org_member(organization_id));
create policy "admins manage custom field definitions" on public.custom_field_definitions for all to authenticated
  using (private.has_permission(organization_id, 'organization.manage'))
  with check (private.has_permission(organization_id, 'organization.manage'));

create policy "read own custom field values" on public.employee_custom_field_values for select to authenticated
  using (employee_id = private.current_employee_id());
create policy "hr read custom field values" on public.employee_custom_field_values for select to authenticated
  using (private.has_permission(organization_id, 'employee.manage'));
create policy "hr manage custom field values" on public.employee_custom_field_values for all to authenticated
  using (private.has_permission(organization_id, 'employee.manage'))
  with check (private.has_permission(organization_id, 'employee.manage'));
