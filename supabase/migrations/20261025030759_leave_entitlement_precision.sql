-- Credits and balance corrections support fractional-day accrual (e.g. 15/12 = 1.25).
-- Requests remain full/half-day; employer credits can use hundredths of a day.
create or replace function leave_internal.adjust_leave_balance(p_employee_id uuid,p_leave_type_id uuid,p_amount numeric,p_note text,p_effective_date date,p_key uuid)
returns uuid language plpgsql security definer set search_path='' as $$ declare e public.employees; v_id uuid;
begin
 select * into e from public.employees where id=p_employee_id;
 if auth.uid() is null or e.id is null or not private.has_permission(e.organization_id,'leave.manage_policies') then raise exception 'Not authorized to adjust leave balances'; end if;
 perform private.assert_step_up(e.organization_id); perform pg_advisory_xact_lock(hashtextextended(e.id::text,7));
 if not exists(select 1 from public.leave_types where id=p_leave_type_id and organization_id=e.organization_id and balance_tracked)
  or p_amount is null or p_amount=0 or abs(p_amount)>9999 or p_amount<>round(p_amount,2)
  or nullif(trim(p_note),'') is null or p_key is null or p_effective_date is null then raise exception 'Choose a tracked leave type, a nonzero amount with at most two decimal places, effective date, unique key and adjustment reason'; end if;
 select id into v_id from public.leave_ledger where organization_id=e.organization_id and idempotency_key='leave:adjust:'||p_key;
 if v_id is not null then
  if not exists(select 1 from public.leave_ledger where id=v_id and employee_id=e.id and leave_type_id=p_leave_type_id and amount=p_amount and effective_date=p_effective_date and note=trim(p_note)) then raise exception 'Retry key already used for another adjustment'; end if;
  return v_id;
 end if;
 insert into public.leave_ledger(organization_id,employee_id,leave_type_id,entry_type,amount,effective_date,note,created_by,idempotency_key)
 values(e.organization_id,e.id,p_leave_type_id,'adjustment',p_amount,p_effective_date,trim(p_note),auth.uid(),'leave:adjust:'||p_key) returning id into v_id;
 perform private.log_audit_event(e.organization_id,'LEAVE_BALANCE_ADJUSTED','leave_ledger',v_id,null,jsonb_build_object('employee_id',e.id,'days',p_amount,'effective_date',p_effective_date,'reason',trim(p_note)));
 return v_id;
end; $$;

create or replace function leave_internal.save_leave_accrual_policy(p_organization_id uuid,p_leave_type_id uuid,p_method text,p_amount numeric,p_enabled boolean,p_first_date date)
returns uuid language plpgsql security definer set search_path='' as $$ declare v_id uuid;
begin
 if auth.uid() is null or not private.has_permission(p_organization_id,'leave.manage_policies') then raise exception 'Only HR can configure entitlement policies'; end if;
 perform private.assert_step_up(p_organization_id);
 if not exists(select 1 from public.leave_types where id=p_leave_type_id and organization_id=p_organization_id and balance_tracked) then raise exception 'Choose a tracked leave type in this organization'; end if;
 if p_method not in ('none','annual_grant','monthly','per_pay_period') or p_amount is null or p_amount<0 or p_amount>9999 or p_amount<>round(p_amount,2) or p_enabled is null then raise exception 'Check the entitlement frequency and amount'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_leave_type_id::text,9));
 select id into v_id from public.leave_policies where organization_id=p_organization_id and leave_type_id=p_leave_type_id and is_default and is_active order by created_at limit 1;
 if v_id is null then
  -- Enrol staff without issuing an unrequested opening credit.
  insert into public.leave_policies(organization_id,leave_type_id,name,accrual_method,accrual_amount,is_default) values(p_organization_id,p_leave_type_id,'Employer entitlement','none',0,true) returning id into v_id;
 end if;
 update public.leave_policies set accrual_method=p_method,accrual_amount=p_amount,automated_accrual=p_enabled,first_accrual_date=p_first_date where id=v_id;
 return v_id;
end; $$;
