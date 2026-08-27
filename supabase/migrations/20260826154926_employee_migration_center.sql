-- Halomanage — employee Migration Center
--
-- Provides an auditable Upload -> Map -> Validate -> Preview -> Commit flow
-- for employee directory data. Raw files remain private, staged rows never
-- write directly to employees, and every commit is one database transaction.

create table public.employee_import_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_system text not null default 'spreadsheet'
    check (source_system in ('spreadsheet', 'orangehrm', 'bamboohr', 'zoho_people', 'other')),
  original_file_name text not null,
  original_file_path text not null,
  file_hash text not null,
  duplicate_strategy text not null default 'update'
    check (duplicate_strategy in ('update', 'skip')),
  column_mapping jsonb not null default '{}'::jsonb,
  source_headers jsonb not null default '[]'::jsonb,
  status text not null default 'uploaded' check (status in (
    'uploaded', 'processing', 'needs_mapping', 'needs_review',
    'ready_for_import', 'committed', 'failed', 'rolled_back'
  )),
  total_rows integer not null default 0 check (total_rows >= 0),
  valid_rows integer not null default 0 check (valid_rows >= 0),
  error_rows integer not null default 0 check (error_rows >= 0),
  create_rows integer not null default 0 check (create_rows >= 0),
  update_rows integer not null default 0 check (update_rows >= 0),
  skip_rows integer not null default 0 check (skip_rows >= 0),
  error_message text,
  uploaded_by uuid not null references auth.users(id),
  uploaded_at timestamptz not null default now(),
  committed_by uuid references auth.users(id),
  committed_at timestamptz,
  rolled_back_by uuid references auth.users(id),
  rolled_back_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(column_mapping) = 'object'),
  check (jsonb_typeof(source_headers) = 'array')
);

alter table public.employee_import_batches enable row level security;
create index employee_import_batches_org_status_idx
  on public.employee_import_batches (organization_id, status, uploaded_at desc);
create index employee_import_batches_uploader_idx
  on public.employee_import_batches (uploaded_by, uploaded_at desc);
create trigger employee_import_batches_set_updated_at
  before update on public.employee_import_batches
  for each row execute function private.set_updated_at();

create table public.employee_import_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.employee_import_batches(id) on delete cascade,
  row_number integer not null check (row_number > 0),
  raw_row jsonb not null,
  normalized_row jsonb not null default '{}'::jsonb,
  matched_employee_id uuid references public.employees(id) on delete restrict,
  operation text not null default 'create' check (operation in ('create', 'update', 'skip')),
  validation_status text not null default 'error' check (validation_status in ('valid', 'warning', 'error')),
  validation_errors jsonb not null default '[]'::jsonb,
  commit_status text not null default 'pending' check (commit_status in ('pending', 'committed', 'rolled_back')),
  committed_employee_id uuid references public.employees(id) on delete set null,
  prior_employee jsonb,
  committed_employee_updated_at timestamptz,
  committed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (batch_id, row_number),
  check (jsonb_typeof(raw_row) = 'object'),
  check (jsonb_typeof(normalized_row) = 'object'),
  check (jsonb_typeof(validation_errors) = 'array')
);

alter table public.employee_import_rows enable row level security;
create index employee_import_rows_batch_status_idx
  on public.employee_import_rows (batch_id, validation_status, row_number);
create index employee_import_rows_match_idx
  on public.employee_import_rows (matched_employee_id)
  where matched_employee_id is not null;
create index employee_import_rows_committed_employee_idx
  on public.employee_import_rows (committed_employee_id)
  where committed_employee_id is not null;

comment on table public.employee_import_batches is
  'Auditable employee imports. Files and staged rows are inert until an authorized user commits a fully validated batch.';
comment on table public.employee_import_rows is
  'Raw and normalized employee import rows with validation, intended operation, and rollback metadata.';

-- Newer Supabase projects no longer expose new public tables to the Data API
-- automatically. Opt in only to the reads the UI needs; all writes use RPCs
-- or the trusted employee-import Edge Function.
revoke all on table public.employee_import_batches, public.employee_import_rows from anon, authenticated;
grant select on table public.employee_import_batches, public.employee_import_rows to authenticated;

create policy "employee managers read import batches"
on public.employee_import_batches for select to authenticated
using ((select private.has_permission(organization_id, 'employee.manage')));

create policy "employee managers read import rows"
on public.employee_import_rows for select to authenticated
using (
  exists (
    select 1
    from public.employee_import_batches b
    where b.id = batch_id
      and (select private.has_permission(b.organization_id, 'employee.manage'))
  )
);

create or replace function private.safe_import_date(p_value text)
returns date
language plpgsql
immutable
set search_path = ''
as $$
begin
  if nullif(btrim(p_value), '') is null then
    return null;
  end if;
  return p_value::date;
exception when others then
  return null;
end;
$$;

revoke execute on function private.safe_import_date(text)
  from public, anon, authenticated, service_role;

create or replace function public.create_employee_import_batch(
  p_organization_id uuid,
  p_source_system text,
  p_original_file_name text,
  p_original_file_path text,
  p_file_hash text,
  p_duplicate_strategy text default 'update',
  p_column_mapping jsonb default '{}'::jsonb
)
returns public.employee_import_batches
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.employee_import_batches;
begin
  if auth.uid() is null or not private.has_permission(p_organization_id, 'employee.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to import employees';
  end if;
  if p_source_system not in ('spreadsheet', 'orangehrm', 'bamboohr', 'zoho_people', 'other') then
    raise exception using errcode = '22023', message = 'Unsupported source system';
  end if;
  if p_duplicate_strategy not in ('update', 'skip') then
    raise exception using errcode = '22023', message = 'Duplicate strategy must be update or skip';
  end if;
  if nullif(btrim(p_original_file_name), '') is null
     or nullif(btrim(p_original_file_path), '') is null
     or nullif(btrim(p_file_hash), '') is null then
    raise exception using errcode = '22023', message = 'File name, path, and checksum are required';
  end if;
  if p_column_mapping is null or jsonb_typeof(p_column_mapping) <> 'object' then
    raise exception using errcode = '22023', message = 'Column mapping must be a JSON object';
  end if;

  insert into public.employee_import_batches (
    organization_id, source_system, original_file_name, original_file_path,
    file_hash, duplicate_strategy, column_mapping, uploaded_by
  ) values (
    p_organization_id, p_source_system, left(btrim(p_original_file_name), 255),
    btrim(p_original_file_path), btrim(p_file_hash), p_duplicate_strategy,
    p_column_mapping, auth.uid()
  ) returning * into v_batch;

  perform private.log_audit_event(
    p_organization_id, 'EMPLOYEE_IMPORT_UPLOADED', 'employee_import_batch',
    v_batch.id, null,
    jsonb_build_object(
      'source_system', p_source_system,
      'file_name', v_batch.original_file_name,
      'file_hash', v_batch.file_hash
    )
  );
  return v_batch;
end;
$$;

create or replace function public.update_employee_import_mapping(
  p_batch_id uuid,
  p_column_mapping jsonb,
  p_duplicate_strategy text default null
)
returns public.employee_import_batches
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.employee_import_batches;
begin
  select * into v_batch
  from public.employee_import_batches
  where id = p_batch_id
  for update;

  if v_batch.id is null then
    raise exception using errcode = 'P0002', message = 'Import batch not found';
  end if;
  if auth.uid() is null or not private.has_permission(v_batch.organization_id, 'employee.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to change this import';
  end if;
  if v_batch.status in ('committed', 'rolled_back') then
    raise exception using errcode = '55000', message = 'A completed import cannot be remapped';
  end if;
  if p_column_mapping is null or jsonb_typeof(p_column_mapping) <> 'object' then
    raise exception using errcode = '22023', message = 'Column mapping must be a JSON object';
  end if;
  if p_duplicate_strategy is not null and p_duplicate_strategy not in ('update', 'skip') then
    raise exception using errcode = '22023', message = 'Duplicate strategy must be update or skip';
  end if;

  update public.employee_import_batches
  set column_mapping = p_column_mapping,
      duplicate_strategy = coalesce(p_duplicate_strategy, duplicate_strategy),
      status = 'uploaded',
      error_message = null
  where id = p_batch_id
  returning * into v_batch;

  return v_batch;
end;
$$;

create or replace function public.revalidate_employee_import_batch(p_batch_id uuid)
returns public.employee_import_batches
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.employee_import_batches;
  v_row public.employee_import_rows;
  v_data jsonb;
  v_errors jsonb;
  v_employee_number text;
  v_first_name text;
  v_last_name text;
  v_status text;
  v_work_email text;
  v_external_id text;
  v_hire_date_text text;
  v_probation_date_text text;
  v_match_ids uuid[];
  v_match_count integer;
  v_match_id uuid;
  v_duplicate_count integer;
  v_total integer;
  v_valid integer;
  v_errors_count integer;
  v_creates integer;
  v_updates integer;
  v_skips integer;
  v_missing_mapping boolean;
begin
  select * into v_batch
  from public.employee_import_batches
  where id = p_batch_id
  for update;

  if v_batch.id is null then
    raise exception using errcode = 'P0002', message = 'Import batch not found';
  end if;
  if auth.uid() is null or not private.has_permission(v_batch.organization_id, 'employee.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to validate this import';
  end if;
  if v_batch.status in ('committed', 'rolled_back') then
    raise exception using errcode = '55000', message = 'A completed import cannot be revalidated';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_batch_id::text, 11));

  for v_row in
    select * from public.employee_import_rows
    where batch_id = p_batch_id
    order by row_number
    for update
  loop
    v_data := v_row.normalized_row;
    v_errors := '[]'::jsonb;
    v_employee_number := nullif(btrim(v_data->>'employee_number'), '');
    v_first_name := nullif(btrim(v_data->>'first_name'), '');
    v_last_name := nullif(btrim(v_data->>'last_name'), '');
    v_status := coalesce(nullif(lower(btrim(v_data->>'status')), ''), 'prehire');
    v_work_email := nullif(lower(btrim(v_data->>'work_email')), '');
    v_external_id := nullif(btrim(v_data->>'external_payroll_id'), '');
    v_hire_date_text := nullif(btrim(v_data->>'hire_date'), '');
    v_probation_date_text := nullif(btrim(v_data->>'probation_end_date'), '');

    if v_employee_number is null then
      v_errors := v_errors || jsonb_build_array('Employee number is required');
    elsif char_length(v_employee_number) > 80 then
      v_errors := v_errors || jsonb_build_array('Employee number must be 80 characters or fewer');
    end if;
    if v_first_name is null then
      v_errors := v_errors || jsonb_build_array('First name is required');
    elsif char_length(v_first_name) > 80 then
      v_errors := v_errors || jsonb_build_array('First name must be 80 characters or fewer');
    end if;
    if v_last_name is null then
      v_errors := v_errors || jsonb_build_array('Last name is required');
    elsif char_length(v_last_name) > 80 then
      v_errors := v_errors || jsonb_build_array('Last name must be 80 characters or fewer');
    end if;
    if v_status not in ('prehire', 'active', 'leave', 'suspended', 'terminated') then
      v_errors := v_errors || jsonb_build_array('Status must be prehire, active, leave, suspended, or terminated');
    end if;
    if v_work_email is not null and v_work_email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
      v_errors := v_errors || jsonb_build_array('Work email is not valid');
    end if;
    if v_hire_date_text is not null and private.safe_import_date(v_hire_date_text) is null then
      v_errors := v_errors || jsonb_build_array('Hire date must be a valid date');
    end if;
    if v_probation_date_text is not null and private.safe_import_date(v_probation_date_text) is null then
      v_errors := v_errors || jsonb_build_array('Probation end date must be a valid date');
    end if;

    select coalesce(array_agg(distinct e.id), '{}'::uuid[])
    into v_match_ids
    from public.employees e
    where e.organization_id = v_batch.organization_id
      and (
        (v_employee_number is not null and e.employee_number = v_employee_number)
        or (v_external_id is not null and e.external_payroll_id = v_external_id)
        or (v_work_email is not null and lower(e.work_email::text) = v_work_email)
      );

    v_match_count := coalesce(cardinality(v_match_ids), 0);
    v_match_id := case when v_match_count = 1 then v_match_ids[1] else null end;
    if v_match_count > 1 then
      v_errors := v_errors || jsonb_build_array('Identifiers match more than one existing employee');
    end if;

    select count(*) into v_duplicate_count
    from public.employee_import_rows other_row
    where other_row.batch_id = p_batch_id
      and other_row.id <> v_row.id
      and v_employee_number is not null
      and lower(nullif(btrim(other_row.normalized_row->>'employee_number'), '')) = lower(v_employee_number);

    if v_duplicate_count > 0 then
      v_errors := v_errors || jsonb_build_array('Employee number appears more than once in this file');
    end if;

    update public.employee_import_rows
    set matched_employee_id = v_match_id,
        operation = case
          when v_match_id is null then 'create'
          when v_batch.duplicate_strategy = 'skip' then 'skip'
          else 'update'
        end,
        validation_status = case
          when jsonb_array_length(v_errors) > 0 then 'error'
          when v_match_id is not null and v_batch.duplicate_strategy = 'skip' then 'warning'
          else 'valid'
        end,
        validation_errors = v_errors,
        commit_status = 'pending',
        prior_employee = null,
        committed_employee_id = null,
        committed_employee_updated_at = null,
        committed_at = null
    where id = v_row.id;
  end loop;

  select
    count(*),
    count(*) filter (where validation_status in ('valid', 'warning')),
    count(*) filter (where validation_status = 'error'),
    count(*) filter (where operation = 'create' and validation_status <> 'error'),
    count(*) filter (where operation = 'update' and validation_status <> 'error'),
    count(*) filter (where operation = 'skip' and validation_status <> 'error')
  into v_total, v_valid, v_errors_count, v_creates, v_updates, v_skips
  from public.employee_import_rows
  where batch_id = p_batch_id;

  select v_total > 0 and count(*) = v_total
  into v_missing_mapping
  from public.employee_import_rows
  where batch_id = p_batch_id
    and (
      nullif(btrim(normalized_row->>'employee_number'), '') is null
      or nullif(btrim(normalized_row->>'first_name'), '') is null
      or nullif(btrim(normalized_row->>'last_name'), '') is null
    );

  update public.employee_import_batches
  set total_rows = v_total,
      valid_rows = v_valid,
      error_rows = v_errors_count,
      create_rows = v_creates,
      update_rows = v_updates,
      skip_rows = v_skips,
      status = case
        when v_total = 0 then 'failed'
        when v_missing_mapping then 'needs_mapping'
        when v_errors_count > 0 then 'needs_review'
        else 'ready_for_import'
      end,
      error_message = case when v_total = 0 then 'The workbook does not contain any data rows' else null end
  where id = p_batch_id
  returning * into v_batch;

  return v_batch;
end;
$$;

create or replace function public.commit_employee_import_batch(p_batch_id uuid)
returns public.employee_import_batches
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.employee_import_batches;
  v_row public.employee_import_rows;
  v_employee public.employees;
  v_data jsonb;
  v_status text;
  v_committed_at timestamptz := clock_timestamp();
begin
  select * into v_batch
  from public.employee_import_batches
  where id = p_batch_id
  for update;

  if v_batch.id is null then
    raise exception using errcode = 'P0002', message = 'Import batch not found';
  end if;
  if auth.uid() is null or not private.has_permission(v_batch.organization_id, 'employee.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to commit this import';
  end if;
  if v_batch.status <> 'ready_for_import' then
    raise exception using errcode = '55000', message = 'Resolve every validation error before importing';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_batch.organization_id::text, 12));

  for v_row in
    select * from public.employee_import_rows
    where batch_id = p_batch_id
      and validation_status in ('valid', 'warning')
    order by row_number
    for update
  loop
    v_data := v_row.normalized_row;
    v_status := coalesce(nullif(lower(btrim(v_data->>'status')), ''), 'prehire');

    if v_row.operation = 'create' then
      insert into public.employees (
        organization_id, employee_number, external_payroll_id, first_name,
        last_name, preferred_name, work_email, work_phone, status, hire_date,
        probation_end_date
      ) values (
        v_batch.organization_id,
        btrim(v_data->>'employee_number'),
        nullif(btrim(v_data->>'external_payroll_id'), ''),
        btrim(v_data->>'first_name'),
        btrim(v_data->>'last_name'),
        nullif(btrim(v_data->>'preferred_name'), ''),
        nullif(btrim(v_data->>'work_email'), '')::public.citext,
        nullif(btrim(v_data->>'work_phone'), ''),
        v_status,
        private.safe_import_date(v_data->>'hire_date'),
        private.safe_import_date(v_data->>'probation_end_date')
      ) returning * into v_employee;

      update public.employee_import_rows
      set commit_status = 'committed',
          committed_employee_id = v_employee.id,
          committed_employee_updated_at = v_employee.updated_at,
          committed_at = v_committed_at
      where id = v_row.id;

    elsif v_row.operation = 'update' then
      select * into v_employee
      from public.employees
      where id = v_row.matched_employee_id
        and organization_id = v_batch.organization_id
      for update;

      if v_employee.id is null then
        raise exception using errcode = 'P0002', message = 'A matched employee no longer exists';
      end if;

      update public.employee_import_rows
      set prior_employee = to_jsonb(v_employee)
      where id = v_row.id;

      update public.employees
      set employee_number = btrim(v_data->>'employee_number'),
          external_payroll_id = case when v_data ? 'external_payroll_id' then nullif(btrim(v_data->>'external_payroll_id'), '') else external_payroll_id end,
          first_name = btrim(v_data->>'first_name'),
          last_name = btrim(v_data->>'last_name'),
          preferred_name = case when v_data ? 'preferred_name' then nullif(btrim(v_data->>'preferred_name'), '') else preferred_name end,
          work_email = case when v_data ? 'work_email' then nullif(btrim(v_data->>'work_email'), '')::public.citext else work_email end,
          work_phone = case when v_data ? 'work_phone' then nullif(btrim(v_data->>'work_phone'), '') else work_phone end,
          status = v_status,
          hire_date = case when v_data ? 'hire_date' then private.safe_import_date(v_data->>'hire_date') else hire_date end,
          probation_end_date = case when v_data ? 'probation_end_date' then private.safe_import_date(v_data->>'probation_end_date') else probation_end_date end
      where id = v_employee.id
      returning * into v_employee;

      update public.employee_import_rows
      set commit_status = 'committed',
          committed_employee_id = v_employee.id,
          committed_employee_updated_at = v_employee.updated_at,
          committed_at = v_committed_at
      where id = v_row.id;
    else
      update public.employee_import_rows
      set commit_status = 'committed', committed_at = v_committed_at
      where id = v_row.id;
    end if;
  end loop;

  update public.employee_import_batches
  set status = 'committed',
      committed_by = auth.uid(),
      committed_at = v_committed_at,
      error_message = null
  where id = p_batch_id
  returning * into v_batch;

  perform private.log_audit_event(
    v_batch.organization_id, 'EMPLOYEE_IMPORT_COMMITTED', 'employee_import_batch',
    v_batch.id, null,
    jsonb_build_object(
      'created', v_batch.create_rows,
      'updated', v_batch.update_rows,
      'skipped', v_batch.skip_rows,
      'file_hash', v_batch.file_hash
    )
  );

  return v_batch;
end;
$$;

create or replace function public.rollback_employee_import_batch(p_batch_id uuid)
returns public.employee_import_batches
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.employee_import_batches;
  v_row public.employee_import_rows;
  v_employee public.employees;
  v_prior jsonb;
begin
  select * into v_batch
  from public.employee_import_batches
  where id = p_batch_id
  for update;

  if v_batch.id is null then
    raise exception using errcode = 'P0002', message = 'Import batch not found';
  end if;
  if auth.uid() is null or not private.has_permission(v_batch.organization_id, 'employee.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to roll back this import';
  end if;
  if v_batch.status <> 'committed' then
    raise exception using errcode = '55000', message = 'Only a committed import can be rolled back';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_batch.organization_id::text, 13));

  -- Refuse before changing anything if a created employee has subsequently
  -- gained an account, assignment, or HR activity. This keeps rollback from
  -- becoming a destructive cascade after the organization starts using it.
  if exists (
    select 1
    from public.employee_import_rows r
    join public.employees e on e.id = r.committed_employee_id
    where r.batch_id = p_batch_id
      and r.operation = 'create'
      and (
        e.user_id is not null
        or e.updated_at is distinct from r.committed_employee_updated_at
        or exists (select 1 from public.employee_assignments ea where ea.employee_id = e.id)
        or exists (select 1 from public.attendance_sessions a where a.employee_id = e.id)
        or exists (select 1 from public.leave_requests l where l.employee_id = e.id)
        or exists (select 1 from public.onboarding_runs o where o.employee_id = e.id)
        or exists (select 1 from public.offboarding_runs o where o.employee_id = e.id)
        or exists (select 1 from public.employee_training t where t.employee_id = e.id)
        or exists (select 1 from public.certifications c where c.employee_id = e.id)
        or exists (select 1 from public.employee_asset_assignments a where a.employee_id = e.id)
      )
  ) then
    raise exception using errcode = '55000', message = 'Rollback is blocked because one or more imported employees now have workspace activity';
  end if;

  if exists (
    select 1
    from public.employee_import_rows r
    join public.employees e on e.id = r.committed_employee_id
    where r.batch_id = p_batch_id
      and r.operation = 'update'
      and e.updated_at is distinct from r.committed_employee_updated_at
  ) then
    raise exception using errcode = '55000', message = 'Rollback is blocked because an updated employee changed after this import';
  end if;

  for v_row in
    select * from public.employee_import_rows
    where batch_id = p_batch_id and commit_status = 'committed'
    order by row_number desc
    for update
  loop
    if v_row.operation = 'create' and v_row.committed_employee_id is not null then
      delete from public.employees
      where id = v_row.committed_employee_id
        and organization_id = v_batch.organization_id;
    elsif v_row.operation = 'update' and v_row.prior_employee is not null then
      v_prior := v_row.prior_employee;
      update public.employees
      set employee_number = v_prior->>'employee_number',
          external_payroll_id = v_prior->>'external_payroll_id',
          first_name = v_prior->>'first_name',
          last_name = v_prior->>'last_name',
          preferred_name = v_prior->>'preferred_name',
          work_email = (v_prior->>'work_email')::public.citext,
          work_phone = v_prior->>'work_phone',
          status = v_prior->>'status',
          hire_date = private.safe_import_date(v_prior->>'hire_date'),
          probation_end_date = private.safe_import_date(v_prior->>'probation_end_date'),
          termination_date = private.safe_import_date(v_prior->>'termination_date'),
          termination_reason = v_prior->>'termination_reason'
      where id = v_row.committed_employee_id
        and organization_id = v_batch.organization_id;
    end if;

    update public.employee_import_rows
    set commit_status = 'rolled_back'
    where id = v_row.id;
  end loop;

  update public.employee_import_batches
  set status = 'rolled_back',
      rolled_back_by = auth.uid(),
      rolled_back_at = now()
  where id = p_batch_id
  returning * into v_batch;

  perform private.log_audit_event(
    v_batch.organization_id, 'EMPLOYEE_IMPORT_ROLLED_BACK', 'employee_import_batch',
    v_batch.id, null,
    jsonb_build_object('created', v_batch.create_rows, 'updated', v_batch.update_rows)
  );

  return v_batch;
end;
$$;

revoke execute on function public.create_employee_import_batch(uuid, text, text, text, text, text, jsonb)
  from public, anon;
revoke execute on function public.update_employee_import_mapping(uuid, jsonb, text)
  from public, anon;
revoke execute on function public.revalidate_employee_import_batch(uuid)
  from public, anon;
revoke execute on function public.commit_employee_import_batch(uuid)
  from public, anon;
revoke execute on function public.rollback_employee_import_batch(uuid)
  from public, anon;

grant execute on function public.create_employee_import_batch(uuid, text, text, text, text, text, jsonb)
  to authenticated;
grant execute on function public.update_employee_import_mapping(uuid, jsonb, text)
  to authenticated;
grant execute on function public.revalidate_employee_import_batch(uuid)
  to authenticated;
grant execute on function public.commit_employee_import_batch(uuid)
  to authenticated;
grant execute on function public.rollback_employee_import_batch(uuid)
  to authenticated;

-- Raw employee workbooks are private and organization-scoped.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'employee-imports', 'employee-imports', false, 52428800,
  array[
    'text/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
on conflict (id) do nothing;

create policy "employee managers read employee imports"
on storage.objects for select to authenticated
using (
  bucket_id = 'employee-imports'
  and (select private.has_permission((storage.foldername(name))[1]::uuid, 'employee.manage'))
);

create policy "employee managers upload employee imports"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'employee-imports'
  and (select private.has_permission((storage.foldername(name))[1]::uuid, 'employee.manage'))
);

create policy "employee managers delete uncommitted employee imports"
on storage.objects for delete to authenticated
using (
  bucket_id = 'employee-imports'
  and (select private.has_permission((storage.foldername(name))[1]::uuid, 'employee.manage'))
);
