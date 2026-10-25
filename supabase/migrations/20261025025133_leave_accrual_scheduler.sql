-- Explicit employer opt-in. No existing entitlement or expiry rule is enabled.
alter table public.leave_policies add column automated_accrual boolean not null default false,
 add column first_accrual_date date;
create function private.leave_accrual_guard() returns trigger language plpgsql security definer set search_path='' as $$ begin
 if new.accrual_amount<0 or new.carryover_max<0 or new.carryover_expires_after_months<0 then raise exception 'Entitlement settings cannot be negative'; end if;
 if new.automated_accrual then
  if new.first_accrual_date is null or new.accrual_amount<=0 or new.accrual_method not in ('annual_grant','monthly','per_pay_period') then raise exception 'Automatic credits need a first credit date, positive amount and supported frequency'; end if;
  if auth.uid() is not null and (tg_op='INSERT' or new.first_accrual_date is distinct from old.first_accrual_date or not old.automated_accrual)
   and new.first_accrual_date<=private.org_today(new.organization_id) then raise exception 'Choose a future first credit date to avoid duplicating opening entitlement'; end if;
 end if;
 perform private.assert_step_up(new.organization_id);
 return new;
end; $$;
create trigger leave_accrual_validation before insert or update on public.leave_policies for each row execute function private.leave_accrual_guard();

create function private.run_leave_accruals(p_org uuid default null) returns int language plpgsql security definer set search_path='' as $$
declare p public.leave_policies; e public.employees; d date; n int; rows_added int; total int:=0; v_key text; v_cycle record;
begin
 for p in select * from public.leave_policies where automated_accrual and is_active and first_accrual_date<=private.org_today(organization_id) and (p_org is null or organization_id=p_org) loop
  for e in select distinct emp.* from public.employees emp join public.leave_policy_assignments a on a.employee_id=emp.id and a.leave_policy_id=p.id
   where emp.organization_id=p.organization_id and emp.status in ('active','leave') loop
   perform pg_advisory_xact_lock(hashtextextended(e.id::text,7));
   for v_cycle in
    select cycle.d,cycle.token from (
     select (p.first_accrual_date + i * case when p.accrual_method='annual_grant' then interval '1 year' else interval '1 month' end)::date as d, 'date:'||(p.first_accrual_date + i * case when p.accrual_method='annual_grant' then interval '1 year' else interval '1 month' end)::date::text as token
      from generate_series(0,case when p.accrual_method='annual_grant' then 100 else 1200 end) i where p.accrual_method in ('annual_grant','monthly')
     union
     select pp.pay_date,'period:'||pp.id::text from public.pay_periods pp join public.pay_groups g on g.pay_calendar_id=pp.pay_calendar_id and g.organization_id=p.organization_id
      join public.employee_compensation c on c.pay_group_id=g.id and c.employee_id=e.id and c.start_date<=pp.period_end and (c.end_date is null or c.end_date>=pp.period_end)
      where p.accrual_method='per_pay_period' and pp.status<>'canceled' and pp.pay_date>=p.first_accrual_date
    ) cycle where cycle.d<=private.org_today(p.organization_id) and cycle.d>=coalesce(e.hire_date,cycle.d)
     and cycle.d>=p.first_accrual_date and exists(select 1 from public.leave_policy_assignments a where a.employee_id=e.id and a.leave_policy_id=p.id and a.start_date<=cycle.d and (a.end_date is null or a.end_date>=cycle.d))
     -- One effective policy per employee/type/date: latest assignment wins.
     and p.id=(select a.leave_policy_id from public.leave_policy_assignments a join public.leave_policies lp on lp.id=a.leave_policy_id
      where a.employee_id=e.id and lp.leave_type_id=p.leave_type_id and lp.is_active and a.start_date<=cycle.d and (a.end_date is null or a.end_date>=cycle.d)
      order by lp.is_default asc,a.start_date desc,a.created_at desc,a.id desc limit 1)
   loop
    d:=v_cycle.d;
    v_key:='leave:accrual:'||p.id||':'||e.id||':'||v_cycle.token;
    insert into public.leave_ledger(organization_id,employee_id,leave_type_id,entry_type,amount,effective_date,note,created_by,idempotency_key)
    values(p.organization_id,e.id,p.leave_type_id,'accrual',p.accrual_amount,d,'Scheduled employer entitlement — '||p.name,auth.uid(),v_key)
    on conflict(organization_id,idempotency_key) where idempotency_key is not null do nothing;
    get diagnostics rows_added=row_count; total:=total+rows_added;
   end loop;
  end loop;
 end loop;
 return total;
end; $$;
revoke all on function private.run_leave_accruals(uuid) from public,anon,authenticated;
create function leave_internal.run_leave_accruals(p_organization_id uuid) returns int language plpgsql security definer set search_path='' as $$ declare n int;
begin
 if auth.uid() is null or not private.has_permission(p_organization_id,'leave.manage_policies') then raise exception 'Only HR can run leave accruals'; end if;
 perform private.assert_step_up(p_organization_id); n:=private.run_leave_accruals(p_organization_id);
 perform private.log_audit_event(p_organization_id,'LEAVE_ACCRUALS_RUN','organization',p_organization_id,null,jsonb_build_object('credits_added',n)); return n;
end; $$;
create function public.run_leave_accruals(p_organization_id uuid) returns int language sql security invoker set search_path='' as $$ select leave_internal.run_leave_accruals(p_organization_id); $$;
revoke all on function leave_internal.run_leave_accruals(uuid),public.run_leave_accruals(uuid) from public,anon;
grant execute on function leave_internal.run_leave_accruals(uuid),public.run_leave_accruals(uuid) to authenticated;

create function leave_internal.save_leave_accrual_policy(p_organization_id uuid,p_leave_type_id uuid,p_method text,p_amount numeric,p_enabled boolean,p_first_date date)
returns uuid language plpgsql security definer set search_path='' as $$ declare v_id uuid;
begin
 if auth.uid() is null or not private.has_permission(p_organization_id,'leave.manage_policies') then raise exception 'Only HR can configure entitlement policies'; end if;
 perform private.assert_step_up(p_organization_id);
 if not exists(select 1 from public.leave_types where id=p_leave_type_id and organization_id=p_organization_id and balance_tracked) then raise exception 'Choose a tracked leave type in this organization'; end if;
 if p_method not in ('none','annual_grant','monthly','per_pay_period') or p_amount is null or p_amount<0 or p_amount>9999 or p_enabled is null then raise exception 'Check the entitlement frequency and amount'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_leave_type_id::text,9));
 select id into v_id from public.leave_policies where organization_id=p_organization_id and leave_type_id=p_leave_type_id and is_default and is_active order by created_at limit 1;
 if v_id is null then
  -- Enrol staff without issuing an unrequested opening credit.
  insert into public.leave_policies(organization_id,leave_type_id,name,accrual_method,accrual_amount,is_default) values(p_organization_id,p_leave_type_id,'Employer entitlement','none',0,true) returning id into v_id;
 end if;
 update public.leave_policies set accrual_method=p_method,accrual_amount=p_amount,automated_accrual=p_enabled,first_accrual_date=p_first_date where id=v_id;
 return v_id;
end; $$;
create function public.save_leave_accrual_policy(p_organization_id uuid,p_leave_type_id uuid,p_method text,p_amount numeric,p_enabled boolean,p_first_date date)
returns uuid language sql security invoker set search_path='' as $$ select leave_internal.save_leave_accrual_policy(p_organization_id,p_leave_type_id,p_method,p_amount,p_enabled,p_first_date); $$;
revoke all on function leave_internal.save_leave_accrual_policy(uuid,uuid,text,numeric,boolean,date),public.save_leave_accrual_policy(uuid,uuid,text,numeric,boolean,date) from public,anon;
grant execute on function leave_internal.save_leave_accrual_policy(uuid,uuid,text,numeric,boolean,date),public.save_leave_accrual_policy(uuid,uuid,text,numeric,boolean,date) to authenticated;

do $$ begin
 if exists(select 1 from pg_extension where extname='pg_cron') then
  perform cron.schedule('halomanage-leave-accruals','15 * * * *','select private.run_leave_accruals();');
 end if;
end $$;
