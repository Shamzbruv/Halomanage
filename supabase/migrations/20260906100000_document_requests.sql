-- Halomanage — employee document requests (job letters, employment/salary
-- verification, reference letters, etc.)
-- Ref: user request this session — "a section where the employee can
-- request documents from the company, like job letters etc."
--
-- This table tracks only the *request* lifecycle (what was asked for, why,
-- and its status) — never the file itself. Fulfilling a request creates a
-- real row in the existing documents/document_versions tables (category
-- 'hr_letter', visibility 'self', employee_id = the requester), so the
-- resulting letter shows up on the employee's own Documents page exactly
-- like any other HR-shared file, downloadable through the same
-- DocumentDownloadButton already used there. No new storage bucket, no
-- parallel file-serving path — this reuses 20260818001100_documents.sql's
-- model end to end.

create table public.document_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  request_type text not null check (request_type in (
    'employment_verification', 'salary_verification', 'reference_letter',
    'certificate_of_service', 'other'
  )),
  request_type_other_label text,
  purpose text,
  status text not null default 'submitted' check (status in (
    'submitted', 'fulfilled', 'rejected', 'cancelled'
  )),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users(id),
  rejection_reason text,
  fulfilled_document_id uuid references public.documents(id),
  check (request_type != 'other' or request_type_other_label is not null)
);
alter table public.document_requests enable row level security;
create index document_requests_employee_idx on public.document_requests(employee_id, requested_at desc);
create index document_requests_org_status_idx on public.document_requests(organization_id, status);

comment on table public.document_requests is
  'An employee''s request for a document (job letter, verification, etc.) HR hasn''t proactively issued. Writes go only through the RPCs below.';

-- ---------------------------------------------------------------------------
-- RPCs (SECURITY DEFINER — document_requests grants no direct client write
-- access, only these functions do, same pattern as leave_requests).
-- ---------------------------------------------------------------------------

create or replace function public.request_document(
  p_request_type text,
  p_request_type_other_label text default null,
  p_purpose text default null
)
returns public.document_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  v_request public.document_requests;
begin
  select * into v_employee from public.employees e where e.user_id = (select auth.uid());
  if v_employee.id is null then
    raise exception 'No employee record for the current user';
  end if;

  if p_request_type not in (
    'employment_verification', 'salary_verification', 'reference_letter', 'certificate_of_service', 'other'
  ) then
    raise exception 'Unknown document request type';
  end if;

  if p_request_type = 'other' and coalesce(btrim(p_request_type_other_label), '') = '' then
    raise exception 'Please describe the document you need';
  end if;

  insert into public.document_requests (
    organization_id, employee_id, request_type, request_type_other_label, purpose
  )
  values (
    v_employee.organization_id, v_employee.id, p_request_type,
    nullif(btrim(p_request_type_other_label), ''), nullif(btrim(p_purpose), '')
  )
  returning * into v_request;

  perform private.log_audit_event(
    v_employee.organization_id, 'DOCUMENT_REQUEST_SUBMITTED', 'document_request', v_request.id, null, to_jsonb(v_request)
  );

  return v_request;
end;
$$;

create or replace function public.cancel_document_request(p_request_id uuid)
returns public.document_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.document_requests;
begin
  select * into v_request from public.document_requests where id = p_request_id for update;
  if v_request.id is null then
    raise exception 'Document request not found';
  end if;
  if v_request.employee_id != private.current_employee_id() then
    raise exception 'Not authorized to cancel this request';
  end if;
  if v_request.status != 'submitted' then
    raise exception 'This request has already been decided and can no longer be cancelled';
  end if;

  update public.document_requests set status = 'cancelled' where id = p_request_id returning * into v_request;

  perform private.log_audit_event(
    v_request.organization_id, 'DOCUMENT_REQUEST_CANCELLED', 'document_request', v_request.id, null, to_jsonb(v_request)
  );

  return v_request;
end;
$$;

-- Called after the client has already created the documents/document_versions
-- rows for the requesting employee (same insert sequence DocumentUploadForm
-- already uses) — this just verifies that document actually belongs to this
-- request's employee/organization and marks the request fulfilled, so a
-- fulfilled request can never point at the wrong person's file.
create or replace function public.fulfill_document_request(p_request_id uuid, p_document_id uuid)
returns public.document_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.document_requests;
  v_document public.documents;
begin
  select * into v_request from public.document_requests where id = p_request_id for update;
  if v_request.id is null then
    raise exception 'Document request not found';
  end if;
  if v_request.status != 'submitted' then
    raise exception 'This request has already been decided';
  end if;

  if not (
    private.has_permission(v_request.organization_id, 'documents.manage_org')
    or (private.has_permission(v_request.organization_id, 'documents.manage_team') and private.in_management_scope(v_request.employee_id))
  ) then
    raise exception 'Not authorized to fulfill this request';
  end if;

  select * into v_document from public.documents where id = p_document_id;
  if v_document.id is null then
    raise exception 'Document not found';
  end if;
  if v_document.organization_id != v_request.organization_id or v_document.employee_id is distinct from v_request.employee_id then
    raise exception 'That document does not belong to this request''s employee';
  end if;

  update public.document_requests
  set status = 'fulfilled', fulfilled_document_id = p_document_id, decided_at = now(), decided_by = auth.uid()
  where id = p_request_id
  returning * into v_request;

  perform private.log_audit_event(
    v_request.organization_id, 'DOCUMENT_REQUEST_FULFILLED', 'document_request', v_request.id, null, to_jsonb(v_request)
  );

  return v_request;
end;
$$;

create or replace function public.reject_document_request(p_request_id uuid, p_reason text)
returns public.document_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.document_requests;
begin
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A reason is required';
  end if;

  select * into v_request from public.document_requests where id = p_request_id for update;
  if v_request.id is null then
    raise exception 'Document request not found';
  end if;
  if v_request.status != 'submitted' then
    raise exception 'This request has already been decided';
  end if;

  if not (
    private.has_permission(v_request.organization_id, 'documents.manage_org')
    or (private.has_permission(v_request.organization_id, 'documents.manage_team') and private.in_management_scope(v_request.employee_id))
  ) then
    raise exception 'Not authorized to reject this request';
  end if;

  update public.document_requests
  set status = 'rejected', rejection_reason = btrim(p_reason), decided_at = now(), decided_by = auth.uid()
  where id = p_request_id
  returning * into v_request;

  perform private.log_audit_event(
    v_request.organization_id, 'DOCUMENT_REQUEST_REJECTED', 'document_request', v_request.id, null, to_jsonb(v_request)
  );

  return v_request;
end;
$$;

revoke execute on function public.request_document(text, text, text) from public;
revoke execute on function public.cancel_document_request(uuid) from public;
revoke execute on function public.fulfill_document_request(uuid, uuid) from public;
revoke execute on function public.reject_document_request(uuid, text) from public;
grant execute on function public.request_document(text, text, text) to authenticated;
grant execute on function public.cancel_document_request(uuid) to authenticated;
grant execute on function public.fulfill_document_request(uuid, uuid) to authenticated;
grant execute on function public.reject_document_request(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Notify the employee once their request is decided — same shape as
-- private.notify_leave_decided() in 20260818001300_notifications.sql. There
-- is deliberately no "new request submitted" notification to HR here: unlike
-- leave, a document request has no single assigned approver to notify (any
-- documents.manage_org/.manage_team holder can act on it), so it's surfaced
-- as a live query instead — see admin/documents' "Document requests" queue
-- and the dashboard's admin-actions feed.
-- ---------------------------------------------------------------------------

create or replace function private.notify_document_request_decided()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee_user uuid;
begin
  if new.status in ('fulfilled', 'rejected') and old.status is distinct from new.status then
    select user_id into v_employee_user from public.employees where id = new.employee_id;
    if v_employee_user is not null then
      perform private.create_notification(
        new.organization_id, v_employee_user, new.employee_id,
        case new.status when 'fulfilled' then 'document_request.fulfilled' else 'document_request.rejected' end,
        case new.status when 'fulfilled' then 'Your document request is ready' else 'Your document request was declined' end,
        case new.status when 'rejected' then new.rejection_reason else null end,
        '/documents', jsonb_build_object('document_request_id', new.id)
      );
    end if;
  end if;
  return new;
end;
$$;

create trigger document_requests_notify_decided
  after update on public.document_requests
  for each row execute function private.notify_document_request_decided();

-- ---------------------------------------------------------------------------
-- RLS policies
-- ---------------------------------------------------------------------------

create policy "read own document requests" on public.document_requests for select to authenticated
  using (employee_id = private.current_employee_id());
create policy "read team document requests" on public.document_requests for select to authenticated
  using (private.has_permission(organization_id, 'documents.manage_team') and private.in_management_scope(employee_id));
create policy "read org document requests" on public.document_requests for select to authenticated
  using (private.has_permission(organization_id, 'documents.manage_org'));
-- Writes go only through request_document()/cancel_document_request()/
-- fulfill_document_request()/reject_document_request().

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.document_requests;
  end if;
end $$;
