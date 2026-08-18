-- Halomanage — payroll import (deliberately NOT a payroll engine)
-- Ref: PRODUCT_BLUEPRINT.md "External payroll import and employee pay
-- records"; ARCHITECTURE.md "Payroll import architecture".
--
-- This module never computes gross → deductions → tax → net. It stores and
-- reconciles whatever an external payroll application already calculated.
--
-- Two distinct, never-conflated import types (each its own staging table):
--   1. Pay Run Results  — informational: what someone was paid for a period.
--   2. Compensation Change — changes the employee's ongoing rate going
--      forward, applied through the same effective-dated pattern as
--      employee_assignments (employee_compensation, one open row at a time).
--
-- Flow is always Upload → Validate → Map → Preview → Approve → Post → Audit,
-- matched by immutable employee_number/external_payroll_id — never by name
-- — and a correction is a new batch that supersedes the old one, never an
-- in-place overwrite of history.

create table public.payroll_column_maps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  batch_type text not null check (batch_type in ('pay_run_results', 'compensation_change')),
  -- {"source_column": "target_field", ...} — translates one payroll
  -- provider's spreadsheet layout into Halomanage's internal row shape.
  mapping jsonb not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
alter table public.payroll_column_maps enable row level security;
create index payroll_column_maps_org_idx on public.payroll_column_maps(organization_id);

create table public.payroll_import_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  batch_type text not null check (batch_type in ('pay_run_results', 'compensation_change')),
  pay_period_start date,
  pay_period_end date,
  pay_date date,
  currency text not null default 'USD',
  column_map_id uuid references public.payroll_column_maps(id),
  original_file_name text not null,
  original_file_path text not null,
  file_hash text not null,
  status text not null default 'uploaded' check (status in (
    'uploaded', 'processing', 'needs_review', 'ready_for_approval', 'approved', 'rejected', 'superseded'
  )),
  supersedes_batch_id uuid references public.payroll_import_batches(id),
  total_rows integer not null default 0,
  matched_rows integer not null default 0,
  unmatched_rows integer not null default 0,
  error_rows integer not null default 0,
  total_net_amount numeric(14,2),
  uploaded_by uuid not null references auth.users(id),
  uploaded_at timestamptz not null default now(),
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  rejected_reason text,
  created_at timestamptz not null default now()
);
alter table public.payroll_import_batches enable row level security;
create index payroll_batches_org_idx on public.payroll_import_batches(organization_id, status);
create index payroll_batches_period_idx on public.payroll_import_batches(organization_id, pay_period_start, pay_period_end);

comment on table public.payroll_import_batches is
  'Immutable, auditable import batches. A correction is uploaded as a new batch with supersedes_batch_id set — never an UPDATE of a posted batch''s figures.';

create table public.payroll_import_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.payroll_import_batches(id) on delete cascade,
  row_number integer not null,
  employee_id uuid references public.employees(id),
  external_employee_id text,
  employee_number text,
  employee_email text,
  employee_name_raw text,
  gross_pay numeric(14,2),
  regular_pay numeric(14,2),
  overtime_pay numeric(14,2),
  allowances numeric(14,2),
  bonus numeric(14,2),
  tax numeric(14,2),
  other_deductions numeric(14,2),
  net_pay numeric(14,2),
  earnings jsonb,
  deductions jsonb,
  taxes jsonb,
  employer_values jsonb,
  raw_row jsonb not null,
  mapping_status text not null default 'unmatched' check (mapping_status in ('matched', 'unmatched', 'duplicate', 'ambiguous')),
  validation_status text not null default 'invalid' check (validation_status in ('valid', 'invalid')),
  error_message text,
  unique (batch_id, row_number)
);
alter table public.payroll_import_rows enable row level security;
create index payroll_rows_batch_idx on public.payroll_import_rows(batch_id);
create index payroll_rows_employee_idx on public.payroll_import_rows(employee_id);

create table public.compensation_change_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.payroll_import_batches(id) on delete cascade,
  row_number integer not null,
  employee_id uuid references public.employees(id),
  external_employee_id text,
  employee_number text,
  effective_date date,
  old_amount numeric(14,2),
  new_amount numeric(14,2),
  currency text,
  raw_row jsonb not null,
  mapping_status text not null default 'unmatched' check (mapping_status in ('matched', 'unmatched', 'duplicate', 'ambiguous')),
  validation_status text not null default 'invalid' check (validation_status in ('valid', 'invalid')),
  error_message text,
  unique (batch_id, row_number)
);
alter table public.compensation_change_rows enable row level security;
create index compensation_rows_batch_idx on public.compensation_change_rows(batch_id);
create index compensation_rows_employee_idx on public.compensation_change_rows(employee_id);

-- Effective-dated compensation history, the same pattern as
-- employee_assignments — never a bare "employees.salary" column.
create table public.employee_compensation (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  amount numeric(14,2) not null,
  currency text not null default 'USD',
  pay_frequency text check (pay_frequency in ('hourly', 'weekly', 'biweekly', 'semimonthly', 'monthly', 'annual')),
  source text not null default 'manual' check (source in ('manual', 'payroll_import')),
  source_batch_id uuid references public.payroll_import_batches(id),
  start_date date not null,
  end_date date,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  check (end_date is null or end_date >= start_date)
);
alter table public.employee_compensation enable row level security;
create index employee_compensation_employee_idx on public.employee_compensation(employee_id, start_date desc);
create unique index employee_compensation_one_open on public.employee_compensation(employee_id) where end_date is null;

-- Only the latest approved pay-run batch for a given employee/period is
-- "current" — superseded batches flip to status='superseded' on approval of
-- their replacement (see approve_payroll_import), so a plain status filter
-- is all this view needs.
create view public.current_payroll_records
  with (security_invoker = true)
as
select
  r.*,
  b.organization_id,
  b.pay_period_start,
  b.pay_period_end,
  b.pay_date,
  b.currency,
  b.status as batch_status
from public.payroll_import_rows r
join public.payroll_import_batches b on b.id = r.batch_id
where b.batch_type = 'pay_run_results'
  and b.status = 'approved'
  and r.mapping_status = 'matched';

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

create or replace function public.create_payroll_import_batch(
  p_organization_id uuid,
  p_batch_type text,
  p_original_file_name text,
  p_original_file_path text,
  p_file_hash text,
  p_pay_period_start date default null,
  p_pay_period_end date default null,
  p_pay_date date default null,
  p_currency text default 'USD',
  p_column_map_id uuid default null,
  p_supersedes_batch_id uuid default null
)
returns public.payroll_import_batches
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.payroll_import_batches;
begin
  if not private.has_permission(p_organization_id, 'payroll.import') then
    raise exception 'Not authorized to import payroll data';
  end if;

  insert into public.payroll_import_batches (
    organization_id, batch_type, pay_period_start, pay_period_end, pay_date, currency,
    column_map_id, original_file_name, original_file_path, file_hash, supersedes_batch_id, uploaded_by
  )
  values (
    p_organization_id, p_batch_type, p_pay_period_start, p_pay_period_end, p_pay_date, p_currency,
    p_column_map_id, p_original_file_name, p_original_file_path, p_file_hash, p_supersedes_batch_id, auth.uid()
  )
  returning * into v_batch;

  perform private.log_audit_event(p_organization_id, 'PAYROLL_FILE_UPLOADED', 'payroll_import_batch', v_batch.id, null, to_jsonb(v_batch));

  return v_batch;
end;
$$;

-- Called by the payroll-import Edge Function after it finishes staging rows
-- (it authenticates as the uploading user, not service_role, so this RPC's
-- own permission check still applies) to (re)compute the summary counters
-- and decide whether the batch needs manual reconciliation.
create or replace function public.recompute_payroll_batch_status(p_batch_id uuid)
returns public.payroll_import_batches
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.payroll_import_batches;
  v_total integer; v_matched integer; v_unmatched integer; v_errors integer; v_net numeric;
begin
  select * into v_batch from public.payroll_import_batches where id = p_batch_id for update;
  if v_batch.id is null then
    raise exception 'Batch not found';
  end if;
  if not private.has_permission(v_batch.organization_id, 'payroll.import') then
    raise exception 'Not authorized';
  end if;

  if v_batch.batch_type = 'pay_run_results' then
    select count(*), count(*) filter (where mapping_status = 'matched'),
           count(*) filter (where mapping_status != 'matched'),
           count(*) filter (where validation_status = 'invalid'),
           sum(net_pay) filter (where mapping_status = 'matched' and validation_status = 'valid')
    into v_total, v_matched, v_unmatched, v_errors, v_net
    from public.payroll_import_rows where batch_id = p_batch_id;
  else
    select count(*), count(*) filter (where mapping_status = 'matched'),
           count(*) filter (where mapping_status != 'matched'),
           count(*) filter (where validation_status = 'invalid'),
           null
    into v_total, v_matched, v_unmatched, v_errors, v_net
    from public.compensation_change_rows where batch_id = p_batch_id;
  end if;

  update public.payroll_import_batches
  set total_rows = v_total, matched_rows = v_matched, unmatched_rows = v_unmatched, error_rows = v_errors,
      total_net_amount = v_net,
      status = case when v_unmatched > 0 or v_errors > 0 then 'needs_review' else 'ready_for_approval' end
  where id = p_batch_id
  returning * into v_batch;

  return v_batch;
end;
$$;

create or replace function public.resolve_payroll_row_match(p_row_id uuid, p_employee_id uuid)
returns public.payroll_import_rows
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.payroll_import_rows;
  v_org uuid;
begin
  -- A record variable (v_row) can't share an INTO list with another target
  -- (v_org) alongside a `r.*` wildcard — select the row first, then look up
  -- its organization separately.
  select r.* into v_row from public.payroll_import_rows r where r.id = p_row_id;
  if v_row.id is null then
    raise exception 'Row not found';
  end if;

  select b.organization_id into v_org from public.payroll_import_batches b where b.id = v_row.batch_id;
  if not private.has_permission(v_org, 'payroll.import') then
    raise exception 'Not authorized';
  end if;

  update public.payroll_import_rows
  set employee_id = p_employee_id, mapping_status = 'matched',
      validation_status = case when net_pay is not null then 'valid' else 'invalid' end,
      error_message = null
  where id = p_row_id
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.resolve_compensation_row_match(p_row_id uuid, p_employee_id uuid)
returns public.compensation_change_rows
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.compensation_change_rows;
  v_org uuid;
begin
  select r.* into v_row from public.compensation_change_rows r where r.id = p_row_id;
  if v_row.id is null then
    raise exception 'Row not found';
  end if;

  select b.organization_id into v_org from public.payroll_import_batches b where b.id = v_row.batch_id;
  if not private.has_permission(v_org, 'payroll.import') then
    raise exception 'Not authorized';
  end if;

  update public.compensation_change_rows
  set employee_id = p_employee_id, mapping_status = 'matched',
      validation_status = case when new_amount is not null and effective_date is not null then 'valid' else 'invalid' end,
      error_message = null
  where id = p_row_id
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.approve_payroll_import(p_batch_id uuid)
returns public.payroll_import_batches
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.payroll_import_batches;
  crow record;
begin
  select * into v_batch from public.payroll_import_batches where id = p_batch_id for update;
  if v_batch.id is null then
    raise exception 'Batch not found';
  end if;
  if not private.has_permission(v_batch.organization_id, 'payroll.import') then
    raise exception 'Not authorized to approve payroll imports';
  end if;
  if v_batch.status != 'ready_for_approval' then
    raise exception 'Batch has % unresolved row(s) or is not ready for approval', v_batch.unmatched_rows + v_batch.error_rows;
  end if;

  update public.payroll_import_batches
  set status = 'approved', approved_by = auth.uid(), approved_at = now()
  where id = p_batch_id
  returning * into v_batch;

  if v_batch.supersedes_batch_id is not null then
    update public.payroll_import_batches set status = 'superseded' where id = v_batch.supersedes_batch_id;
  end if;

  if v_batch.batch_type = 'compensation_change' then
    for crow in
      select * from public.compensation_change_rows
      where batch_id = p_batch_id and mapping_status = 'matched' and validation_status = 'valid' and employee_id is not null
      order by row_number
    loop
      update public.employee_compensation
      set end_date = crow.effective_date - 1
      where employee_id = crow.employee_id and end_date is null and start_date < crow.effective_date;

      insert into public.employee_compensation (
        organization_id, employee_id, amount, currency, source, source_batch_id, start_date
      )
      values (
        v_batch.organization_id, crow.employee_id, crow.new_amount, coalesce(crow.currency, v_batch.currency),
        'payroll_import', p_batch_id, crow.effective_date
      )
      on conflict (employee_id) where end_date is null do nothing;
    end loop;
  end if;

  perform private.log_audit_event(v_batch.organization_id, 'PAYROLL_IMPORT_APPROVED', 'payroll_import_batch', v_batch.id, null, to_jsonb(v_batch));

  return v_batch;
end;
$$;

create or replace function public.reject_payroll_import(p_batch_id uuid, p_reason text)
returns public.payroll_import_batches
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.payroll_import_batches;
begin
  select * into v_batch from public.payroll_import_batches where id = p_batch_id for update;
  if v_batch.id is null then
    raise exception 'Batch not found';
  end if;
  if not private.has_permission(v_batch.organization_id, 'payroll.import') then
    raise exception 'Not authorized';
  end if;

  update public.payroll_import_batches set status = 'rejected', rejected_reason = p_reason where id = p_batch_id
  returning * into v_batch;

  perform private.log_audit_event(v_batch.organization_id, 'PAYROLL_IMPORT_REJECTED', 'payroll_import_batch', v_batch.id, null, to_jsonb(v_batch));

  return v_batch;
end;
$$;

revoke execute on function public.create_payroll_import_batch(uuid, text, text, text, text, date, date, date, text, uuid, uuid) from public;
revoke execute on function public.recompute_payroll_batch_status(uuid) from public;
revoke execute on function public.resolve_payroll_row_match(uuid, uuid) from public;
revoke execute on function public.resolve_compensation_row_match(uuid, uuid) from public;
revoke execute on function public.approve_payroll_import(uuid) from public;
revoke execute on function public.reject_payroll_import(uuid, text) from public;
grant execute on function public.create_payroll_import_batch(uuid, text, text, text, text, date, date, date, text, uuid, uuid) to authenticated;
grant execute on function public.recompute_payroll_batch_status(uuid) to authenticated;
grant execute on function public.resolve_payroll_row_match(uuid, uuid) to authenticated;
grant execute on function public.resolve_compensation_row_match(uuid, uuid) to authenticated;
grant execute on function public.approve_payroll_import(uuid) to authenticated;
grant execute on function public.reject_payroll_import(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS policies
-- ---------------------------------------------------------------------------

create policy "org members read column maps" on public.payroll_column_maps for select to authenticated
  using (private.is_org_member(organization_id));
create policy "importers manage column maps" on public.payroll_column_maps for all to authenticated
  using (private.has_permission(organization_id, 'payroll.import'))
  with check (private.has_permission(organization_id, 'payroll.import'));

create policy "importers read batches" on public.payroll_import_batches for select to authenticated
  using (private.has_permission(organization_id, 'payroll.import'));
create policy "org read approved batches" on public.payroll_import_batches for select to authenticated
  using (private.has_permission(organization_id, 'payroll.read_org'));
-- Without this, an ordinary employee has no SELECT policy on this table at
-- all, and current_payroll_records (which JOINs payroll_import_rows to
-- this table, security_invoker) would silently return zero rows for them
-- even though the "employee reads own approved pay records" policy below
-- already lets them see their own row in payroll_import_rows directly —
-- caught by a scripted end-to-end run of approve_payroll_import() +
-- current_payroll_records before shipping this fix. Scoped tightly: only
-- the batch header (period/pay date/currency/status) of a batch they have
-- an approved, matched row in — never another employee's row in that batch.
--
-- This check goes through a SECURITY DEFINER helper rather than an inline
-- EXISTS subquery against payroll_import_rows: an inline subquery would
-- have to evaluate payroll_import_rows' own RLS policies, two of which
-- (below) subquery back into payroll_import_batches — Postgres detects that
-- mutual cycle and raises "infinite recursion detected in policy" (also
-- caught by the scripted run). The SECURITY DEFINER function bypasses RLS
-- for its own internal query, breaking the cycle, the same way
-- private.in_management_scope()/private.can_see_document() do elsewhere in
-- this schema.
create or replace function private.employee_has_matched_payroll_row(p_batch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.payroll_import_rows r
    where r.batch_id = p_batch_id
      and r.employee_id = private.current_employee_id()
      and r.mapping_status = 'matched'
  );
$$;

create policy "employee reads batches behind their own approved pay records" on public.payroll_import_batches for select to authenticated
  using (status = 'approved' and private.employee_has_matched_payroll_row(id));
-- Writes go only through create_payroll_import_batch()/approve.../reject...().
-- The payroll-import Edge Function inserts staged rows using the
-- service_role key (bypasses RLS by design — see supabase/functions/payroll-import).

create policy "importers read payroll rows" on public.payroll_import_rows for select to authenticated
  using (batch_id in (select id from public.payroll_import_batches b where private.has_permission(b.organization_id, 'payroll.import')));
create policy "employee reads own approved pay records" on public.payroll_import_rows for select to authenticated
  using (
    employee_id = private.current_employee_id()
    and batch_id in (select id from public.payroll_import_batches b where b.status = 'approved')
  );
create policy "org reads approved payroll rows" on public.payroll_import_rows for select to authenticated
  using (
    batch_id in (select id from public.payroll_import_batches b where private.has_permission(b.organization_id, 'payroll.read_org') and b.status = 'approved')
  );

create policy "importers read compensation rows" on public.compensation_change_rows for select to authenticated
  using (batch_id in (select id from public.payroll_import_batches b where private.has_permission(b.organization_id, 'payroll.import')));

create policy "read own compensation history" on public.employee_compensation for select to authenticated
  using (employee_id = private.current_employee_id());
create policy "hr read compensation history" on public.employee_compensation for select to authenticated
  using (private.has_permission(organization_id, 'payroll.read_org'));
create policy "hr manage compensation history" on public.employee_compensation for all to authenticated
  using (private.has_permission(organization_id, 'employee.manage'))
  with check (private.has_permission(organization_id, 'employee.manage'));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.payroll_import_batches;
  end if;
end $$;
