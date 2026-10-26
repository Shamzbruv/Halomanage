-- Rewards: accountable manual fulfillment, immutable receipts and exact points accounting.
create schema rewards_internal;
revoke all on schema rewards_internal from public,anon;
grant usage on schema rewards_internal to authenticated;

create function rewards_internal.member(p_org uuid) returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and (recognition_internal.employee(p_org)).id is not null and (not private.user_requires_mfa(p_org,auth.uid()) or coalesce(auth.jwt()->>'aal','aal1')='aal2');
$$;
create function rewards_internal.allowed(p_org uuid,p_permission public.app_permission) returns boolean language sql stable security definer set search_path='' as $$ select rewards_internal.member(p_org) and private.has_permission(p_org,p_permission); $$;
create function rewards_internal.authorize(p_org uuid,p_permission public.app_permission,p_require_enabled boolean default false) returns void language plpgsql security definer set search_path='' as $$ begin
 if not rewards_internal.allowed(p_org,p_permission) then raise exception using errcode='42501',message='Rewards permission and an eligible employee account are required';end if;
 perform private.assert_step_up(p_org);
 if p_require_enabled and not public.organization_has_feature(p_org,'rewards_marketplace') then raise exception 'The Rewards marketplace is paused';end if;
end; $$;

alter table public.reward_products add column terms text;
alter table public.reward_redemptions add column product_name text,add column vendor_name text,add column product_description text,add column terms text,
 add column stock_reserved boolean not null default false,add column client_request_id uuid,add column request_payload jsonb,
 add column resolved_at timestamptz,add column resolved_by uuid references auth.users(id);
-- Legacy receipts can only be reconstructed from the current catalog, not an invented past.
update public.reward_redemptions r set product_name=p.name,vendor_name=v.name,product_description=p.description,terms=p.terms,stock_reserved=p.inventory_quantity is not null,
 resolved_at=case when r.status<>'pending_fulfillment' then coalesce(r.fulfilled_at,r.updated_at) end,resolved_by=r.fulfilled_by
 from public.reward_products p join public.reward_vendors v on v.id=p.vendor_id where p.id=r.product_id;
alter table public.employee_points_ledger add column client_request_id uuid,add column request_payload jsonb;
create unique index reward_request_once_idx on public.reward_redemptions(employee_id,client_request_id) where client_request_id is not null;
create unique index reward_award_request_once_idx on public.employee_points_ledger(created_by,client_request_id) where entry_type='award' and client_request_id is not null;
create unique index reward_debit_once_idx on public.employee_points_ledger(related_redemption_id) where entry_type='redemption';
create unique index reward_refund_once_idx on public.employee_points_ledger(related_redemption_id) where entry_type='refund';
create index reward_history_org_created_idx on public.reward_redemptions(organization_id,created_at desc,id);

create unique index reward_vendor_name_once_idx on public.reward_vendors(organization_id,lower(trim(name)));
create unique index reward_product_name_once_idx on public.reward_products(organization_id,vendor_id,lower(trim(name)));

-- Catalog contacts are operational HR data. Employees receive a deliberately limited RPC projection.
drop policy "org members read reward vendors" on public.reward_vendors;
drop policy "manage reward vendors" on public.reward_vendors;
create policy "HR reads reward vendor contacts" on public.reward_vendors for select to authenticated using(rewards_internal.allowed(organization_id,'rewards.manage_catalog') or rewards_internal.allowed(organization_id,'rewards.fulfill'));
create policy "HR inserts reward vendors" on public.reward_vendors for insert to authenticated with check(rewards_internal.allowed(organization_id,'rewards.manage_catalog'));
create policy "HR updates reward vendors" on public.reward_vendors for update to authenticated using(rewards_internal.allowed(organization_id,'rewards.manage_catalog')) with check(rewards_internal.allowed(organization_id,'rewards.manage_catalog'));
drop policy "org members read reward products" on public.reward_products;
drop policy "manage reward products" on public.reward_products;
create policy "scoped reward products" on public.reward_products for select to authenticated using(rewards_internal.allowed(organization_id,'rewards.manage_catalog') or rewards_internal.allowed(organization_id,'rewards.fulfill') or (rewards_internal.allowed(organization_id,'rewards.read_self') and is_active and public.organization_has_feature(organization_id,'rewards_marketplace')));
create policy "HR inserts reward products" on public.reward_products for insert to authenticated with check(rewards_internal.allowed(organization_id,'rewards.manage_catalog'));
create policy "HR updates reward products" on public.reward_products for update to authenticated using(rewards_internal.allowed(organization_id,'rewards.manage_catalog')) with check(rewards_internal.allowed(organization_id,'rewards.manage_catalog'));
drop policy "read own redemptions" on public.reward_redemptions;
drop policy "read team redemptions" on public.reward_redemptions;
drop policy "manage redemptions" on public.reward_redemptions;
create policy "private rewards requests" on public.reward_redemptions for select to authenticated using(rewards_internal.allowed(organization_id,'rewards.fulfill') or (rewards_internal.allowed(organization_id,'rewards.read_self') and employee_id=(recognition_internal.employee(organization_id)).id));
drop policy "read own points ledger" on public.employee_points_ledger;
drop policy "read team points ledger" on public.employee_points_ledger;
drop policy "read org points ledger" on public.employee_points_ledger;
create policy "private rewards balances" on public.employee_points_ledger for select to authenticated using(rewards_internal.allowed(organization_id,'rewards.award_points') or rewards_internal.allowed(organization_id,'rewards.fulfill') or (rewards_internal.allowed(organization_id,'rewards.read_self') and employee_id=(recognition_internal.employee(organization_id)).id));
grant select on public.reward_providers,public.reward_vendors,public.reward_products,public.reward_redemptions,public.employee_points_ledger,public.employee_points_balance_v to authenticated;
grant insert,update on public.reward_vendors,public.reward_products to authenticated;
revoke delete on public.reward_vendors,public.reward_products from authenticated;
revoke insert,update,delete on public.reward_redemptions,public.employee_points_ledger from authenticated;

create function rewards_internal.catalog_guard() returns trigger language plpgsql security definer set search_path='' as $$ begin
 if tg_op='DELETE' then raise exception 'Archive vendors and rewards instead of deleting their history';end if;
 -- Inventory changes made inside a redemption or refund are audited by that operation.
 if tg_table_name='reward_products' and tg_op='UPDATE' and pg_trigger_depth()>1 then return new;end if;
 if auth.uid() is not null then perform rewards_internal.authorize(new.organization_id,'rewards.manage_catalog',true);end if;
 if tg_op='UPDATE' and (new.organization_id<>old.organization_id or new.id<>old.id or new.created_at<>old.created_at or new.created_by is distinct from old.created_by) then raise exception 'Catalog identity and creation history are immutable';end if;
 new.name:=trim(new.name);new.description:=nullif(trim(new.description),'');
 if length(new.name) not between 1 and 120 or length(coalesce(new.description,''))>2000 then raise exception 'Use a name of 1–120 characters and a description of at most 2000';end if;
 if tg_table_name='reward_vendors' then
  new.contact_name:=nullif(trim(new.contact_name),'');new.contact_email:=nullif(trim(new.contact_email::text),'')::public.citext;new.contact_phone:=nullif(trim(new.contact_phone),'');
  if length(coalesce(new.contact_name,''))>120 or length(coalesce(new.contact_email::text,''))>254 or (new.contact_email is not null and new.contact_email::text !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') or length(coalesce(new.contact_phone,''))>60 then raise exception 'Check vendor contact details';end if;
 else
  new.terms:=nullif(trim(new.terms),'');new.image_url:=nullif(trim(new.image_url),'');
  if new.points_cost>1000000 or coalesce(new.inventory_quantity,0)>1000000 or length(coalesce(new.terms,''))>3000 or length(coalesce(new.image_url,''))>2000 or (new.image_url is not null and new.image_url !~ '^https://[^[:space:]]+$') then raise exception 'Use up to 1,000,000 points, 3000 characters of terms, and an HTTPS image URL';end if;
  if tg_op='UPDATE' and ((new.inventory_quantity is null)<>(old.inventory_quantity is null)) and exists(select 1 from public.reward_redemptions where product_id=new.id and status='pending_fulfillment') then raise exception 'Finish pending requests before changing stock tracking';end if;
 end if;
 if tg_op='INSERT' then new.created_by:=auth.uid();end if;
 perform private.log_audit_event(new.organization_id,'REWARD_CATALOG_CHANGED',tg_table_name,new.id,case when tg_op='UPDATE' then to_jsonb(old) end,to_jsonb(new));
 return new;
end; $$;
-- Stock updates use a separate helper so catalog permission is never inferred from client flags.
create function rewards_internal.move_stock(p_product uuid,p_delta integer) returns void language plpgsql security definer set search_path='' as $$ begin
 update public.reward_products set inventory_quantity=inventory_quantity+p_delta where id=p_product and inventory_quantity is not null;
end; $$;
-- Nested stock changes originate only in protected receipt transitions. No client-set flags bypass catalog permissions.
create function rewards_internal.stock_trigger() returns trigger language plpgsql security definer set search_path='' as $$ begin
 if tg_op='INSERT' and new.stock_reserved then perform rewards_internal.move_stock(new.product_id,-1);
 elsif tg_op='UPDATE' and old.status='pending_fulfillment' and new.status in ('cancelled','failed') and old.stock_reserved then perform rewards_internal.move_stock(old.product_id,1);end if;return new;
end; $$;
create trigger rewards_stock after insert or update on public.reward_redemptions for each row execute function rewards_internal.stock_trigger();
create trigger rewards_vendor_guard before insert or update or delete on public.reward_vendors for each row execute function rewards_internal.catalog_guard();
create trigger rewards_product_guard before insert or update or delete on public.reward_products for each row execute function rewards_internal.catalog_guard();

create function rewards_internal.redemption_guard() returns trigger language plpgsql security definer set search_path='' as $$ begin
 if tg_op='DELETE' then raise exception 'Reward receipts cannot be deleted';end if;
 if tg_op='INSERT' then
  if new.status<>'pending_fulfillment' or not exists(select 1 from public.employees e where e.id=new.employee_id and e.organization_id=new.organization_id and e.status in ('active','leave')) or not exists(select 1 from public.reward_products p where p.id=new.product_id and p.organization_id=new.organization_id) then raise exception 'Invalid reward receipt';end if;
 else
  if (to_jsonb(new)-'status'-'fulfillment_note'-'cancelled_reason'-'fulfilled_by'-'fulfilled_at'-'resolved_by'-'resolved_at'-'updated_at') is distinct from (to_jsonb(old)-'status'-'fulfillment_note'-'cancelled_reason'-'fulfilled_by'-'fulfilled_at'-'resolved_by'-'resolved_at'-'updated_at') then raise exception 'Reward identity, terms and points are immutable';end if;
  if old.status<>'pending_fulfillment' or new.status not in ('fulfilled','cancelled','failed') then raise exception 'Reward request is already resolved';end if;
 end if;return new;
end; $$;
create trigger rewards_receipt_integrity before insert or update or delete on public.reward_redemptions for each row execute function rewards_internal.redemption_guard();
create function rewards_internal.ledger_guard() returns trigger language plpgsql security definer set search_path='' as $$ declare r public.reward_redemptions;begin
 if new.entry_type in ('redemption','refund') or new.related_redemption_id is not null then
  select * into r from public.reward_redemptions where id=new.related_redemption_id;
  if r.id is null or r.organization_id<>new.organization_id or r.employee_id<>new.employee_id or new.related_recognition_id is not null or not ((new.entry_type='redemption' and new.amount=-r.points_spent) or (new.entry_type='refund' and new.amount=r.points_spent and r.status in ('cancelled','failed'))) then raise exception 'Reward ledger entry must exactly match its receipt';end if;
 elsif new.entry_type='award' and new.amount<1 then raise exception 'Awards must add points';end if;
 return new;
end; $$;
create trigger rewards_ledger_integrity before insert on public.employee_points_ledger for each row execute function rewards_internal.ledger_guard();
create function rewards_internal.check_receipt() returns trigger language plpgsql security definer set search_path='' as $$ declare r public.reward_redemptions;k uuid;begin
 if tg_table_name='reward_redemptions' then k:=new.id;else k:=new.related_redemption_id;end if;if k is null then return null;end if;
 select * into r from public.reward_redemptions where id=k;
 if r.id is not null and ((select count(*) from public.employee_points_ledger where related_redemption_id=k and entry_type='redemption' and amount=-r.points_spent and employee_id=r.employee_id and organization_id=r.organization_id)<>1 or (select count(*) from public.employee_points_ledger where related_redemption_id=k and entry_type='refund')<>case when r.status in ('cancelled','failed') then 1 else 0 end) then raise exception 'Reward receipt and points history do not reconcile';end if;return null;
end; $$;
create constraint trigger rewards_receipt_reconciles after insert or update on public.reward_redemptions deferrable initially deferred for each row execute function rewards_internal.check_receipt();
create constraint trigger rewards_ledger_reconciles after insert on public.employee_points_ledger deferrable initially deferred for each row execute function rewards_internal.check_receipt();

create function rewards_internal.award(p_employee_id uuid,p_amount integer,p_reason text,p_request_id uuid default null) returns public.employee_points_ledger language plpgsql security definer set search_path='' as $$
declare e public.employees;l public.employee_points_ledger;payload jsonb;begin
 select * into e from public.employees where id=p_employee_id;
 perform rewards_internal.authorize(e.organization_id,'rewards.award_points',true);
 if e.status not in ('active','leave') then raise exception 'Points can only be awarded to active employees or employees on leave';end if;
 if e.user_id=auth.uid() then raise exception 'Ask another authorized HR colleague to award your points';end if;
 if p_amount is null or p_amount not between 1 and 1000000 or length(trim(coalesce(p_reason,''))) not between 3 and 1000 then raise exception 'Use 1–1,000,000 points and an employee-visible reason of 3–1000 characters';end if;
 payload:=jsonb_build_object('employee_id',p_employee_id,'amount',p_amount,'reason',trim(p_reason));
 -- Actor lock serializes retry keys even if a caller changes the target employee.
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,94));
 if p_request_id is not null then select * into l from public.employee_points_ledger where created_by=auth.uid() and client_request_id=p_request_id and entry_type='award';if l.id is not null then if l.request_payload<>payload then raise exception 'This award retry key was already used for different details';end if;return l;end if;end if;
 perform pg_advisory_xact_lock(hashtextextended(e.id::text,91));
 insert into public.employee_points_ledger(organization_id,employee_id,entry_type,amount,reason,created_by,client_request_id,request_payload) values(e.organization_id,e.id,'award',p_amount,trim(p_reason),auth.uid(),p_request_id,payload) returning * into l;
 perform private.log_audit_event(e.organization_id,'REWARD_POINTS_AWARDED','employee',e.id,null,to_jsonb(l));
 if e.user_id is not null then perform private.create_notification(e.organization_id,e.user_id,e.id,'rewards.points_awarded','You received reward points','Open Rewards to see your balance and the reason.','/rewards',jsonb_build_object('ledger_id',l.id));end if;return l;
end; $$;
create function rewards_internal.redeem(p_product_id uuid,p_request_id uuid default null,p_expected_points integer default null,p_expected_updated_at timestamptz default null) returns public.reward_redemptions language plpgsql security definer set search_path='' as $$
declare e public.employees;p public.reward_products;v public.reward_vendors;provider public.reward_providers;r public.reward_redemptions;org uuid;balance bigint;payload jsonb;begin
 select organization_id into org from public.reward_products where id=p_product_id;
 perform rewards_internal.authorize(org,'rewards.redeem_self',true);e:=recognition_internal.employee(org);
 payload:=jsonb_build_object('product_id',p_product_id,'points',p_expected_points,'updated_at',p_expected_updated_at);
 -- All spending/refunds/recognition reversals use the employee balance lock first.
 perform pg_advisory_xact_lock(hashtextextended(e.id::text,91));
 if p_request_id is not null then select * into r from public.reward_redemptions where employee_id=e.id and client_request_id=p_request_id;if r.id is not null then if r.request_payload<>payload then raise exception 'This redemption retry key was already used for different details';end if;return r;end if;end if;
 select * into p from public.reward_products where id=p_product_id for update;
 if not p.is_active or p.id is null then raise exception 'This reward is not available';end if;
 select * into v from public.reward_vendors where id=p.vendor_id for share;
 select * into provider from public.reward_providers where id=v.provider_id for share;
 if not v.is_active or not provider.is_active or provider.fulfillment_type<>'manual' then raise exception 'This reward is unavailable; only connected manual fulfillment is supported';end if;
 if p_expected_points is not null and p_expected_points<>p.points_cost or p_expected_updated_at is not null and p_expected_updated_at<>p.updated_at then raise exception 'Reward details changed. Refresh and review the current cost and terms before confirming';end if;
 if p.inventory_quantity is not null and p.inventory_quantity<1 then raise exception 'This reward is out of stock';end if;
 select coalesce(sum(amount),0) into balance from public.employee_points_ledger where employee_id=e.id and organization_id=org;
 if balance<p.points_cost then raise exception 'Not enough points for this reward';end if;
 insert into public.reward_redemptions(organization_id,employee_id,product_id,points_spent,fulfillment_type,product_name,vendor_name,product_description,terms,stock_reserved,client_request_id,request_payload)
 values(org,e.id,p.id,p.points_cost,'manual',p.name,v.name,p.description,p.terms,p.inventory_quantity is not null,p_request_id,payload) returning * into r;
 insert into public.employee_points_ledger(organization_id,employee_id,entry_type,amount,reason,related_redemption_id,created_by) values(org,e.id,'redemption',-p.points_cost,'Redeemed: '||p.name,r.id,auth.uid());
 perform private.log_audit_event(org,'REWARD_REDEEMED','reward_redemption',r.id,null,to_jsonb(r));
 if e.user_id is not null then perform private.create_notification(org,e.user_id,e.id,'rewards.redemption_requested','Reward request received','Your points are reserved. Open Rewards to follow progress.','/rewards?redemption='||r.id,jsonb_build_object('redemption_id',r.id));end if;return r;
end; $$;
create function rewards_internal.resolve(p_redemption_id uuid,p_status text,p_note text,p_self boolean default false) returns public.reward_redemptions language plpgsql security definer set search_path='' as $$
declare r public.reward_redemptions;e public.employees;begin
 select * into r from public.reward_redemptions where id=p_redemption_id;
 if r.id is null then raise exception using errcode='42501',message='Reward request unavailable';end if;
 if p_self then
  perform rewards_internal.authorize(r.organization_id,'rewards.read_self');
  if r.employee_id is distinct from (recognition_internal.employee(r.organization_id)).id or p_status<>'cancelled' or r.fulfillment_type<>'manual' then raise exception using errcode='42501',message='You may cancel only your own pending manual request';end if;
 else perform rewards_internal.authorize(r.organization_id,'rewards.fulfill');end if;
 if p_status is null or p_status not in ('fulfilled','cancelled','failed') or length(trim(coalesce(p_note,''))) not between 3 and 1000 then raise exception 'Choose an outcome and enter an employee-visible explanation of 3–1000 characters';end if;
 perform pg_advisory_xact_lock(hashtextextended(r.employee_id::text,91));
 select * into r from public.reward_redemptions where id=p_redemption_id for update;
 if r.status=p_status and coalesce(case when p_status='cancelled' then r.cancelled_reason else r.fulfillment_note end,'')=trim(p_note) then return r;end if;
 if r.status<>'pending_fulfillment' then raise exception 'This reward request is already resolved; refresh its history';end if;
 update public.reward_redemptions set status=p_status,fulfillment_note=case when p_status<>'cancelled' then trim(p_note) end,cancelled_reason=case when p_status='cancelled' then trim(p_note) end,fulfilled_at=case when p_status='fulfilled' then now() end,fulfilled_by=case when p_status='fulfilled' then auth.uid() end,resolved_at=now(),resolved_by=auth.uid() where id=r.id returning * into r;
 if p_status in ('cancelled','failed') then insert into public.employee_points_ledger(organization_id,employee_id,entry_type,amount,reason,related_redemption_id,created_by) values(r.organization_id,r.employee_id,'refund',r.points_spent,'Refund: '||p_status||' redemption',r.id,auth.uid());end if;
 select * into e from public.employees where id=r.employee_id;
 if e.user_id is not null then perform private.create_notification(r.organization_id,e.user_id,e.id,'rewards.redemption_'||p_status,'Reward request '||p_status,case when p_status='fulfilled' then 'Open Rewards for collection or delivery details.' else 'Your points have been refunded. Open Rewards for details.' end,'/rewards?redemption='||r.id,jsonb_build_object('redemption_id',r.id));end if;
 perform private.log_audit_event(r.organization_id,'REWARD_REDEMPTION_'||upper(p_status),'reward_redemption',r.id,null,to_jsonb(r));return r;
end; $$;

-- Replace public privileged endpoints with invoker wrappers. Retire the previous spend path.
create or replace function public.award_employee_points(p_employee_id uuid,p_amount integer,p_reason text default null) returns public.employee_points_ledger language sql security invoker set search_path='' as $$ select * from rewards_internal.award(p_employee_id,p_amount,p_reason); $$;
create function public.grant_reward_points(p_employee_id uuid,p_amount integer,p_reason text,p_client_request_id uuid) returns public.employee_points_ledger language plpgsql security invoker set search_path='' as $$ begin if p_client_request_id is null then raise exception 'An award retry key is required';end if;return rewards_internal.award(p_employee_id,p_amount,p_reason,p_client_request_id);end; $$;
create or replace function public.redeem_reward(p_product_id uuid) returns public.reward_redemptions language sql security invoker set search_path='' as $$ select * from rewards_internal.redeem(p_product_id); $$;
create function public.request_reward(p_product_id uuid,p_client_request_id uuid,p_expected_points_cost integer,p_expected_updated_at timestamptz) returns public.reward_redemptions language plpgsql security invoker set search_path='' as $$ begin if p_client_request_id is null or p_expected_points_cost is null or p_expected_updated_at is null then raise exception 'Review the reward cost and terms before confirming';end if;return rewards_internal.redeem(p_product_id,p_client_request_id,p_expected_points_cost,p_expected_updated_at);end; $$;
create or replace function recognition_internal.redeem_reward(p_product_id uuid) returns public.reward_redemptions language sql security definer set search_path='' as $$ select * from rewards_internal.redeem(p_product_id); $$;
revoke all on function recognition_internal.redeem_reward_legacy(uuid) from public,anon,authenticated;
create or replace function public.fulfill_redemption(p_redemption_id uuid,p_note text default null) returns public.reward_redemptions language sql security invoker set search_path='' as $$ select * from rewards_internal.resolve(p_redemption_id,'fulfilled',p_note); $$;
create or replace function public.cancel_redemption(p_redemption_id uuid,p_reason text default null) returns public.reward_redemptions language sql security invoker set search_path='' as $$ select * from rewards_internal.resolve(p_redemption_id,'cancelled',p_reason); $$;
create or replace function public.fail_redemption(p_redemption_id uuid,p_error_message text default null) returns public.reward_redemptions language sql security invoker set search_path='' as $$ select * from rewards_internal.resolve(p_redemption_id,'failed',p_error_message); $$;
create function public.cancel_my_reward(p_redemption_id uuid,p_reason text) returns public.reward_redemptions language sql security invoker set search_path='' as $$ select * from rewards_internal.resolve(p_redemption_id,'cancelled',p_reason,true); $$;

create function rewards_internal.state(p_org uuid,p_catalog_page integer,p_history_page integer,p_ledger_page integer,p_query text,p_redemption uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare e public.employees;enabled boolean;begin
 if not rewards_internal.allowed(p_org,'rewards.read_self') then raise exception using errcode='42501',message='Rewards access unavailable';end if;
 if p_catalog_page is null or p_history_page is null or p_ledger_page is null or least(p_catalog_page,p_history_page,p_ledger_page)<1 or greatest(p_catalog_page,p_history_page,p_ledger_page)>100000 or length(coalesce(p_query,''))>120 then raise exception 'Invalid Rewards page or search';end if;
 e:=recognition_internal.employee(p_org);enabled:=public.organization_has_feature(p_org,'rewards_marketplace');
 return jsonb_build_object('enabled',enabled,'can_redeem',private.has_permission(p_org,'rewards.redeem_self'),'balance',(select coalesce(sum(amount),0) from public.employee_points_ledger where employee_id=e.id),
 'catalog_total',(select count(*) from public.reward_products p join public.reward_vendors v on v.id=p.vendor_id join public.reward_providers pr on pr.id=v.provider_id where enabled and p.organization_id=p_org and p.is_active and v.is_active and pr.is_active and pr.fulfillment_type='manual' and (trim(coalesce(p_query,''))='' or p.name ilike '%'||trim(p_query)||'%' or v.name ilike '%'||trim(p_query)||'%')),
 'catalog',coalesce((select jsonb_agg(to_jsonb(x)) from (select p.id,p.name,p.description,p.terms,p.image_url,p.points_cost,p.inventory_quantity,p.updated_at,v.name vendor_name from public.reward_products p join public.reward_vendors v on v.id=p.vendor_id join public.reward_providers pr on pr.id=v.provider_id where enabled and p.organization_id=p_org and p.is_active and v.is_active and pr.is_active and pr.fulfillment_type='manual' and (trim(coalesce(p_query,''))='' or p.name ilike '%'||trim(p_query)||'%' or v.name ilike '%'||trim(p_query)||'%') order by p.points_cost,p.name,p.id limit 12 offset (p_catalog_page-1)*12)x),'[]'::jsonb),
 'history_total',(select count(*) from public.reward_redemptions where employee_id=e.id),
 'history',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from public.reward_redemptions where employee_id=e.id order by created_at desc,id limit 10 offset (p_history_page-1)*10)x),'[]'::jsonb),
 'selected',(select to_jsonb(r) from public.reward_redemptions r where r.id=p_redemption and r.employee_id=e.id),
 'ledger_total',(select count(*) from public.employee_points_ledger where employee_id=e.id),
 'ledger',coalesce((select jsonb_agg(to_jsonb(x)) from (select id,entry_type,amount,reason,created_at,related_redemption_id,related_recognition_id from public.employee_points_ledger where employee_id=e.id order by created_at desc,id limit 20 offset (p_ledger_page-1)*20)x),'[]'::jsonb));
end; $$;
create function public.get_rewards_state(p_organization_id uuid,p_catalog_page integer default 1,p_history_page integer default 1,p_ledger_page integer default 1,p_query text default '',p_redemption_id uuid default null) returns jsonb language sql security invoker set search_path='' as $$ select rewards_internal.state(p_organization_id,p_catalog_page,p_history_page,p_ledger_page,p_query,p_redemption_id); $$;
create function rewards_internal.search_employees(p_org uuid,p_query text) returns table(id uuid,label text,balance bigint) language plpgsql stable security definer set search_path='' as $$ begin
 if not rewards_internal.allowed(p_org,'rewards.award_points') then raise exception using errcode='42501',message='Points awarding permission required';end if;
 if length(trim(coalesce(p_query,''))) not between 2 and 120 then return;end if;
 return query select e.id,concat_ws(' ',coalesce(nullif(trim(e.preferred_name),''),e.first_name),e.last_name),coalesce((select sum(l.amount) from public.employee_points_ledger l where l.employee_id=e.id),0) from public.employees e where e.organization_id=p_org and e.status in ('active','leave') and e.user_id is distinct from auth.uid() and concat_ws(' ',e.first_name,e.last_name,e.preferred_name,e.employee_number) ilike '%'||trim(p_query)||'%' order by e.last_name,e.first_name,e.id limit 20;
end; $$;
create function public.search_reward_employees(p_organization_id uuid,p_query text) returns table(id uuid,label text,balance bigint) language sql security invoker set search_path='' as $$ select * from rewards_internal.search_employees(p_organization_id,p_query); $$;
create function rewards_internal.admin_state(p_org uuid,p_status text,p_page integer,p_catalog_page integer,p_query text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare catalog boolean;fulfill boolean;award boolean;begin
 catalog:=rewards_internal.allowed(p_org,'rewards.manage_catalog');fulfill:=rewards_internal.allowed(p_org,'rewards.fulfill');award:=rewards_internal.allowed(p_org,'rewards.award_points');
 if not(catalog or fulfill or award) then raise exception using errcode='42501',message='Rewards administration permission required';end if;
 if p_status is null or p_status not in ('all','pending_fulfillment','fulfilled','cancelled','failed') or p_page is null or p_catalog_page is null or least(p_page,p_catalog_page)<1 or greatest(p_page,p_catalog_page)>100000 or length(coalesce(p_query,''))>120 then raise exception 'Invalid Rewards admin filter';end if;
 return jsonb_build_object('enabled',public.organization_has_feature(p_org,'rewards_marketplace'),'can_catalog',catalog,'can_fulfill',fulfill,'can_award',award,
 'providers',case when catalog then coalesce((select jsonb_agg(to_jsonb(x)) from (select id,name,fulfillment_type from public.reward_providers where is_active and fulfillment_type='manual' order by name)x),'[]'::jsonb) else '[]'::jsonb end,
 'vendors',case when catalog then coalesce((select jsonb_agg(to_jsonb(v) order by v.name,v.id) from public.reward_vendors v where organization_id=p_org),'[]'::jsonb) else '[]'::jsonb end,
 'products_total',case when catalog then (select count(*) from public.reward_products p where organization_id=p_org and (coalesce(trim(p_query),'')='' or p.name ilike '%'||trim(p_query)||'%')) else 0 end,
 'products',case when catalog then coalesce((select jsonb_agg(to_jsonb(x)) from (select p.*,v.name vendor_name from public.reward_products p join public.reward_vendors v on v.id=p.vendor_id where p.organization_id=p_org and (coalesce(trim(p_query),'')='' or p.name ilike '%'||trim(p_query)||'%') order by p.name,p.id limit 25 offset (p_catalog_page-1)*25)x),'[]'::jsonb) else '[]'::jsonb end,
 'requests_total',case when fulfill then (select count(*) from public.reward_redemptions r join public.employees e on e.id=r.employee_id where r.organization_id=p_org and (p_status='all' or r.status=p_status) and (coalesce(trim(p_query),'')='' or concat_ws(' ',r.product_name,e.first_name,e.last_name,e.preferred_name,e.employee_number,r.id::text) ilike '%'||trim(p_query)||'%')) else 0 end,
 'requests',case when fulfill then coalesce((select jsonb_agg(to_jsonb(x)) from (select r.*,concat_ws(' ',coalesce(nullif(trim(e.preferred_name),''),e.first_name),e.last_name) employee_name,e.status employee_status from public.reward_redemptions r join public.employees e on e.id=r.employee_id where r.organization_id=p_org and (p_status='all' or r.status=p_status) and (coalesce(trim(p_query),'')='' or concat_ws(' ',r.product_name,e.first_name,e.last_name,e.preferred_name,e.employee_number,r.id::text) ilike '%'||trim(p_query)||'%') order by case when r.status='pending_fulfillment' then 0 else 1 end,r.created_at,r.id limit 20 offset (p_page-1)*20)x),'[]'::jsonb) else '[]'::jsonb end,
 'pending_count',case when fulfill then (select count(*) from public.reward_redemptions where organization_id=p_org and status='pending_fulfillment') else null end,
 'oldest_pending',case when fulfill then (select min(created_at) from public.reward_redemptions where organization_id=p_org and status='pending_fulfillment') end,
 'negative_balances',case when fulfill or award then (select count(*) from (select employee_id from public.employee_points_ledger where organization_id=p_org group by employee_id having sum(amount)<0)x) end);
end; $$;
create function public.get_rewards_admin_state(p_organization_id uuid,p_status text default 'pending_fulfillment',p_page integer default 1,p_catalog_page integer default 1,p_query text default '') returns jsonb language sql security invoker set search_path='' as $$ select rewards_internal.admin_state(p_organization_id,p_status,p_page,p_catalog_page,p_query); $$;
create function rewards_internal.save_vendor(p_org uuid,p_data jsonb,p_id uuid,p_expected timestamptz) returns public.reward_vendors language plpgsql security definer set search_path='' as $$ declare v public.reward_vendors;begin
 perform rewards_internal.authorize(p_org,'rewards.manage_catalog',true);
 if p_data is null or jsonb_typeof(p_data)<>'object' then raise exception 'Vendor details are required';end if;
 if not exists(select 1 from public.reward_providers where id=(p_data->>'provider_id')::uuid and is_active and fulfillment_type='manual') then raise exception 'Choose an available manual fulfillment provider';end if;
 if p_id is not null then
  select * into v from public.reward_vendors where id=p_id and organization_id=p_org for update;
  if v.id is null or p_expected is null or v.updated_at<>p_expected then raise exception 'Vendor changed. Refresh before editing';end if;
  update public.reward_vendors set name=p_data->>'name',description=p_data->>'description',provider_id=(p_data->>'provider_id')::uuid,contact_name=p_data->>'contact_name',contact_email=(p_data->>'contact_email')::public.citext,contact_phone=p_data->>'contact_phone',is_active=coalesce((p_data->>'is_active')::boolean,true) where id=v.id returning * into v;
 else insert into public.reward_vendors(organization_id,provider_id,name,description,contact_name,contact_email,contact_phone,is_active) values(p_org,(p_data->>'provider_id')::uuid,p_data->>'name',p_data->>'description',p_data->>'contact_name',(p_data->>'contact_email')::public.citext,p_data->>'contact_phone',coalesce((p_data->>'is_active')::boolean,true)) returning * into v;end if;return v;
end; $$;
create function public.save_reward_vendor(p_organization_id uuid,p_data jsonb,p_vendor_id uuid default null,p_expected_updated_at timestamptz default null) returns public.reward_vendors language sql security invoker set search_path='' as $$ select * from rewards_internal.save_vendor(p_organization_id,p_data,p_vendor_id,p_expected_updated_at); $$;
create function rewards_internal.save_product(p_org uuid,p_data jsonb,p_id uuid,p_expected timestamptz) returns public.reward_products language plpgsql security definer set search_path='' as $$ declare p public.reward_products;begin
 perform rewards_internal.authorize(p_org,'rewards.manage_catalog',true);
 if p_data is null or jsonb_typeof(p_data)<>'object' then raise exception 'Reward details are required';end if;
 if not exists(select 1 from public.reward_vendors v join public.reward_providers pr on pr.id=v.provider_id where v.id=(p_data->>'vendor_id')::uuid and v.organization_id=p_org and pr.is_active and pr.fulfillment_type='manual') then raise exception 'Choose a manual vendor in this organization';end if;
 if p_id is not null then
  select * into p from public.reward_products where id=p_id and organization_id=p_org for update;
  if p.id is null or p_expected is null or p.updated_at<>p_expected then raise exception 'Reward or stock changed. Refresh before editing';end if;
  update public.reward_products set vendor_id=(p_data->>'vendor_id')::uuid,name=p_data->>'name',description=p_data->>'description',image_url=p_data->>'image_url',terms=p_data->>'terms',points_cost=(p_data->>'points_cost')::integer,inventory_quantity=(p_data->>'inventory_quantity')::integer,is_active=coalesce((p_data->>'is_active')::boolean,true) where id=p.id returning * into p;
 else insert into public.reward_products(organization_id,vendor_id,name,description,image_url,terms,points_cost,inventory_quantity,is_active) values(p_org,(p_data->>'vendor_id')::uuid,p_data->>'name',p_data->>'description',p_data->>'image_url',p_data->>'terms',(p_data->>'points_cost')::integer,(p_data->>'inventory_quantity')::integer,coalesce((p_data->>'is_active')::boolean,true)) returning * into p;end if;return p;
end; $$;
create function public.save_reward_product(p_organization_id uuid,p_data jsonb,p_product_id uuid default null,p_expected_updated_at timestamptz default null) returns public.reward_products language sql security invoker set search_path='' as $$ select * from rewards_internal.save_product(p_organization_id,p_data,p_product_id,p_expected_updated_at); $$;
revoke all on all functions in schema rewards_internal from public,anon,authenticated;
grant execute on function rewards_internal.member(uuid),rewards_internal.allowed(uuid,public.app_permission),rewards_internal.award(uuid,integer,text,uuid),rewards_internal.redeem(uuid,uuid,integer,timestamptz),rewards_internal.resolve(uuid,text,text,boolean),rewards_internal.state(uuid,integer,integer,integer,text,uuid),rewards_internal.search_employees(uuid,text),rewards_internal.admin_state(uuid,text,integer,integer,text),rewards_internal.save_vendor(uuid,jsonb,uuid,timestamptz),rewards_internal.save_product(uuid,jsonb,uuid,timestamptz) to authenticated;
revoke all on function public.award_employee_points(uuid,integer,text),public.grant_reward_points(uuid,integer,text,uuid),public.redeem_reward(uuid),public.request_reward(uuid,uuid,integer,timestamptz),public.fulfill_redemption(uuid,text),public.cancel_redemption(uuid,text),public.fail_redemption(uuid,text),public.cancel_my_reward(uuid,text),public.get_rewards_state(uuid,integer,integer,integer,text,uuid),public.search_reward_employees(uuid,text),public.get_rewards_admin_state(uuid,text,integer,integer,text),public.save_reward_vendor(uuid,jsonb,uuid,timestamptz),public.save_reward_product(uuid,jsonb,uuid,timestamptz) from public,anon;
grant execute on function public.award_employee_points(uuid,integer,text),public.grant_reward_points(uuid,integer,text,uuid),public.redeem_reward(uuid),public.request_reward(uuid,uuid,integer,timestamptz),public.fulfill_redemption(uuid,text),public.cancel_redemption(uuid,text),public.fail_redemption(uuid,text),public.cancel_my_reward(uuid,text),public.get_rewards_state(uuid,integer,integer,integer,text,uuid),public.search_reward_employees(uuid,text),public.get_rewards_admin_state(uuid,text,integer,integer,text),public.save_reward_vendor(uuid,jsonb,uuid,timestamptz),public.save_reward_product(uuid,jsonb,uuid,timestamptz) to authenticated;

-- Corrections append an exact reversal; the original award and reason remain intact.
alter table public.employee_points_ledger add column reversed_award_id uuid references public.employee_points_ledger(id);
create unique index reward_award_reversal_once_idx on public.employee_points_ledger(reversed_award_id) where reversed_award_id is not null;
create function rewards_internal.award_reversal_guard() returns trigger language plpgsql security definer set search_path='' as $$ declare original public.employee_points_ledger;begin
 if new.reversed_award_id is not null then
  select * into original from public.employee_points_ledger where id=new.reversed_award_id;
  if original.id is null or original.entry_type<>'award' or new.entry_type<>'adjustment' or new.amount<>-original.amount or new.employee_id<>original.employee_id or new.organization_id<>original.organization_id or new.related_recognition_id is not null or new.related_redemption_id is not null then raise exception 'An award correction must reverse its exact original entry';end if;
 end if;return new;
end; $$;
create trigger rewards_award_correction_integrity before insert on public.employee_points_ledger for each row execute function rewards_internal.award_reversal_guard();
create function rewards_internal.reverse_award(p_award uuid,p_reason text) returns public.employee_points_ledger language plpgsql security definer set search_path='' as $$ declare original public.employee_points_ledger;l public.employee_points_ledger;e public.employees;begin
 select * into original from public.employee_points_ledger where id=p_award and entry_type='award';
 perform rewards_internal.authorize(original.organization_id,'rewards.award_points');
 if length(trim(coalesce(p_reason,''))) not between 3 and 1000 then raise exception 'Explain this correction in 3–1000 employee-visible characters';end if;
 perform pg_advisory_xact_lock(hashtextextended(original.employee_id::text,91));
 select * into l from public.employee_points_ledger where reversed_award_id=original.id;
 if l.id is not null then return l;end if;
 insert into public.employee_points_ledger(organization_id,employee_id,entry_type,amount,reason,created_by,reversed_award_id) values(original.organization_id,original.employee_id,'adjustment',-original.amount,'Award correction: '||trim(p_reason),auth.uid(),original.id) returning * into l;
 perform private.log_audit_event(original.organization_id,'REWARD_AWARD_REVERSED','employee_points_ledger',original.id,to_jsonb(original),to_jsonb(l));
 select * into e from public.employees where id=original.employee_id;
 if e.user_id is not null then perform private.create_notification(original.organization_id,e.user_id,e.id,'rewards.award_corrected','Reward points corrected','Open Rewards to review the correction and contact HR with questions.','/rewards',jsonb_build_object('ledger_id',l.id));end if;return l;
end; $$;
create function public.reverse_reward_award(p_award_id uuid,p_reason text) returns public.employee_points_ledger language sql security invoker set search_path='' as $$ select * from rewards_internal.reverse_award(p_award_id,p_reason); $$;
create function rewards_internal.award_history(p_org uuid,p_page integer,p_query text) returns jsonb language plpgsql stable security definer set search_path='' as $$ begin
 if not rewards_internal.allowed(p_org,'rewards.award_points') then raise exception using errcode='42501',message='Points awarding permission required';end if;
 if p_page is null or p_page not between 1 and 100000 or length(coalesce(p_query,''))>120 then raise exception 'Invalid award history filter';end if;
 return jsonb_build_object('total',(select count(*) from public.employee_points_ledger l join public.employees e on e.id=l.employee_id where l.organization_id=p_org and l.entry_type='award' and (coalesce(trim(p_query),'')='' or concat_ws(' ',e.first_name,e.last_name,e.preferred_name,e.employee_number,l.reason) ilike '%'||trim(p_query)||'%')),
 'items',coalesce((select jsonb_agg(to_jsonb(x)) from (select l.id,l.employee_id,l.amount,l.reason,l.created_at,concat_ws(' ',coalesce(nullif(trim(e.preferred_name),''),e.first_name),e.last_name) employee_name,r.reason reversal_reason,r.created_at reversed_at from public.employee_points_ledger l join public.employees e on e.id=l.employee_id left join public.employee_points_ledger r on r.reversed_award_id=l.id where l.organization_id=p_org and l.entry_type='award' and (coalesce(trim(p_query),'')='' or concat_ws(' ',e.first_name,e.last_name,e.preferred_name,e.employee_number,l.reason) ilike '%'||trim(p_query)||'%') order by l.created_at desc,l.id limit 20 offset (p_page-1)*20)x),'[]'::jsonb));
end; $$;
create function public.list_reward_awards(p_organization_id uuid,p_page integer default 1,p_query text default '') returns jsonb language sql security invoker set search_path='' as $$ select rewards_internal.award_history(p_organization_id,p_page,p_query); $$;
revoke all on function rewards_internal.award_reversal_guard() from public,anon,authenticated;
revoke all on function rewards_internal.reverse_award(uuid,text),rewards_internal.award_history(uuid,integer,text),public.reverse_reward_award(uuid,text),public.list_reward_awards(uuid,integer,text) from public,anon;
grant execute on function rewards_internal.reverse_award(uuid,text),rewards_internal.award_history(uuid,integer,text),public.reverse_reward_award(uuid,text),public.list_reward_awards(uuid,integer,text) to authenticated;
