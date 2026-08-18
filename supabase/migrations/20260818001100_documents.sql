-- Halomanage — document repository, versions, acknowledgements, e-signature
-- Ref: PRODUCT_BLUEPRINT.md "Documents and employee files"; ARCHITECTURE.md
-- "Documents and e-signatures".
--
-- PostgreSQL owns metadata/authorization here; Storage (private buckets,
-- see 20260818001700_storage.sql) owns the binary. A policy acknowledgement
-- is a real timestamped record, not just "a PDF exists somewhere".

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- null employee_id = an org-wide document (e.g. the employee handbook)
  employee_id uuid references public.employees(id) on delete cascade,
  category text not null check (category in (
    'contract', 'identification', 'certificate', 'policy', 'hr_letter',
    'medical', 'appraisal', 'payroll', 'other'
  )),
  title text not null,
  description text,
  -- self: employee + HR | team: + supervisor/manager in scope | org: any org member | hr_only: employee.manage only
  visibility text not null default 'self' check (visibility in ('self', 'team', 'org', 'hr_only')),
  requires_acknowledgement boolean not null default false,
  expires_on date,
  is_active boolean not null default true,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
alter table public.documents enable row level security;
create index documents_org_idx on public.documents(organization_id);
create index documents_employee_idx on public.documents(employee_id);
create index documents_expiry_idx on public.documents(organization_id, expires_on) where expires_on is not null;

create table public.document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  version_number integer not null,
  storage_bucket text not null default 'employee-documents',
  storage_path text not null,
  file_name text not null,
  mime_type text,
  file_size bigint,
  checksum text,
  uploaded_by uuid references auth.users(id),
  uploaded_at timestamptz not null default now(),
  unique (document_id, version_number)
);
alter table public.document_versions enable row level security;
create index document_versions_document_idx on public.document_versions(document_id);

alter table public.documents add column current_version_id uuid references public.document_versions(id);

create table public.document_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  document_version_id uuid not null references public.document_versions(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  acknowledged_at timestamptz not null default now(),
  ip_address inet,
  user_agent text,
  unique (document_version_id, employee_id)
);
alter table public.document_acknowledgements enable row level security;
create index document_acknowledgements_employee_idx on public.document_acknowledgements(employee_id);

create table public.signature_requests (
  id uuid primary key default gen_random_uuid(),
  document_version_id uuid not null references public.document_versions(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'signed', 'declined', 'expired')),
  -- populated by the signature-webhook Edge Function integrating an
  -- external e-signature provider (ARCHITECTURE.md: don't rebuild a
  -- signature trust platform in-house for legally significant signatures).
  external_provider text,
  external_reference text,
  requested_at timestamptz not null default now(),
  completed_at timestamptz
);
alter table public.signature_requests enable row level security;
create index signature_requests_employee_idx on public.signature_requests(employee_id);

create or replace function private.can_see_document(p_org_id uuid, p_employee_id uuid, p_visibility text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_visibility
    when 'org' then private.is_org_member(p_org_id)
    when 'self' then p_employee_id = private.current_employee_id()
      or private.has_permission(p_org_id, 'documents.manage_team')
      or private.has_permission(p_org_id, 'documents.manage_org')
    when 'team' then p_employee_id = private.current_employee_id()
      or (private.has_permission(p_org_id, 'documents.manage_team') and private.in_management_scope(p_employee_id))
      or private.has_permission(p_org_id, 'documents.manage_org')
    when 'hr_only' then private.has_permission(p_org_id, 'documents.manage_org')
    else false
  end;
$$;

create or replace function public.acknowledge_document(p_document_version_id uuid)
returns public.document_acknowledgements
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee_id uuid := private.current_employee_id();
  v_row public.document_acknowledgements;
begin
  if v_employee_id is null then
    raise exception 'No employee record for the current user';
  end if;

  insert into public.document_acknowledgements (document_version_id, employee_id)
  values (p_document_version_id, v_employee_id)
  on conflict (document_version_id, employee_id) do update set acknowledged_at = now()
  returning * into v_row;

  return v_row;
end;
$$;
revoke execute on function public.acknowledge_document(uuid) from public;
grant execute on function public.acknowledge_document(uuid) to authenticated;

create policy "read visible documents" on public.documents for select to authenticated
  using (private.can_see_document(organization_id, employee_id, visibility));
create policy "managers write team documents" on public.documents for all to authenticated
  using (private.has_permission(organization_id, 'documents.manage_team') and (employee_id is null or private.in_management_scope(employee_id)))
  with check (private.has_permission(organization_id, 'documents.manage_team') and (employee_id is null or private.in_management_scope(employee_id)));
create policy "admins manage all documents" on public.documents for all to authenticated
  using (private.has_permission(organization_id, 'documents.manage_org'))
  with check (private.has_permission(organization_id, 'documents.manage_org'));

create policy "read visible document versions" on public.document_versions for select to authenticated
  using (document_id in (
    select id from public.documents d where private.can_see_document(d.organization_id, d.employee_id, d.visibility)
  ));
create policy "managers upload team document versions" on public.document_versions for insert to authenticated
  with check (document_id in (
    select id from public.documents d
    where private.has_permission(d.organization_id, 'documents.manage_team') and (d.employee_id is null or private.in_management_scope(d.employee_id))
  ));
create policy "admins manage document versions" on public.document_versions for all to authenticated
  using (document_id in (select id from public.documents d where private.has_permission(d.organization_id, 'documents.manage_org')))
  with check (document_id in (select id from public.documents d where private.has_permission(d.organization_id, 'documents.manage_org')));

create policy "read own acknowledgements" on public.document_acknowledgements for select to authenticated
  using (employee_id = private.current_employee_id());
create policy "hr read acknowledgements" on public.document_acknowledgements for select to authenticated
  using (document_version_id in (
    select v.id from public.document_versions v join public.documents d on d.id = v.document_id
    where private.has_permission(d.organization_id, 'documents.manage_org')
  ));
-- Writes go only through acknowledge_document().

create policy "read own signature requests" on public.signature_requests for select to authenticated
  using (employee_id = private.current_employee_id());
create policy "hr manage signature requests" on public.signature_requests for all to authenticated
  using (document_version_id in (
    select v.id from public.document_versions v join public.documents d on d.id = v.document_id
    where private.has_permission(d.organization_id, 'documents.manage_org')
  ))
  with check (document_version_id in (
    select v.id from public.document_versions v join public.documents d on d.id = v.document_id
    where private.has_permission(d.organization_id, 'documents.manage_org')
  ));
