-- Fixes a real bug in 20260826154926_employee_migration_center.sql found
-- by pglite while adding test coverage for it: commit_employee_import_batch()
-- and rollback_employee_import_batch() cast work_email to `citext` with a
-- bare, unqualified type name, but both functions run with
-- `set search_path = ''` (required so every OTHER identifier in them has
-- to be schema-qualified, which is what keeps a SECURITY DEFINER function
-- from being hijackable by a search_path trick) — which also means Postgres
-- can't resolve an unqualified extension type name like `citext` either.
-- The result: every attempt to commit or roll back an import whose row
-- data included a work_email failed outright with "type citext does not
-- exist", so the Migration Center's actual posting step never worked in
-- practice. Column type declarations (employees.work_email citext, etc.)
-- were never affected — those run under a normal search_path at
-- migration-apply time, not inside these functions.

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
