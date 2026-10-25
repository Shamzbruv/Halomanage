-- Employee pay records: immutable publication, scoped corrections and enquiries.
-- Imported monetary values are never a payroll/tax calculation.
create schema pay_internal;
revoke all on schema pay_internal from public,anon;
grant usage on schema pay_internal to authenticated;

create function pay_internal.can_read(p_org uuid,p_employee uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and not (private.user_requires_mfa(p_org,auth.uid()) and coalesce(auth.jwt()->>'aal','aal1')<>'aal2')
 and (private.has_permission(p_org,'payroll.read_org') or (p_employee=private.current_employee_id() and private.has_permission(p_org,'payroll.read_self')));
$$;

create table public.published_payroll_records (
 id uuid primary key references public.payroll_import_rows(id),
 organization_id uuid not null references public.organizations(id),
 employee_id uuid not null references public.employees(id),
 batch_id uuid not null references public.payroll_import_batches(id),
 replaces_id uuid unique references public.published_payroll_records(id),
 pay_date date, currency text not null,
 snapshot jsonb not null,
 published_at timestamptz not null default now(),
 published_by uuid references auth.users(id),
 legacy_capture boolean not null default false
);
create index published_pay_employee_date_idx on public.published_payroll_records(employee_id,pay_date desc,id);
create index published_pay_org_idx on public.published_payroll_records(organization_id);
create index published_pay_batch_idx on public.published_payroll_records(batch_id);
alter table public.published_payroll_records enable row level security;
create policy "authorized published pay" on public.published_payroll_records for select to authenticated using(pay_internal.can_read(organization_id,employee_id));
revoke all on public.published_payroll_records from public,anon,authenticated;
grant select on public.published_payroll_records to authenticated;

create function pay_internal.publish(p_batch uuid,p_legacy boolean default false) returns void
language plpgsql security definer set search_path='' as $$
declare b public.payroll_import_batches; r public.payroll_import_rows; prev uuid; snap jsonb; u uuid;
begin
 select * into b from public.payroll_import_batches where id=p_batch;
 for r in select * from public.payroll_import_rows where batch_id=b.id and mapping_status='matched' and validation_status='valid' and employee_id is not null loop
  prev:=null;
  if b.supersedes_batch_id is not null then
   select p.id into prev from public.published_payroll_records p where p.batch_id=b.supersedes_batch_id and p.employee_id=r.employee_id
     and not exists(select 1 from public.published_payroll_records c where c.replaces_id=p.id);
   if prev is null and not p_legacy then raise exception 'Correction must replace a current record for the same employee in the selected batch'; end if;
  end if;
  select jsonb_build_object('id',r.id,'batch_id',b.id,'row_number',r.row_number,'organization_id',b.organization_id,'employee_id',r.employee_id,
    'employer_name',o.name,'employee_name',concat_ws(' ',e.first_name,e.last_name),'employee_number',e.employee_number,
    'position_title',(select pos.title from public.employee_assignments a left join public.positions pos on pos.id=a.position_id where a.employee_id=e.id
      and a.start_date<=coalesce(b.pay_period_end,b.pay_date,current_date) and (a.end_date is null or a.end_date>=coalesce(b.pay_period_end,b.pay_date,current_date)) order by a.is_primary desc,a.start_date desc limit 1),
    'pay_period_start',b.pay_period_start,'pay_period_end',b.pay_period_end,'pay_date',b.pay_date,'currency',b.currency,
    'gross_pay',r.gross_pay::text,'regular_pay',r.regular_pay::text,'overtime_pay',r.overtime_pay::text,'allowances',r.allowances::text,'bonus',r.bonus::text,
    'tax',r.tax::text,'other_deductions',r.other_deductions::text,'net_pay',r.net_pay::text,
    'earnings',r.earnings,'deductions',r.deductions,'taxes',r.taxes,'employer_values',r.employer_values)
  into snap from public.employees e join public.organizations o on o.id=e.organization_id where e.id=r.employee_id and e.organization_id=b.organization_id;
  if snap is null then raise exception 'Payroll employee must belong to this organization'; end if;
  insert into public.published_payroll_records(id,organization_id,employee_id,batch_id,replaces_id,pay_date,currency,snapshot,published_by,legacy_capture)
   values(r.id,b.organization_id,r.employee_id,b.id,prev,b.pay_date,b.currency,snap,b.approved_by,p_legacy) on conflict(id) do nothing;
  if found and not p_legacy then
   select user_id into u from public.employees where id=r.employee_id;
   if u is not null then perform private.create_notification(b.organization_id,u,r.employee_id,'pay.payslip_published',case when prev is null then 'Your payslip is available' else 'A corrected payslip is available' end,null,'/payslips/'||r.id); end if;
  end if;
 end loop;
end; $$;
-- Capture pre-existing posted statements once. Historical identity cannot be reconstructed
-- reliably; the UI explicitly labels these as a legacy capture.
do $$ declare b record; begin
 for b in select id from public.payroll_import_batches where batch_type='pay_run_results' and status in ('approved','superseded') order by approved_at nulls first,created_at,id loop
  perform pay_internal.publish(b.id,true);
 end loop;
end; $$;

-- Stop exposing staging/raw spreadsheet values and shared batch file metadata to employees.
drop policy "employee reads own approved pay records" on public.payroll_import_rows;
drop policy "org reads approved payroll rows" on public.payroll_import_rows;
drop policy "org read approved batches" on public.payroll_import_batches;
drop policy "employee reads batches behind their own approved pay records" on public.payroll_import_batches;
-- Preserve the legacy view's shape for existing reports, with redacted source fields.
create or replace view public.current_payroll_records with(security_invoker=true) as
 select p.id,p.batch_id,(s->>'row_number')::integer as row_number,p.employee_id,
 null::text as external_employee_id,null::text as employee_number,null::text as employee_email,null::text as employee_name_raw,
 (s->>'gross_pay')::numeric(14,2) gross_pay,(s->>'regular_pay')::numeric(14,2) regular_pay,(s->>'overtime_pay')::numeric(14,2) overtime_pay,
 (s->>'allowances')::numeric(14,2) allowances,(s->>'bonus')::numeric(14,2) bonus,(s->>'tax')::numeric(14,2) tax,
 (s->>'other_deductions')::numeric(14,2) other_deductions,(s->>'net_pay')::numeric(14,2) net_pay,
 s->'earnings' earnings,s->'deductions' deductions,s->'taxes' taxes,s->'employer_values' employer_values,
 '{}'::jsonb raw_row,'matched'::text mapping_status,'valid'::text validation_status,null::text error_message,
 p.organization_id,(s->>'pay_period_start')::date pay_period_start,(s->>'pay_period_end')::date pay_period_end,p.pay_date,p.currency,'approved'::text batch_status
 from public.published_payroll_records p cross join lateral(select p.snapshot as s) j
 where not exists(select 1 from public.published_payroll_records c where c.replaces_id=p.id);
grant select on public.current_payroll_records to authenticated;

-- Confidential compensation commentary is stored separately, never in self-service rows.
create table public.compensation_private_notes (
 compensation_id uuid primary key references public.employee_compensation(id) on delete cascade deferrable initially deferred,
 organization_id uuid not null references public.organizations(id),employee_id uuid not null references public.employees(id),note text not null
);
alter table public.compensation_private_notes enable row level security;
create policy "HR compensation notes" on public.compensation_private_notes for select to authenticated using(
 private.has_permission(organization_id,'compensation.manage') or private.has_permission(organization_id,'compensation.approve') or private.has_permission(organization_id,'compensation.read_org'));
revoke all on public.compensation_private_notes from public,anon,authenticated;
grant select on public.compensation_private_notes to authenticated;
insert into public.compensation_private_notes select id,organization_id,employee_id,change_notes from public.employee_compensation where change_notes is not null;
update public.employee_compensation set change_notes=null where change_notes is not null;
create function pay_internal.extract_private_note() returns trigger language plpgsql security definer set search_path='' as $$ begin
 if new.change_notes is not null then
  insert into public.compensation_private_notes values(new.id,new.organization_id,new.employee_id,new.change_notes)
  on conflict(compensation_id) do update set note=excluded.note;
  new.change_notes:=null;
 end if; return new; end; $$;
create trigger compensation_private_note before insert or update of change_notes on public.employee_compensation for each row execute function pay_internal.extract_private_note();

-- Guard even trusted service-role staging operations against posted record changes.
create function pay_internal.row_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare b public.payroll_import_batches; e uuid; bid uuid;
begin
 bid:=case when tg_op='DELETE' then old.batch_id else new.batch_id end;
 select * into b from public.payroll_import_batches where id=bid for update;
 if b.status in ('approved','superseded','rejected') then raise exception 'Posted or rejected payroll rows cannot be changed; upload a correction'; end if;
 if tg_op='UPDATE' and new.batch_id<>old.batch_id then raise exception 'Rows cannot be moved between batches'; end if;
 if tg_op<>'DELETE' and ((tg_table_name='payroll_import_rows' and b.batch_type<>'pay_run_results') or (tg_table_name='compensation_change_rows' and b.batch_type<>'compensation_change')) then raise exception 'Row type does not match batch'; end if;
 if tg_op<>'DELETE' and new.employee_id is not null then
  select organization_id into e from public.employees where id=new.employee_id;
  if e is distinct from b.organization_id then raise exception 'Employee must belong to the payroll organization'; end if;
 end if;
 if tg_op='DELETE' then return old; end if; return new;
end; $$;
create trigger payroll_row_integrity before insert or update or delete on public.payroll_import_rows for each row execute function pay_internal.row_guard();
create trigger compensation_row_integrity before insert or update or delete on public.compensation_change_rows for each row execute function pay_internal.row_guard();
create function pay_internal.immutable_publication() returns trigger language plpgsql set search_path='' as $$ begin raise exception 'Published payslips are immutable'; end; $$;
create trigger immutable_payslip before update or delete on public.published_payroll_records for each row execute function pay_internal.immutable_publication();

create function pay_internal.batch_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare parent public.payroll_import_batches;
begin
 if tg_op='DELETE' then if old.status in ('approved','superseded') then raise exception 'Posted batches cannot be deleted'; end if; return old; end if;
 if tg_op='UPDATE' and old.status in ('approved','superseded','rejected') and new is distinct from old then raise exception 'Closed batches cannot be changed'; end if;
 if tg_op='UPDATE' and (new.organization_id,new.batch_type,new.pay_period_start,new.pay_period_end,new.pay_date,new.currency,new.supersedes_batch_id,new.original_file_path,new.file_hash,new.column_map_id)
  is distinct from (old.organization_id,old.batch_type,old.pay_period_start,old.pay_period_end,old.pay_date,old.currency,old.supersedes_batch_id,old.original_file_path,old.file_hash,old.column_map_id) then raise exception 'Upload a new batch to change import metadata'; end if;
 if new.currency !~ '^[A-Z]{3}$' then raise exception 'Use a three-letter uppercase currency code'; end if;
 if new.batch_type='pay_run_results' and (new.pay_period_start is null or new.pay_period_end is null or new.pay_date is null or new.pay_period_end<new.pay_period_start) then raise exception 'A pay run requires a valid period and pay date'; end if;
 if split_part(new.original_file_path,'/',1)<>new.organization_id::text or new.original_file_path like '%..%' then raise exception 'The file must belong to this organization'; end if;
 if new.column_map_id is not null and not exists(select 1 from public.payroll_column_maps where id=new.column_map_id and organization_id=new.organization_id and batch_type=new.batch_type) then raise exception 'Column map must match the organization and import type'; end if;
 if new.supersedes_batch_id is not null then
  select * into parent from public.payroll_import_batches where id=new.supersedes_batch_id;
  if parent.id is null or parent.organization_id<>new.organization_id or parent.batch_type<>new.batch_type or parent.status not in ('approved','superseded')
    or (parent.pay_period_start,parent.pay_period_end,parent.pay_date,parent.currency) is distinct from (new.pay_period_start,new.pay_period_end,new.pay_date,new.currency) then raise exception 'Correction must use the original organization, type, period, pay date and currency'; end if;
  if new.batch_type<>'pay_run_results' then raise exception 'Compensation corrections require a new effective-dated HR change'; end if;
 end if;
 return new;
end; $$;
create trigger payroll_batch_integrity before insert or update or delete on public.payroll_import_batches for each row execute function pay_internal.batch_guard();

-- Move privileged implementations off the exposed API schema; wrappers below are invokers.
alter function public.create_payroll_import_batch(uuid,text,text,text,text,date,date,date,text,uuid,uuid) set schema pay_internal;
alter function public.recompute_payroll_batch_status(uuid) set schema pay_internal;
alter function public.resolve_payroll_row_match(uuid,uuid) set schema pay_internal;
alter function public.resolve_compensation_row_match(uuid,uuid) set schema pay_internal;
alter function public.approve_payroll_import(uuid) set schema pay_internal;
alter function public.reject_payroll_import(uuid,text) set schema pay_internal;

create function pay_internal.claim_payroll_processing(p_batch_id uuid) returns public.payroll_import_batches language plpgsql security definer set search_path='' as $$
declare b public.payroll_import_batches; begin
 select * into b from public.payroll_import_batches where id=p_batch_id for update;
 if b.id is null or not private.has_permission(b.organization_id,'payroll.import') then raise exception 'Not authorized'; end if;
 perform private.assert_step_up(b.organization_id);
 if b.status<>'uploaded' then raise exception 'Batch has already been processed; review or upload a new file'; end if;
 update public.payroll_import_batches set status='processing' where id=b.id returning * into b; return b;
end; $$;
-- Parser errors persist separately so rematching cannot erase invalid source amounts/dates.
alter table public.payroll_import_rows add column import_error text;
alter table public.compensation_change_rows add column import_error text;
create function pay_internal.items_valid(p_items jsonb,p_total numeric) returns boolean language sql immutable set search_path='' as $$
 select case when p_items is null or p_items='null'::jsonb then true when jsonb_typeof(p_items)<>'array' then false else
 not exists(select 1 from jsonb_array_elements(p_items) x where jsonb_typeof(x)<>'object' or nullif(trim(x->>'label'),'') is null or coalesce(x->>'amount','')!~ '^-?[0-9]{1,12}(\.[0-9]{1,2})?$')
 and case when exists(select 1 from jsonb_array_elements(p_items) x where coalesce(x->>'amount','')!~ '^-?[0-9]{1,12}(\.[0-9]{1,2})?$') then false when p_total is null then true else coalesce((select sum((x->>'amount')::numeric) from jsonb_array_elements(p_items) x),0)=p_total end end;
$$;
create or replace function pay_internal.recompute_payroll_batch_status(p_batch_id uuid) returns public.payroll_import_batches language plpgsql security definer set search_path='' as $$
declare b public.payroll_import_batches;
begin
 select * into b from public.payroll_import_batches where id=p_batch_id for update;
 if b.id is null or not private.has_permission(b.organization_id,'payroll.import') then raise exception 'Not authorized'; end if;
 perform private.assert_step_up(b.organization_id);
 if b.status in ('approved','superseded','rejected') then raise exception 'Closed batches cannot be reprocessed'; end if;
 if b.batch_type='pay_run_results' then
  update public.payroll_import_rows r set error_message=nullif(concat_ws('; ',r.import_error,
   case when r.employee_id is null or r.mapping_status<>'matched' then 'Employee match required' end,
   case when exists(select 1 from public.payroll_import_rows d where d.batch_id=r.batch_id and d.employee_id=r.employee_id and d.id<>r.id) then 'Duplicate employee in batch' end,
   case when r.gross_pay is null or r.net_pay is null then 'Gross pay and net pay are required' end,
   case when exists(select 1 from unnest(array[r.gross_pay,r.net_pay,r.regular_pay,r.overtime_pay,r.allowances,r.bonus,r.tax,r.other_deductions]) n where n::text in ('NaN','Infinity','-Infinity')) or r.gross_pay<0 then 'Invalid gross or net pay' end,
   case when r.gross_pay is not null and r.tax is not null and r.other_deductions is not null and r.net_pay is not null and r.gross_pay-r.tax-r.other_deductions<>r.net_pay then 'Gross less imported deductions does not equal net' end,
   case when r.regular_pay is not null and r.overtime_pay is not null and r.allowances is not null and r.bonus is not null and r.gross_pay<>r.regular_pay+r.overtime_pay+r.allowances+r.bonus then 'Imported earnings do not equal gross' end,
   case when not pay_internal.items_valid(r.earnings,r.gross_pay) or not pay_internal.items_valid(r.deductions,r.other_deductions) or not pay_internal.items_valid(r.taxes,r.tax) or not pay_internal.items_valid(r.employer_values,null) then 'Itemization must be labelled amount arrays matching supplied totals' end), '') where r.batch_id=b.id;
  update public.payroll_import_rows set validation_status=case when error_message is null then 'valid' else 'invalid' end where batch_id=b.id;
  update public.payroll_import_batches set total_rows=(select count(*) from public.payroll_import_rows where batch_id=b.id),
   matched_rows=(select count(*) from public.payroll_import_rows where batch_id=b.id and mapping_status='matched' and employee_id is not null),
   unmatched_rows=(select count(*) from public.payroll_import_rows where batch_id=b.id and (mapping_status<>'matched' or employee_id is null)),
   error_rows=(select count(*) from public.payroll_import_rows where batch_id=b.id and validation_status='invalid'),
   total_net_amount=(select sum(net_pay) from public.payroll_import_rows where batch_id=b.id and validation_status='valid') where id=b.id;
 else
  update public.compensation_change_rows r set error_message=nullif(concat_ws('; ',r.import_error,
   case when r.employee_id is null or r.mapping_status<>'matched' then 'Employee match required' end,
   case when r.effective_date is null or r.new_amount is null or r.new_amount<0 or r.new_amount::text in ('NaN','Infinity','-Infinity') then 'Valid effective date and nonnegative new amount required' end,
   case when coalesce(r.currency,b.currency) !~ '^[A-Z]{3}$' then 'Invalid currency' end,
   case when exists(select 1 from public.compensation_change_rows d where d.batch_id=r.batch_id and d.employee_id=r.employee_id and d.id<>r.id) then 'Duplicate employee in batch' end), '') where r.batch_id=b.id;
  update public.compensation_change_rows set validation_status=case when error_message is null then 'valid' else 'invalid' end where batch_id=b.id;
  update public.payroll_import_batches set total_rows=(select count(*) from public.compensation_change_rows where batch_id=b.id),matched_rows=(select count(*) from public.compensation_change_rows where batch_id=b.id and mapping_status='matched' and employee_id is not null),unmatched_rows=(select count(*) from public.compensation_change_rows where batch_id=b.id and (mapping_status<>'matched' or employee_id is null)),error_rows=(select count(*) from public.compensation_change_rows where batch_id=b.id and validation_status='invalid') where id=b.id;
 end if;
 update public.payroll_import_batches set status=case when total_rows=0 or unmatched_rows>0 or error_rows>0 then 'needs_review' else 'ready_for_approval' end where id=b.id returning * into b;
 return b;
end; $$;
create or replace function pay_internal.approve_payroll_import(p_batch_id uuid) returns public.payroll_import_batches language plpgsql security definer set search_path='' as $$
declare b public.payroll_import_batches; c public.compensation_change_rows; oldc public.employee_compensation;
begin
 select * into b from public.payroll_import_batches where id=p_batch_id for update;
 if b.id is null or not private.has_permission(b.organization_id,'payroll.import') then raise exception 'Not authorized'; end if;
 perform private.assert_step_up(b.organization_id);
 -- Serializes publications and partial corrections within an organization.
 perform pg_advisory_xact_lock(hashtextextended('pay:'||b.organization_id::text,0));
 if b.status='approved' then return b; end if;
 b:=pay_internal.recompute_payroll_batch_status(b.id);
 if b.status<>'ready_for_approval' then raise exception 'Review all rows before approval; the batch must be nonempty and valid'; end if;
 if b.batch_type='compensation_change' then
  if not(private.has_permission(b.organization_id,'compensation.manage') or private.has_permission(b.organization_id,'compensation.approve')) then raise exception 'Compensation approval permission is required'; end if;
  for c in select * from public.compensation_change_rows where batch_id=b.id order by employee_id loop
   perform 1 from public.employees where id=c.employee_id for update;
   select * into oldc from public.employee_compensation where employee_id=c.employee_id and end_date is null for update;
   if oldc.id is not null and (c.effective_date<=oldc.start_date or (c.old_amount is not null and c.old_amount<>oldc.amount)) then raise exception 'Compensation date or old amount conflicts with the current record; review with HR'; end if;
   update public.employee_compensation set end_date=c.effective_date-1 where id=oldc.id;
   insert into public.employee_compensation(organization_id,employee_id,amount,currency,source,source_batch_id,start_date,created_by,pay_type,rate_unit,pay_frequency,standard_weekly_hours,fte,overtime_eligible,pay_group_id,pay_grade_id,time_policy_id)
    values(b.organization_id,c.employee_id,c.new_amount,coalesce(c.currency,b.currency),'payroll_import',b.id,c.effective_date,auth.uid(),coalesce(oldc.pay_type,'salaried'),oldc.rate_unit,oldc.pay_frequency,oldc.standard_weekly_hours,oldc.fte,oldc.overtime_eligible,oldc.pay_group_id,oldc.pay_grade_id,oldc.time_policy_id);
  end loop;
 end if;
 update public.payroll_import_batches set status='approved',approved_by=auth.uid(),approved_at=now() where id=b.id returning * into b;
 if b.batch_type='pay_run_results' then perform pay_internal.publish(b.id); end if;
 perform private.log_audit_event(b.organization_id,'PAYROLL_IMPORT_APPROVED','payroll_import_batch',b.id,null,jsonb_build_object('rows',b.total_rows,'correction_of',b.supersedes_batch_id));
 return b;
end; $$;
create or replace function pay_internal.reject_payroll_import(p_batch_id uuid,p_reason text) returns public.payroll_import_batches language plpgsql security definer set search_path='' as $$
declare b public.payroll_import_batches; begin
 select * into b from public.payroll_import_batches where id=p_batch_id for update;
 if b.id is null or not private.has_permission(b.organization_id,'payroll.import') then raise exception 'Not authorized'; end if;
 perform private.assert_step_up(b.organization_id);
 if b.status in ('approved','superseded','rejected') or length(trim(coalesce(p_reason,''))) not between 5 and 2000 then raise exception 'Only an open batch can be rejected; give a reason (5–2000 characters)'; end if;
 update public.payroll_import_batches set status='rejected',rejected_reason=trim(p_reason) where id=b.id returning * into b;
 perform private.log_audit_event(b.organization_id,'PAYROLL_IMPORT_REJECTED','payroll_import_batch',b.id,null,jsonb_build_object('status','rejected'));
 return b;
end; $$;

create or replace function pay_internal.create_payroll_import_batch(p_organization_id uuid,p_batch_type text,p_original_file_name text,p_original_file_path text,p_file_hash text,p_pay_period_start date default null,p_pay_period_end date default null,p_pay_date date default null,p_currency text default 'USD',p_column_map_id uuid default null,p_supersedes_batch_id uuid default null)
returns public.payroll_import_batches language plpgsql security definer set search_path='' as $$
declare b public.payroll_import_batches; begin
 if not private.has_permission(p_organization_id,'payroll.import') then raise exception 'Not authorized'; end if;
 perform private.assert_step_up(p_organization_id);
 if nullif(trim(p_file_hash),'') is null or nullif(trim(p_original_file_name),'') is null then raise exception 'File name and fingerprint are required'; end if;
 perform pg_advisory_xact_lock(hashtextextended('pay-upload:'||p_organization_id::text,0));
 select * into b from public.payroll_import_batches where organization_id=p_organization_id and batch_type=p_batch_type and file_hash=p_file_hash
  and (pay_period_start,pay_period_end,pay_date,currency,column_map_id,supersedes_batch_id) is not distinct from (p_pay_period_start,p_pay_period_end,p_pay_date,p_currency,p_column_map_id,p_supersedes_batch_id) and status<>'rejected' order by created_at limit 1;
 if b.id is not null then return b; end if;
 insert into public.payroll_import_batches(organization_id,batch_type,original_file_name,original_file_path,file_hash,pay_period_start,pay_period_end,pay_date,currency,column_map_id,supersedes_batch_id,uploaded_by)
 values(p_organization_id,p_batch_type,p_original_file_name,p_original_file_path,p_file_hash,p_pay_period_start,p_pay_period_end,p_pay_date,p_currency,p_column_map_id,p_supersedes_batch_id,auth.uid()) returning * into b;
 perform private.log_audit_event(b.organization_id,'PAYROLL_FILE_UPLOADED','payroll_import_batch',b.id,null,jsonb_build_object('batch_type',b.batch_type)); return b;
end; $$;

create table public.pay_queries (
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id),employee_id uuid not null references public.employees(id),
 payslip_id uuid references public.published_payroll_records(id),category text not null check(category in ('missing_pay','amount','deductions','compensation','payment_date','other')),
 subject text not null,status text not null default 'open' check(status in ('open','in_review','resolved')),
 resolution_payslip_id uuid references public.published_payroll_records(id),client_request_id uuid not null,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(employee_id,client_request_id)
);
create index pay_queries_org_status_idx on public.pay_queries(organization_id,status,updated_at desc);
create index pay_queries_employee_idx on public.pay_queries(employee_id);
create table public.pay_query_messages (
 id uuid primary key default gen_random_uuid(),query_id uuid not null references public.pay_queries(id),author_user_id uuid not null references auth.users(id),
 is_hr boolean not null,body text not null,created_at timestamptz not null default now()
);
create index pay_query_messages_query_idx on public.pay_query_messages(query_id,created_at,id);
alter table public.pay_queries enable row level security;
alter table public.pay_query_messages enable row level security;
create function pay_internal.can_manage_query(p_org uuid,p_category text) returns boolean language sql stable security definer set search_path='' as $$
 select case when p_category='compensation' then private.has_permission(p_org,'compensation.manage') or private.has_permission(p_org,'compensation.approve') else private.has_permission(p_org,'payroll.import') end;
$$;
create policy "scoped pay queries" on public.pay_queries for select to authenticated using(
 (not private.user_requires_mfa(organization_id,auth.uid()) or coalesce(auth.jwt()->>'aal','aal1')='aal2') and
 (pay_internal.can_manage_query(organization_id,category) or (employee_id=private.current_employee_id() and
  ((category='compensation' and private.has_permission(organization_id,'compensation.read_self')) or (category<>'compensation' and private.has_permission(organization_id,'payroll.read_self'))))));
create policy "scoped pay query messages" on public.pay_query_messages for select to authenticated using(exists(select 1 from public.pay_queries q where q.id=query_id));
revoke all on public.pay_queries,public.pay_query_messages from public,anon,authenticated;
grant select on public.pay_queries,public.pay_query_messages to authenticated;
create function pay_internal.submit_pay_query(p_category text,p_subject text,p_message text,p_client_request_id uuid,p_payslip_id uuid default null) returns public.pay_queries
language plpgsql security definer set search_path='' as $$
declare e public.employees; q public.pay_queries; u uuid; begin
 select * into e from public.employees where id=private.current_employee_id();
 if e.id is null or not private.has_permission(e.organization_id,case when p_category='compensation' then 'compensation.read_self' else 'payroll.read_self' end::public.app_permission) then raise exception 'Not authorized'; end if;
 if private.user_requires_mfa(e.organization_id,auth.uid()) and coalesce(auth.jwt()->>'aal','aal1')<>'aal2' then raise exception 'Multi-factor authentication required'; end if;
 if p_client_request_id is null or length(trim(coalesce(p_subject,''))) not between 5 and 160 or length(trim(coalesce(p_message,''))) not between 10 and 4000 then raise exception 'Enter a subject (5–160 characters) and details (10–4000 characters)'; end if;
 if p_payslip_id is not null and not exists(select 1 from public.published_payroll_records where id=p_payslip_id and employee_id=e.id and organization_id=e.organization_id) then raise exception 'Payslip must belong to you'; end if;
 perform 1 from public.employees where id=e.id for update;
 select * into q from public.pay_queries where employee_id=e.id and client_request_id=p_client_request_id;
 if q.id is not null then
  if (q.category,q.subject,q.payslip_id) is distinct from (p_category,trim(p_subject),p_payslip_id) or not exists(select 1 from public.pay_query_messages where query_id=q.id and body=trim(p_message) and not is_hr) then raise exception 'Retry key was used for a different query'; end if; return q;
 end if;
 insert into public.pay_queries(organization_id,employee_id,payslip_id,category,subject,client_request_id) values(e.organization_id,e.id,p_payslip_id,p_category,trim(p_subject),p_client_request_id) returning * into q;
 insert into public.pay_query_messages(query_id,author_user_id,is_hr,body) values(q.id,auth.uid(),false,trim(p_message));
 for u in select user_id from public.employees x where x.organization_id=e.organization_id and x.user_id is not null and
  (case when p_category='compensation' then private.user_has_permission(e.organization_id,x.user_id,'compensation.manage') or private.user_has_permission(e.organization_id,x.user_id,'compensation.approve') else private.user_has_permission(e.organization_id,x.user_id,'payroll.import') end) loop
  perform private.create_notification(e.organization_id,u,e.id,'pay.query_opened','A pay query needs review',null,'/admin/payroll/queries');
 end loop;
 perform private.log_audit_event(e.organization_id,'PAY_QUERY_OPENED','pay_query',q.id,null,jsonb_build_object('category',q.category)); return q;
end; $$;
create function pay_internal.reply_pay_query(p_query_id uuid,p_message text,p_status text default 'in_review',p_resolution_payslip_id uuid default null) returns public.pay_queries
language plpgsql security definer set search_path='' as $$
declare q public.pay_queries; hr boolean; u uuid; begin
 select * into q from public.pay_queries where id=p_query_id for update;
 if q.id is null then raise exception 'Query not found'; end if;
 hr:=pay_internal.can_manage_query(q.organization_id,q.category);
 if not hr and not(q.employee_id=private.current_employee_id() and private.has_permission(q.organization_id,case when q.category='compensation' then 'compensation.read_self' else 'payroll.read_self' end::public.app_permission)) then raise exception 'Not authorized'; end if;
 if private.user_requires_mfa(q.organization_id,auth.uid()) and coalesce(auth.jwt()->>'aal','aal1')<>'aal2' then raise exception 'Multi-factor authentication required'; end if;
 if hr then perform private.assert_step_up(q.organization_id); end if;
 if length(trim(coalesce(p_message,''))) not between 10 and 4000 or p_status not in ('open','in_review','resolved') then raise exception 'Give an explanation (10–4000 characters) and a valid status'; end if;
 if not hr and (p_status<>'open' or p_resolution_payslip_id is not null) then raise exception 'Only HR can resolve a pay query'; end if;
 if p_resolution_payslip_id is not null and (p_status<>'resolved' or not exists(select 1 from public.published_payroll_records where id=p_resolution_payslip_id and organization_id=q.organization_id and employee_id=q.employee_id)) then raise exception 'Resolution payslip must belong to the same employee and organization'; end if;
 insert into public.pay_query_messages(query_id,author_user_id,is_hr,body) values(q.id,auth.uid(),hr,trim(p_message));
 update public.pay_queries set status=p_status,resolution_payslip_id=p_resolution_payslip_id,updated_at=now() where id=q.id returning * into q;
 if hr then
  select user_id into u from public.employees where id=q.employee_id;
  if u is not null then perform private.create_notification(q.organization_id,u,q.employee_id,'pay.query_updated','HR has updated your pay query',null,'/pay/queries'); end if;
 else
  for u in select x.user_id from public.employees x where x.organization_id=q.organization_id and x.user_id is not null and
   (case when q.category='compensation' then private.user_has_permission(q.organization_id,x.user_id,'compensation.manage') or private.user_has_permission(q.organization_id,x.user_id,'compensation.approve') else private.user_has_permission(q.organization_id,x.user_id,'payroll.import') end) loop
   perform private.create_notification(q.organization_id,u,q.employee_id,'pay.query_updated','An employee updated a pay query',null,'/admin/payroll/queries');
  end loop;
 end if;
 perform private.log_audit_event(q.organization_id,'PAY_QUERY_UPDATED','pay_query',q.id,null,jsonb_build_object('status',q.status,'resolution_payslip_id',q.resolution_payslip_id)); return q;
end; $$;

create function pay_internal.get_my_pay(p_year integer default null,p_currency text default null,p_page integer default 1) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare e public.employees; yr int; v jsonb;
begin
 select * into e from public.employees where id=private.current_employee_id();
 if e.id is null or not pay_internal.can_read(e.organization_id,e.id) or not private.has_permission(e.organization_id,'payroll.read_self') then raise exception 'Not authorized'; end if;
 yr:=coalesce(p_year,extract(year from private.org_today(e.organization_id))::int);
 if (yr<>0 and yr not between 1900 and 2200) or coalesce(p_page,0)<1 or p_page>100000 or (p_currency is not null and p_currency!~'^[A-Z]{3}$') then raise exception 'Invalid pay filters'; end if;
 with current_records as (select p.* from public.published_payroll_records p where p.employee_id=e.id and p.organization_id=e.organization_id and not exists(select 1 from public.published_payroll_records c where c.replaces_id=p.id)),
 filtered as(select * from current_records where (yr=0 or extract(year from pay_date)=yr) and (p_currency is null or currency=p_currency)),
 totals as(select currency,count(*) records,
  case when count(snapshot->>'gross_pay')=count(*) then sum((snapshot->>'gross_pay')::numeric)::text end gross,
  case when count(snapshot->>'net_pay')=count(*) then sum((snapshot->>'net_pay')::numeric)::text end net,
  case when count(snapshot->>'tax')=count(*) then sum((snapshot->>'tax')::numeric)::text end tax,
  case when count(snapshot->>'other_deductions')=count(*) then sum((snapshot->>'other_deductions')::numeric)::text end other_deductions
  from filtered group by currency)
 select jsonb_build_object('year',yr,'total',(select count(*) from filtered),'page',p_page,
  'years',(select coalesce(jsonb_agg(y order by y desc),'[]') from(select distinct extract(year from pay_date)::int y from current_records where pay_date is not null union select yr) a),
  'currencies',(select coalesce(jsonb_agg(currency order by currency),'[]') from(select distinct currency from current_records) a),
  'totals',(select coalesce(jsonb_agg(to_jsonb(t) order by currency),'[]') from totals t),
  'records',(select coalesce(jsonb_agg(to_jsonb(a) order by pay_date desc,id desc),'[]') from(select id,snapshot,replaces_id,pay_date,legacy_capture from filtered order by pay_date desc,id desc limit 24 offset (p_page-1)*24) a)) into v;
 return v;
end; $$;
create function pay_internal.get_payslip(p_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.published_payroll_records; replacement uuid; begin
 select * into p from public.published_payroll_records where id=p_id;
 if p.id is null or not pay_internal.can_read(p.organization_id,p.employee_id) then raise exception using errcode='42501',message='Payslip unavailable or access denied'; end if;
 select id into replacement from public.published_payroll_records where replaces_id=p.id;
 perform private.log_audit_event(p.organization_id,'PAYSLIP_VIEWED','published_payroll_record',p.id,null,jsonb_build_object('employee_id',p.employee_id));
 return to_jsonb(p)||jsonb_build_object('replaced_by',replacement);
end; $$;
-- Reuse the organization-local effective date for employee schedule permissions.
create or replace function private.current_employee_uses_pay_group(p_organization_id uuid,p_pay_group_id uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.employee_compensation c join public.employees e on e.id=c.employee_id and e.organization_id=c.organization_id where e.user_id=auth.uid() and c.organization_id=p_organization_id and c.pay_group_id=p_pay_group_id
 and private.has_permission(c.organization_id,'compensation.read_self') and c.start_date<=private.org_today(c.organization_id) and(c.end_date is null or c.end_date>=private.org_today(c.organization_id)));
$$;
create or replace function private.current_employee_uses_pay_calendar(p_organization_id uuid,p_pay_calendar_id uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.employee_compensation c join public.employees e on e.id=c.employee_id and e.organization_id=c.organization_id join public.pay_groups g on g.id=c.pay_group_id and g.organization_id=c.organization_id where e.user_id=auth.uid() and c.organization_id=p_organization_id and g.pay_calendar_id=p_pay_calendar_id
 and private.has_permission(c.organization_id,'compensation.read_self') and c.start_date<=private.org_today(c.organization_id) and(c.end_date is null or c.end_date>=private.org_today(c.organization_id)));
$$;

create function public.create_payroll_import_batch(p_organization_id uuid,p_batch_type text,p_original_file_name text,p_original_file_path text,p_file_hash text,p_pay_period_start date default null,p_pay_period_end date default null,p_pay_date date default null,p_currency text default 'USD',p_column_map_id uuid default null,p_supersedes_batch_id uuid default null) returns public.payroll_import_batches language sql security invoker set search_path='' as $$ select * from pay_internal.create_payroll_import_batch(p_organization_id,p_batch_type,p_original_file_name,p_original_file_path,p_file_hash,p_pay_period_start,p_pay_period_end,p_pay_date,p_currency,p_column_map_id,p_supersedes_batch_id); $$;
revoke all on function public.create_payroll_import_batch(uuid,text,text,text,text,date,date,date,text,uuid,uuid) from public,anon;
grant execute on function public.create_payroll_import_batch(uuid,text,text,text,text,date,date,date,text,uuid,uuid) to authenticated;

create function public.recompute_payroll_batch_status(p_batch_id uuid) returns public.payroll_import_batches language sql security invoker set search_path='' as $$ select * from pay_internal.recompute_payroll_batch_status(p_batch_id); $$;
revoke all on function public.recompute_payroll_batch_status(uuid) from public,anon;
grant execute on function public.recompute_payroll_batch_status(uuid) to authenticated;

create function public.resolve_payroll_row_match(p_row_id uuid,p_employee_id uuid) returns public.payroll_import_rows language sql security invoker set search_path='' as $$ select * from pay_internal.resolve_payroll_row_match(p_row_id,p_employee_id); $$;
revoke all on function public.resolve_payroll_row_match(uuid,uuid) from public,anon;
grant execute on function public.resolve_payroll_row_match(uuid,uuid) to authenticated;

create function public.resolve_compensation_row_match(p_row_id uuid,p_employee_id uuid) returns public.compensation_change_rows language sql security invoker set search_path='' as $$ select * from pay_internal.resolve_compensation_row_match(p_row_id,p_employee_id); $$;
revoke all on function public.resolve_compensation_row_match(uuid,uuid) from public,anon;
grant execute on function public.resolve_compensation_row_match(uuid,uuid) to authenticated;

create function public.approve_payroll_import(p_batch_id uuid) returns public.payroll_import_batches language sql security invoker set search_path='' as $$ select * from pay_internal.approve_payroll_import(p_batch_id); $$;
revoke all on function public.approve_payroll_import(uuid) from public,anon;
grant execute on function public.approve_payroll_import(uuid) to authenticated;

create function public.reject_payroll_import(p_batch_id uuid,p_reason text) returns public.payroll_import_batches language sql security invoker set search_path='' as $$ select * from pay_internal.reject_payroll_import(p_batch_id,p_reason); $$;
revoke all on function public.reject_payroll_import(uuid,text) from public,anon;
grant execute on function public.reject_payroll_import(uuid,text) to authenticated;

create function public.claim_payroll_processing(p_batch_id uuid) returns public.payroll_import_batches language sql security invoker set search_path='' as $$ select * from pay_internal.claim_payroll_processing(p_batch_id); $$;
revoke all on function public.claim_payroll_processing(uuid) from public,anon;
grant execute on function public.claim_payroll_processing(uuid) to authenticated;

create function public.submit_pay_query(p_category text,p_subject text,p_message text,p_client_request_id uuid,p_payslip_id uuid default null) returns public.pay_queries language sql security invoker set search_path='' as $$ select * from pay_internal.submit_pay_query(p_category,p_subject,p_message,p_client_request_id,p_payslip_id); $$;
revoke all on function public.submit_pay_query(text,text,text,uuid,uuid) from public,anon;
grant execute on function public.submit_pay_query(text,text,text,uuid,uuid) to authenticated;

create function public.reply_pay_query(p_query_id uuid,p_message text,p_status text default 'in_review',p_resolution_payslip_id uuid default null) returns public.pay_queries language sql security invoker set search_path='' as $$ select * from pay_internal.reply_pay_query(p_query_id,p_message,p_status,p_resolution_payslip_id); $$;
revoke all on function public.reply_pay_query(uuid,text,text,uuid) from public,anon;
grant execute on function public.reply_pay_query(uuid,text,text,uuid) to authenticated;

create function public.get_my_pay(p_year integer default null,p_currency text default null,p_page integer default 1) returns jsonb language sql security invoker set search_path='' as $$ select pay_internal.get_my_pay(p_year,p_currency,p_page); $$;
revoke all on function public.get_my_pay(integer,text,integer) from public,anon;
grant execute on function public.get_my_pay(integer,text,integer) to authenticated;

create function public.get_payslip(p_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select pay_internal.get_payslip(p_id); $$;
revoke all on function public.get_payslip(uuid) from public,anon;
grant execute on function public.get_payslip(uuid) to authenticated;

revoke all on all functions in schema pay_internal from public,anon,authenticated;
grant execute on function pay_internal.can_read(uuid,uuid),pay_internal.can_manage_query(uuid,text) to authenticated;
grant execute on function pay_internal.create_payroll_import_batch(uuid,text,text,text,text,date,date,date,text,uuid,uuid) to authenticated;
grant execute on function pay_internal.recompute_payroll_batch_status(uuid) to authenticated;
grant execute on function pay_internal.resolve_payroll_row_match(uuid,uuid) to authenticated;
grant execute on function pay_internal.resolve_compensation_row_match(uuid,uuid) to authenticated;
grant execute on function pay_internal.approve_payroll_import(uuid) to authenticated;
grant execute on function pay_internal.reject_payroll_import(uuid,text) to authenticated;
grant execute on function pay_internal.claim_payroll_processing(uuid) to authenticated;
grant execute on function pay_internal.submit_pay_query(text,text,text,uuid,uuid) to authenticated;
grant execute on function pay_internal.reply_pay_query(uuid,text,text,uuid) to authenticated;
grant execute on function pay_internal.get_my_pay(integer,text,integer) to authenticated;
grant execute on function pay_internal.get_payslip(uuid) to authenticated;

create function pay_internal.reconcile_payroll_row(p_row_id uuid,p_employee_id uuid,p_note text,p_compensation boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b public.payroll_import_batches; before_row jsonb; after_row jsonb; bid uuid;
begin
 if length(trim(coalesce(p_note,''))) not between 10 and 1000 then raise exception 'Explain the employee match (10–1000 characters)'; end if;
 if p_compensation then select batch_id,to_jsonb(r) into bid,before_row from public.compensation_change_rows r where id=p_row_id;
 else select batch_id,to_jsonb(r) into bid,before_row from public.payroll_import_rows r where id=p_row_id; end if;
 select * into b from public.payroll_import_batches where id=bid for update;
 if b.id is null or not private.has_permission(b.organization_id,'payroll.import') then raise exception 'Not authorized'; end if;
 perform private.assert_step_up(b.organization_id);
 if b.status in ('approved','superseded','rejected') then raise exception 'Closed batches cannot be rematched'; end if;
 if not exists(select 1 from public.employees where id=p_employee_id and organization_id=b.organization_id) then raise exception 'Employee must belong to the payroll organization'; end if;
 if p_compensation then update public.compensation_change_rows set employee_id=p_employee_id,mapping_status='matched' where id=p_row_id returning to_jsonb(compensation_change_rows.*) into after_row;
 else update public.payroll_import_rows set employee_id=p_employee_id,mapping_status='matched' where id=p_row_id returning to_jsonb(payroll_import_rows.*) into after_row; end if;
 perform pay_internal.recompute_payroll_batch_status(b.id);
 perform private.log_audit_event(b.organization_id,'PAYROLL_EMPLOYEE_MATCHED','payroll_import_row',p_row_id,jsonb_build_object('employee_id',before_row->'employee_id'),jsonb_build_object('employee_id',p_employee_id,'reason',trim(p_note)));
 if p_compensation then select to_jsonb(r) into after_row from public.compensation_change_rows r where id=p_row_id; else select to_jsonb(r) into after_row from public.payroll_import_rows r where id=p_row_id; end if;
 return after_row;
end; $$;
create or replace function pay_internal.resolve_payroll_row_match(p_row_id uuid,p_employee_id uuid) returns public.payroll_import_rows language sql security definer set search_path='' as $$
 select * from jsonb_populate_record(null::public.payroll_import_rows,pay_internal.reconcile_payroll_row(p_row_id,p_employee_id,'Employee match confirmed using the payroll matching API',false)); $$;
create or replace function pay_internal.resolve_compensation_row_match(p_row_id uuid,p_employee_id uuid) returns public.compensation_change_rows language sql security definer set search_path='' as $$
 select * from jsonb_populate_record(null::public.compensation_change_rows,pay_internal.reconcile_payroll_row(p_row_id,p_employee_id,'Employee match confirmed using the payroll matching API',true)); $$;
create function public.reconcile_payroll_row(p_row_id uuid,p_employee_id uuid,p_note text,p_compensation boolean default false) returns jsonb language sql security invoker set search_path='' as $$ select pay_internal.reconcile_payroll_row(p_row_id,p_employee_id,p_note,p_compensation); $$;
revoke all on function public.reconcile_payroll_row(uuid,uuid,text,boolean),pay_internal.reconcile_payroll_row(uuid,uuid,text,boolean) from public,anon;
grant execute on function public.reconcile_payroll_row(uuid,uuid,text,boolean),pay_internal.reconcile_payroll_row(uuid,uuid,text,boolean) to authenticated;
-- A correction must be explicitly reviewed; deleting a query's history is never a workflow action.
create trigger immutable_pay_message before update or delete on public.pay_query_messages for each row execute function pay_internal.immutable_publication();

create function pay_internal.list_payroll_employees(p_organization_id uuid,p_search text default '') returns jsonb language plpgsql stable security definer set search_path='' as $$ begin
 if not private.has_permission(p_organization_id,'payroll.import') then raise exception 'Not authorized'; end if;
 if private.user_requires_mfa(p_organization_id,auth.uid()) and coalesce(auth.jwt()->>'aal','aal1')<>'aal2' then raise exception 'Multi-factor authentication required'; end if;
 return (select coalesce(jsonb_agg(to_jsonb(e)),'[]') from(select id,employee_number,first_name,last_name from public.employees where organization_id=p_organization_id and
  (coalesce(p_search,'')='' or position(lower(left(p_search,100)) in lower(concat_ws(' ',employee_number,external_payroll_id,first_name,last_name)))>0) order by employee_number,id limit 200) e);
end; $$;
create function public.list_payroll_employees(p_organization_id uuid,p_search text default '') returns jsonb language sql security invoker set search_path='' as $$ select pay_internal.list_payroll_employees(p_organization_id,p_search); $$;
revoke all on function public.list_payroll_employees(uuid,text),pay_internal.list_payroll_employees(uuid,text) from public,anon;
grant execute on function public.list_payroll_employees(uuid,text),pay_internal.list_payroll_employees(uuid,text) to authenticated;

-- HR raw-source access follows required MFA as well as its existing import grant.
create policy "payroll source requires MFA" on public.payroll_import_batches as restrictive for select to authenticated using(not private.user_requires_mfa(organization_id,auth.uid()) or coalesce(auth.jwt()->>'aal','aal1')='aal2');
create policy "payroll rows require MFA" on public.payroll_import_rows as restrictive for select to authenticated using(exists(select 1 from public.payroll_import_batches b where b.id=batch_id));
create policy "compensation rows require MFA" on public.compensation_change_rows as restrictive for select to authenticated using(exists(select 1 from public.payroll_import_batches b where b.id=batch_id));
create policy "private pay notes require MFA" on public.compensation_private_notes as restrictive for select to authenticated using(not private.user_requires_mfa(organization_id,auth.uid()) or coalesce(auth.jwt()->>'aal','aal1')='aal2');
-- Permit cleanup of unused uploads only. A registered payroll source file stays retained.
create policy "remove unused payroll upload" on storage.objects for delete to authenticated using(
 bucket_id='payroll-imports' and private.has_permission((storage.foldername(name))[1]::uuid,'payroll.import') and
 not exists(select 1 from public.payroll_import_batches b where b.original_file_path=name));
