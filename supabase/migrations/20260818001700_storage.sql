-- Halomanage — private Storage buckets + object-level RLS
-- Ref: ARCHITECTURE.md "Storage RLS" — every HR bucket is private; access is
-- controlled entirely through storage.objects RLS policies keyed off a
-- predictable {organization_id}/{employee_id}/... path, never a public
-- bucket (a public bucket makes any object fetchable by anyone holding the
-- URL, which is never appropriate for employee records).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('employee-documents', 'employee-documents', false, 26214400, null),
  ('leave-attachments', 'leave-attachments', false, 15728640, array['application/pdf', 'image/png', 'image/jpeg']),
  ('appraisal-attachments', 'appraisal-attachments', false, 15728640, null),
  ('payroll-imports', 'payroll-imports', false, 52428800, array[
    'text/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]),
  ('company-policies', 'company-policies', false, 26214400, array['application/pdf']),
  ('signature-artifacts', 'signature-artifacts', false, 10485760, array['application/pdf'])
on conflict (id) do nothing;

-- Path convention: employee-scoped buckets use
-- {organization_id}/{employee_id}/{category}/{filename}; payroll-imports
-- and company-policies use {organization_id}/{filename} (no employee_id —
-- payroll files aren't employee-scoped, and policies are org-wide).

create policy "read employee-documents" on storage.objects for select to authenticated
  using (
    bucket_id = 'employee-documents'
    and (
      (storage.foldername(name))[2] = private.current_employee_id()::text
      or (
        private.has_permission((storage.foldername(name))[1]::uuid, 'documents.manage_team')
        and private.in_management_scope((storage.foldername(name))[2]::uuid)
      )
      or private.has_permission((storage.foldername(name))[1]::uuid, 'documents.manage_org')
    )
  );
create policy "upload employee-documents" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'employee-documents'
    and (
      (storage.foldername(name))[2] = private.current_employee_id()::text
      or private.has_permission((storage.foldername(name))[1]::uuid, 'documents.manage_team')
      or private.has_permission((storage.foldername(name))[1]::uuid, 'documents.manage_org')
    )
  );
create policy "delete employee-documents" on storage.objects for delete to authenticated
  using (private.has_permission((storage.foldername(name))[1]::uuid, 'documents.manage_org'));

create policy "read leave-attachments" on storage.objects for select to authenticated
  using (
    bucket_id = 'leave-attachments'
    and (
      (storage.foldername(name))[2] = private.current_employee_id()::text
      or (
        private.has_permission((storage.foldername(name))[1]::uuid, 'leave.approve_direct_reports')
        and private.in_management_scope((storage.foldername(name))[2]::uuid)
      )
      or private.has_permission((storage.foldername(name))[1]::uuid, 'leave.approve_unit')
    )
  );
create policy "upload leave-attachments" on storage.objects for insert to authenticated
  with check (bucket_id = 'leave-attachments' and (storage.foldername(name))[2] = private.current_employee_id()::text);

create policy "read appraisal-attachments" on storage.objects for select to authenticated
  using (
    bucket_id = 'appraisal-attachments'
    and (
      (storage.foldername(name))[2] = private.current_employee_id()::text
      or (
        private.has_permission((storage.foldername(name))[1]::uuid, 'appraisal.review_direct_reports')
        and private.in_management_scope((storage.foldername(name))[2]::uuid)
      )
      or private.has_permission((storage.foldername(name))[1]::uuid, 'appraisal.manage_cycles')
    )
  );
create policy "upload appraisal-attachments" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'appraisal-attachments'
    and (
      (storage.foldername(name))[2] = private.current_employee_id()::text
      or private.has_permission((storage.foldername(name))[1]::uuid, 'appraisal.manage_cycles')
    )
  );

-- Payroll workbooks: only people holding payroll.import may see or upload
-- the raw files at all — matches the "Payroll Importer" permission concept
-- in PRODUCT_BLUEPRINT.md (a person can upload payroll without needing
-- appraisal/case access, and vice versa nobody gets payroll access by
-- default).
create policy "read payroll-imports" on storage.objects for select to authenticated
  using (bucket_id = 'payroll-imports' and private.has_permission((storage.foldername(name))[1]::uuid, 'payroll.import'));
create policy "upload payroll-imports" on storage.objects for insert to authenticated
  with check (bucket_id = 'payroll-imports' and private.has_permission((storage.foldername(name))[1]::uuid, 'payroll.import'));

create policy "read company-policies" on storage.objects for select to authenticated
  using (bucket_id = 'company-policies' and private.is_org_member((storage.foldername(name))[1]::uuid));
create policy "manage company-policies" on storage.objects for all to authenticated
  using (bucket_id = 'company-policies' and private.has_permission((storage.foldername(name))[1]::uuid, 'documents.manage_org'))
  with check (bucket_id = 'company-policies' and private.has_permission((storage.foldername(name))[1]::uuid, 'documents.manage_org'));

create policy "read signature-artifacts" on storage.objects for select to authenticated
  using (
    bucket_id = 'signature-artifacts'
    and (
      (storage.foldername(name))[2] = private.current_employee_id()::text
      or private.has_permission((storage.foldername(name))[1]::uuid, 'documents.manage_org')
    )
  );
-- No client insert policy on signature-artifacts: those objects are written
-- by the signature-webhook Edge Function using the service_role key, which
-- bypasses RLS by design (see supabase/functions/signature-webhook).
