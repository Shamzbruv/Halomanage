-- Recognition: employee choice, accountable moderation and exact Rewards correlation.
create schema recognition_internal;
revoke all on schema recognition_internal from public,anon;
grant usage on schema recognition_internal to authenticated;
insert into public.role_permissions(organization_id,role,permission) select null,r::public.app_role,'recognition.read'::public.app_permission from unnest(array['employee','supervisor','manager','admin']) r on conflict do nothing;
insert into public.role_permissions(organization_id,role,permission) values(null,'admin','recognition.manage'),(null,'admin','recognition.moderate') on conflict do nothing;
-- Preserve the established built-in role bundles when an organization has overrides.
insert into public.role_permissions(organization_id,role,permission) select organization_id,role,'recognition.read' from public.role_permissions where organization_id is not null and role is not null and permission='recognition.give' on conflict do nothing;
insert into public.role_permissions(organization_id,role,permission) select organization_id,role,'recognition.manage' from public.role_permissions where organization_id is not null and role='admin' and permission='rewards.manage_catalog' on conflict do nothing;
insert into public.role_permissions(organization_id,role,permission) select organization_id,role,'recognition.moderate' from public.role_permissions where organization_id is not null and role='admin' and permission='rewards.award_points' on conflict do nothing;

alter table public.organization_recognition_settings add column enabled boolean not null default true,
 add column require_value boolean not null default false,
 add column max_points_per_recipient_per_month integer check(max_points_per_recipient_per_month between 1 and 1000000);
alter table public.recognitions add column client_request_id uuid,
 add column request_payload jsonb,
 add column status text not null default 'active' check(status in ('active','removed')),
 add column giver_name text,add column recipient_name text,add column value_name text;
update public.recognitions r set giver_name=concat_ws(' ',coalesce(nullif(trim(g.preferred_name),''),g.first_name),g.last_name),recipient_name=concat_ws(' ',coalesce(nullif(trim(e.preferred_name),''),e.first_name),e.last_name)
 from public.employees g,public.employees e where g.id=r.giver_employee_id and e.id=r.recipient_employee_id;
update public.recognitions r set value_name=v.name from public.recognition_values v where v.id=r.recognition_value_id;
create unique index recognition_request_key_idx on public.recognitions(giver_employee_id,client_request_id) where client_request_id is not null;
create unique index recognition_value_canonical_name_idx on public.recognition_values(organization_id,lower(trim(name)));
create index recognition_giver_recipient_month_idx on public.recognitions(giver_employee_id,recipient_employee_id,created_at);

create table public.recognition_preferences(employee_id uuid primary key references public.employees(id),organization_id uuid not null references public.organizations(id),allow_public boolean not null default true,updated_at timestamptz not null default now());
create index recognition_preferences_org_idx on public.recognition_preferences(organization_id);
alter table public.recognition_preferences enable row level security;
create table public.recognition_reports(id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id),recognition_id uuid not null references public.recognitions(id),reporter_employee_id uuid not null references public.employees(id),reason text not null,
 status text not null default 'open' check(status in ('open','resolved')),created_at timestamptz not null default now(),resolved_at timestamptz,resolved_by uuid references auth.users(id),resolution text);
create unique index recognition_open_report_idx on public.recognition_reports(recognition_id,reporter_employee_id) where status='open';
create index recognition_reports_org_status_idx on public.recognition_reports(organization_id,status,created_at);
create index recognition_reports_reporter_idx on public.recognition_reports(reporter_employee_id);
alter table public.recognition_reports enable row level security;
create table public.recognition_moderation_events(id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id),recognition_id uuid not null references public.recognitions(id),actor_user_id uuid not null references auth.users(id),action text not null check(action in ('removed','dismissed')),reason text not null,points_reversed integer not null default 0,created_at timestamptz not null default now());
create index recognition_moderation_org_idx on public.recognition_moderation_events(organization_id,created_at);
create index recognition_moderation_record_idx on public.recognition_moderation_events(recognition_id);
alter table public.recognition_moderation_events enable row level security;
revoke all on public.recognition_preferences,public.recognition_reports,public.recognition_moderation_events from public,anon,authenticated;
grant select on public.recognition_preferences,public.recognition_reports,public.recognition_moderation_events,public.organization_recognition_settings,public.recognition_values,public.recognitions to authenticated;

create function recognition_internal.employee(p_org uuid) returns public.employees language sql stable security definer set search_path='' as $$
 select e.* from public.employees e where e.organization_id=p_org and e.user_id=auth.uid() and e.status in ('active','leave') order by e.id limit 1;
$$;
create function recognition_internal.reader(p_org uuid) returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and (recognition_internal.employee(p_org)).id is not null
 and (not private.user_requires_mfa(p_org,auth.uid()) or coalesce(auth.jwt()->>'aal','aal1')='aal2')
 and (private.has_permission(p_org,'recognition.read') or private.has_permission(p_org,'recognition.give') or private.has_permission(p_org,'recognition.moderate'));
$$;
create function recognition_internal.manager(p_org uuid) returns boolean language sql stable security definer set search_path='' as $$ select auth.uid() is not null and (recognition_internal.employee(p_org)).id is not null and (not private.user_requires_mfa(p_org,auth.uid()) or coalesce(auth.jwt()->>'aal','aal1')='aal2') and (private.has_permission(p_org,'recognition.manage') or private.has_permission(p_org,'rewards.manage_catalog')); $$;
create function recognition_internal.moderator(p_org uuid) returns boolean language sql stable security definer set search_path='' as $$ select recognition_internal.reader(p_org) and private.has_permission(p_org,'recognition.moderate'); $$;
create function recognition_internal.can_read(p_org uuid,p_giver uuid,p_recipient uuid,p_visibility text,p_status text) returns boolean language sql stable security definer set search_path='' as $$
 select recognition_internal.reader(p_org) and (recognition_internal.moderator(p_org) or (p_status='active' and (p_visibility='public' or (recognition_internal.employee(p_org)).id in(p_giver,p_recipient)))); $$;
drop policy "read public recognitions" on public.recognitions;
drop policy "read own given or received recognitions" on public.recognitions;
drop policy "admins read all recognitions" on public.recognitions;
create policy "scoped recognition audience" on public.recognitions for select to authenticated using(recognition_internal.can_read(organization_id,giver_employee_id,recipient_employee_id,visibility,status));
create policy "own recognition preferences" on public.recognition_preferences for select to authenticated using(employee_id=(recognition_internal.employee(organization_id)).id and recognition_internal.reader(organization_id));
create policy "own or HR recognition reports" on public.recognition_reports for select to authenticated using(recognition_internal.moderator(organization_id) or (recognition_internal.reader(organization_id) and reporter_employee_id=(recognition_internal.employee(organization_id)).id));
create policy "HR recognition moderation" on public.recognition_moderation_events for select to authenticated using(recognition_internal.moderator(organization_id));
drop policy "manage recognition settings" on public.organization_recognition_settings;
create policy "manage recognition settings" on public.organization_recognition_settings for all to authenticated using(recognition_internal.manager(organization_id)) with check(recognition_internal.manager(organization_id));
drop policy "manage recognition values" on public.recognition_values;
create policy "manage recognition values" on public.recognition_values for all to authenticated using(recognition_internal.manager(organization_id)) with check(recognition_internal.manager(organization_id));

-- Both direct legacy policy writes and new RPC writes receive the same checks/audit.
create function recognition_internal.setup_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare org uuid; begin
 org:=case when tg_op='DELETE' then old.organization_id else new.organization_id end;
 if tg_op='DELETE' and not exists(select 1 from public.organizations where id=org) then return old;end if;
 if auth.uid() is not null and not(tg_op='INSERT' and pg_trigger_depth()>1) then
  if not recognition_internal.manager(org) then raise exception using errcode='42501',message='Recognition policy permission required'; end if;
  perform private.assert_step_up(org);
 end if;
 if tg_op='DELETE' then raise exception 'Archive a value or pause the program; do not delete recognition policy history'; end if;
 if tg_op='UPDATE' and new.organization_id<>old.organization_id then raise exception 'Recognition policy cannot move between organizations'; end if;
 if tg_table_name='recognition_values' then
  new.name:=trim(new.name);new.description:=nullif(trim(new.description),'');
  if length(new.name) not between 1 and 80 or length(coalesce(new.description,''))>1000 then raise exception 'Value name must be 1–80 characters; description at most 1000'; end if;
  if exists(select 1 from public.recognition_values v where v.organization_id=new.organization_id and lower(trim(v.name))=lower(new.name) and v.id<>new.id) then raise exception 'A recognition value with this name already exists'; end if;
 else
  if new.monthly_point_allowance>1000000 or coalesce(new.max_points_per_recognition,1)>1000000 or coalesce(new.max_recognitions_per_day_per_giver,1)>100 then raise exception 'Choose an allowance/cap up to 1,000,000 points and a daily limit up to 100'; end if;
 end if;
 perform private.log_audit_event(org,'RECOGNITION_POLICY_CHANGED',tg_table_name,case when tg_table_name='recognition_values' then (to_jsonb(new)->>'id')::uuid else org end,case when tg_op='UPDATE' then to_jsonb(old) end,to_jsonb(new));
 return new;
end; $$;
create trigger recognition_settings_guard before insert or update or delete on public.organization_recognition_settings for each row execute function recognition_internal.setup_guard();
create trigger recognition_values_guard before insert or update or delete on public.recognition_values for each row execute function recognition_internal.setup_guard();
-- New workspaces receive usable values too; existing customized programs are preserved.
create or replace function private.create_default_recognition_settings() returns trigger language plpgsql security definer set search_path='' as $$ begin
 insert into public.organization_recognition_settings(organization_id) values(new.id) on conflict do nothing;
 insert into public.recognition_values(organization_id,name,description) values(new.id,'Teamwork','Helped others succeed'),(new.id,'Innovation','Found a better way'),(new.id,'Customer Focus','Improved the experience for those we serve'),(new.id,'Above & Beyond','Made a meaningful contribution');return new;end; $$;

create function recognition_internal.record_guard() returns trigger language plpgsql security definer set search_path='' as $$ begin
 if tg_op='DELETE' then raise exception 'Recognition history cannot be deleted; use HR moderation'; end if;
 if tg_op='UPDATE' then
  if (to_jsonb(new)-'status'-'visibility') is distinct from (to_jsonb(old)-'status'-'visibility') then raise exception 'Recognition messages, identity and point awards are immutable'; end if;
  if old.status='removed' and new.status<>old.status then raise exception 'Removed recognition cannot be restored; record a new reviewed recognition'; end if;
  if old.visibility='private' and new.visibility<>'private' then raise exception 'Private recognition cannot be made public'; end if;
 else
  if new.giver_employee_id=new.recipient_employee_id or not exists(select 1 from public.employees e where e.id=new.giver_employee_id and e.organization_id=new.organization_id and e.status in ('active','leave')) or not exists(select 1 from public.employees e where e.id=new.recipient_employee_id and e.organization_id=new.organization_id and e.status in ('active','leave')) then raise exception 'Choose an eligible coworker in the same organization'; end if;
  if new.recognition_value_id is not null and not exists(select 1 from public.recognition_values where id=new.recognition_value_id and organization_id=new.organization_id and is_active) then raise exception 'Choose an active value in this organization'; end if;
 end if; return new;
end; $$;
create trigger recognition_record_integrity before insert or update or delete on public.recognitions for each row execute function recognition_internal.record_guard();
alter table public.employee_points_ledger drop constraint employee_points_ledger_entry_type_check;
alter table public.employee_points_ledger add constraint employee_points_ledger_entry_type_check check(entry_type in ('award','redemption','refund','adjustment','expiry','recognition','recognition_reversal'));
create unique index recognition_credit_once_idx on public.employee_points_ledger(related_recognition_id) where entry_type='recognition';
create unique index recognition_reversal_once_idx on public.employee_points_ledger(related_recognition_id) where entry_type='recognition_reversal';
create function recognition_internal.ledger_guard() returns trigger language plpgsql security definer set search_path='' as $$ declare r public.recognitions; begin
 if tg_op<>'INSERT' then raise exception 'Points history is append-only'; end if;
 if not exists(select 1 from public.employees where id=new.employee_id and organization_id=new.organization_id) then raise exception 'Points employee must belong to the organization'; end if;
 if new.entry_type in ('recognition','recognition_reversal') or new.related_recognition_id is not null then
  select * into r from public.recognitions where id=new.related_recognition_id;
  if r.id is null or r.organization_id<>new.organization_id or r.recipient_employee_id<>new.employee_id or r.points_given=0 or new.entry_type not in ('recognition','recognition_reversal') or
   (new.entry_type='recognition' and new.amount<>r.points_given) or(new.entry_type='recognition_reversal' and (new.amount<>-r.points_given or r.status<>'removed')) then raise exception 'Recognition ledger entry does not match its source'; end if;
 end if;return new;end; $$;
create trigger immutable_points_history before insert or update or delete on public.employee_points_ledger for each row execute function recognition_internal.ledger_guard();
create function recognition_internal.check_ledger() returns trigger language plpgsql security definer set search_path='' as $$
declare r public.recognitions; rid uuid; credits bigint; reversals bigint; cc int; rc int; begin
 if tg_table_name='recognitions' then rid:=new.id;else rid:=new.related_recognition_id;end if;
 if rid is null then return null; end if;
 select * into r from public.recognitions where id=rid;
 select coalesce(sum(amount) filter(where entry_type='recognition'),0),coalesce(sum(amount) filter(where entry_type='recognition_reversal'),0),count(*) filter(where entry_type='recognition'),count(*) filter(where entry_type='recognition_reversal') into credits,reversals,cc,rc from public.employee_points_ledger where related_recognition_id=rid;
 if credits<>r.points_given or cc<>(case when r.points_given>0 then 1 else 0 end) or reversals<>(case when r.status='removed' then -r.points_given else 0 end) or rc<>(case when r.status='removed' and r.points_given>0 then 1 else 0 end) then raise exception 'Recognition and Rewards ledger must reconcile exactly'; end if;
 return null;end; $$;
create constraint trigger recognition_ledger_balanced after insert or update on public.recognitions deferrable initially deferred for each row execute function recognition_internal.check_ledger();
create constraint trigger recognition_ledger_source_balanced after insert on public.employee_points_ledger deferrable initially deferred for each row execute function recognition_internal.check_ledger();

create function recognition_internal.send_recognition(p_recipient_employee_id uuid,p_message text,p_recognition_value_id uuid default null,p_points integer default 0,p_visibility text default null,p_client_request_id uuid default null,p_organization_id uuid default null)
returns public.recognitions language plpgsql security definer set search_path='' as $$
declare e public.employees;t public.employees;s public.organization_recognition_settings;r public.recognitions;payload jsonb;vis text;zone text;month_from timestamptz;month_to timestamptz;day_from timestamptz;day_to timestamptz;used bigint;daily int;u uuid;vname text;
begin
 select * into t from public.employees where id=p_recipient_employee_id;
 if t.id is null then raise exception 'Choose an eligible coworker'; end if;
 e:=recognition_internal.employee(coalesce(p_organization_id,t.organization_id));
 if e.id is null or not recognition_internal.reader(e.organization_id) or not private.has_permission(e.organization_id,'recognition.give') then raise exception using errcode='42501',message='Not authorized to give recognition'; end if;
 if t.organization_id<>e.organization_id or t.status not in ('active','leave') or t.id=e.id then raise exception 'Choose another eligible coworker in this organization'; end if;
 if nullif(trim(p_message),'') is null or length(trim(p_message))>500 or p_points is null or p_points<0 then raise exception 'Give a message (1–500 characters) and a nonnegative whole number of points'; end if;
 payload:=jsonb_build_object('recipient',t.id,'message',trim(p_message),'value',p_recognition_value_id,'points',p_points,'visibility',p_visibility);
 -- Serialize every post, including kudos-only posts, before all counters and retries.
 perform pg_advisory_xact_lock(hashtextextended(e.id::text,92));
 if p_client_request_id is not null then
  select * into r from public.recognitions where giver_employee_id=e.id and client_request_id=p_client_request_id;
  if r.id is not null then if r.request_payload<>payload then raise exception 'Retry key already used for a different recognition'; end if;return r;end if;
 end if;
 select * into s from public.organization_recognition_settings where organization_id=e.organization_id for share;
 if s.organization_id is null or not s.enabled then raise exception 'Recognition is paused or not configured; contact HR'; end if;
 if p_recognition_value_id is not null then select name into vname from public.recognition_values where id=p_recognition_value_id and organization_id=e.organization_id and is_active; if not found then raise exception 'Choose an active value from this organization'; end if;
 elsif s.require_value then raise exception 'Choose a recognition value under your organization policy'; end if;
 perform pg_advisory_xact_lock(hashtextextended(t.id::text,93));
 vis:=coalesce(p_visibility,s.default_visibility);if vis not in ('public','private') then raise exception 'Invalid recognition visibility'; end if;
 if exists(select 1 from public.recognition_preferences where employee_id=t.id and not allow_public) then vis:='private'; end if;
 select timezone into zone from public.organizations where id=e.organization_id;
 month_from:=date_trunc('month',now() at time zone zone) at time zone zone;
 month_to:=(date_trunc('month',now() at time zone zone)+interval '1 month') at time zone zone;
 day_from:=private.org_today(e.organization_id)::timestamp at time zone zone;day_to:=(private.org_today(e.organization_id)+1)::timestamp at time zone zone;
 select count(*) into daily from public.recognitions where giver_employee_id=e.id and created_at>=day_from and created_at<day_to;
 if daily>=least(coalesce(s.max_recognitions_per_day_per_giver,100),100) then raise exception 'Your daily recognition limit has been reached'; end if;
 if p_points>0 then
  perform private.assert_step_up(e.organization_id);
  if not public.organization_has_feature(e.organization_id,'rewards_marketplace') then raise exception 'Rewards must be enabled to attach points; you can send kudos without points'; end if;
  if s.monthly_point_allowance=0 or p_points>coalesce(s.max_points_per_recognition,s.monthly_point_allowance) then raise exception 'Points exceed the current recognition policy'; end if;
  select coalesce(sum(points_given),0) into used from public.recognitions where giver_employee_id=e.id and created_at>=month_from and created_at<month_to;
  if used+p_points>s.monthly_point_allowance then raise exception 'This exceeds your remaining monthly giving allowance'; end if;
  if s.max_points_per_recipient_per_month is not null then select coalesce(sum(points_given),0) into used from public.recognitions where giver_employee_id=e.id and recipient_employee_id=t.id and created_at>=month_from and created_at<month_to; if used+p_points>s.max_points_per_recipient_per_month then raise exception 'This exceeds the monthly points you can give to this coworker'; end if;end if;
  perform pg_advisory_xact_lock(hashtextextended(t.id::text,91));
 end if;
 insert into public.recognitions(organization_id,giver_employee_id,recipient_employee_id,recognition_value_id,message,points_given,visibility,client_request_id,request_payload,giver_name,recipient_name,value_name)
 values(e.organization_id,e.id,t.id,p_recognition_value_id,trim(p_message),p_points,vis,p_client_request_id,payload,concat_ws(' ',coalesce(nullif(trim(e.preferred_name),''),e.first_name),e.last_name),concat_ws(' ',coalesce(nullif(trim(t.preferred_name),''),t.first_name),t.last_name),vname) returning * into r;
 if p_points>0 then insert into public.employee_points_ledger(organization_id,employee_id,entry_type,amount,reason,related_recognition_id,created_by) values(e.organization_id,t.id,'recognition',p_points,'Peer recognition — '||r.id,r.id,auth.uid());end if;
 if t.user_id is not null then perform private.create_notification(e.organization_id,t.user_id,t.id,'recognition.received','You received recognition','Open Recognition to view the message and its audience.','/recognition?item='||r.id,jsonb_build_object('recognition_id',r.id));end if;
 perform private.log_audit_event(e.organization_id,'RECOGNITION_GIVEN','recognition',r.id,null,jsonb_build_object('recipient',t.id,'points',p_points,'visibility',vis));return r;
end; $$;

create function recognition_internal.get_recognition_state(p_organization_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare e public.employees;s public.organization_recognition_settings;zone text;m timestamptz;mt timestamptz;d timestamptz;dt timestamptz;used bigint;n int;balance bigint;
begin
 if not recognition_internal.reader(p_organization_id) and not recognition_internal.manager(p_organization_id) then raise exception 'Recognition access required'; end if;
 e:=recognition_internal.employee(p_organization_id);select * into s from public.organization_recognition_settings where organization_id=p_organization_id;select timezone into zone from public.organizations where id=p_organization_id;
 m:=date_trunc('month',now() at time zone zone) at time zone zone;mt:=(date_trunc('month',now() at time zone zone)+interval '1 month') at time zone zone;d:=private.org_today(p_organization_id)::timestamp at time zone zone;dt:=(private.org_today(p_organization_id)+1)::timestamp at time zone zone;
 select coalesce(sum(points_given),0) into used from public.recognitions where giver_employee_id=e.id and created_at>=m and created_at<mt;
 select count(*) into n from public.recognitions where giver_employee_id=e.id and created_at>=d and created_at<dt;
 if private.has_permission(p_organization_id,'rewards.read_self') then select coalesce(sum(amount),0) into balance from public.employee_points_ledger where employee_id=e.id and organization_id=p_organization_id;end if;
 return jsonb_build_object('settings',to_jsonb(s),'employee_id',e.id,'timezone',zone,'month_start',m,'resets_at',mt,'day_resets_at',dt,'given_points',used,'remaining_points',greatest(s.monthly_point_allowance-used,0),'given_today',n,'daily_remaining',greatest(least(coalesce(s.max_recognitions_per_day_per_giver,100),100)-n,0),'allow_public',coalesce((select allow_public from public.recognition_preferences where employee_id=e.id),true),'points_balance',balance,'rewards_enabled',public.organization_has_feature(p_organization_id,'rewards_marketplace'),'can_give',private.has_permission(p_organization_id,'recognition.give') and e.id is not null,'can_manage',recognition_internal.manager(p_organization_id),'can_moderate',recognition_internal.moderator(p_organization_id));
end; $$;
create function recognition_internal.search_recognition_coworkers(p_organization_id uuid,p_search text default '') returns jsonb language plpgsql stable security definer set search_path='' as $$
declare e public.employees;begin
 if not recognition_internal.reader(p_organization_id) or not private.has_permission(p_organization_id,'recognition.give') then raise exception 'Recognition giving permission required'; end if;e:=recognition_internal.employee(p_organization_id);
 return(select coalesce(jsonb_agg(to_jsonb(c)),'[]') from(select x.id,concat_ws(' ',coalesce(nullif(trim(x.preferred_name),''),x.first_name),x.last_name) as label,x.employee_number,coalesce(p.allow_public,true) allow_public from public.employees x left join public.recognition_preferences p on p.employee_id=x.id where x.organization_id=p_organization_id and x.status in ('active','leave') and x.id<>e.id and(coalesce(p_search,'')='' or position(lower(left(p_search,100)) in lower(concat_ws(' ',x.preferred_name,x.first_name,x.last_name,x.employee_number)))>0) order by x.first_name,x.last_name,x.id limit 100)c);
end; $$;
create function recognition_internal.list_recognition_feed(p_organization_id uuid,p_scope text default 'all',p_page integer default 1,p_value_id uuid default null,p_from date default null,p_to date default null) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare e public.employees;zone text;v jsonb;begin
 if not recognition_internal.reader(p_organization_id) then raise exception 'Recognition access required'; end if;
 if p_scope is null or p_page is null or p_scope not in ('all','received','given','public','moderation') or p_page not between 1 and 100000 or(p_from is not null and p_to is not null and p_to<p_from) then raise exception 'Invalid recognition filters'; end if;
 if p_scope='moderation' and not recognition_internal.moderator(p_organization_id) then raise exception 'Moderation permission required'; end if;
 e:=recognition_internal.employee(p_organization_id);select timezone into zone from public.organizations where id=p_organization_id;
 with visible as(select r.* from public.recognitions r where r.organization_id=p_organization_id and recognition_internal.can_read(r.organization_id,r.giver_employee_id,r.recipient_employee_id,r.visibility,r.status)
 and(p_scope='moderation' or r.visibility='public' or e.id in(r.giver_employee_id,r.recipient_employee_id)) and (r.status='active' or p_scope='moderation') and(p_scope not in ('received','given','public') or(p_scope='received' and r.recipient_employee_id=e.id) or(p_scope='given' and r.giver_employee_id=e.id) or(p_scope='public' and r.visibility='public'))
 and(p_value_id is null or r.recognition_value_id=p_value_id) and(p_from is null or r.created_at>=p_from::timestamp at time zone zone) and(p_to is null or r.created_at<(p_to+1)::timestamp at time zone zone))
 select jsonb_build_object('total',(select count(*) from visible),'page',p_page,'items',(select coalesce(jsonb_agg(to_jsonb(x) order by created_at desc,id desc),'[]') from(select id,message,points_given,visibility,status,created_at,giver_name,recipient_name,value_name,giver_employee_id,recipient_employee_id,recognition_value_id,(recipient_employee_id=e.id and visibility='public' and status='active') can_make_private from visible order by created_at desc,id desc limit 20 offset(p_page-1)*20)x)) into v;return v;
end; $$;
create function recognition_internal.set_recognition_preference(p_organization_id uuid,p_allow_public boolean) returns void language plpgsql security definer set search_path='' as $$
declare e public.employees;begin
 if not recognition_internal.reader(p_organization_id) or p_allow_public is null then raise exception 'Recognition access required';end if;e:=recognition_internal.employee(p_organization_id);
 perform pg_advisory_xact_lock(hashtextextended(e.id::text,93));
 insert into public.recognition_preferences(employee_id,organization_id,allow_public) values(e.id,p_organization_id,p_allow_public) on conflict(employee_id) do update set allow_public=excluded.allow_public,updated_at=now();
 if not p_allow_public then update public.recognitions set visibility='private' where recipient_employee_id=e.id and organization_id=e.organization_id and visibility='public';end if;
 perform private.log_audit_event(e.organization_id,'RECOGNITION_PREFERENCE_CHANGED','employee',e.id,null,jsonb_build_object('allow_public',p_allow_public));
end; $$;
create function recognition_internal.make_recognition_private(p_recognition_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare r public.recognitions;begin select * into r from public.recognitions where id=p_recognition_id for update;
 if r.id is null or not recognition_internal.reader(r.organization_id) or r.recipient_employee_id<>(recognition_internal.employee(r.organization_id)).id then raise exception 'Only the recipient can change the audience';end if;
 update public.recognitions set visibility='private' where id=r.id;
 perform private.log_audit_event(r.organization_id,'RECOGNITION_MADE_PRIVATE','recognition',r.id,null,jsonb_build_object('visibility','private'));
end; $$;
create function recognition_internal.report_recognition(p_recognition_id uuid,p_reason text) returns uuid language plpgsql security definer set search_path='' as $$
declare r public.recognitions;e public.employees;rid uuid;u uuid;begin
 select * into r from public.recognitions where id=p_recognition_id;
 if r.id is null or not recognition_internal.can_read(r.organization_id,r.giver_employee_id,r.recipient_employee_id,r.visibility,r.status) or r.status<>'active' then raise exception 'Recognition unavailable';end if;
 if length(trim(coalesce(p_reason,''))) not between 10 and 2000 then raise exception 'Explain the concern (10–2000 characters)';end if;e:=recognition_internal.employee(r.organization_id);
 perform pg_advisory_xact_lock(hashtextextended(r.id::text||e.id::text,94));
 select id into rid from public.recognition_reports where recognition_id=r.id and reporter_employee_id=e.id and status='open';if rid is not null then return rid;end if;
 insert into public.recognition_reports(organization_id,recognition_id,reporter_employee_id,reason) values(r.organization_id,r.id,e.id,trim(p_reason)) returning id into rid;
 for u in select user_id from public.employees where organization_id=r.organization_id and user_id is not null and private.user_has_permission(r.organization_id,user_id,'recognition.moderate') loop perform private.create_notification(r.organization_id,u,e.id,'recognition.reported','A recognition needs review',null,'/admin/recognition');end loop;
 perform private.log_audit_event(r.organization_id,'RECOGNITION_REPORTED','recognition_report',rid,null,jsonb_build_object('recognition_id',r.id));return rid;
end; $$;
create function recognition_internal.moderate_recognition(p_recognition_id uuid,p_action text,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare r public.recognitions;u uuid;rep record;begin
 select * into r from public.recognitions where id=p_recognition_id for update;
 if r.id is null or not recognition_internal.moderator(r.organization_id) then raise exception 'Recognition moderation permission required';end if;
 perform private.assert_step_up(r.organization_id);
 if p_action is null or p_action not in ('remove','dismiss') or length(trim(coalesce(p_reason,''))) not between 10 and 2000 then raise exception 'Choose an action and explain it (10–2000 characters)';end if;
 if r.status='removed' then if p_action='remove' then return;else raise exception 'This recognition was already removed';end if;end if;
 if p_action='remove' then
  perform pg_advisory_xact_lock(hashtextextended(r.recipient_employee_id::text,91));
  update public.recognitions set status='removed' where id=r.id;
  if r.points_given>0 then insert into public.employee_points_ledger(organization_id,employee_id,entry_type,amount,reason,related_recognition_id,created_by) values(r.organization_id,r.recipient_employee_id,'recognition_reversal',-r.points_given,'HR removed recognition — '||r.id,r.id,auth.uid());end if;
  for u in select user_id from public.employees where id in(r.giver_employee_id,r.recipient_employee_id) and user_id is not null loop perform private.create_notification(r.organization_id,u,r.recipient_employee_id,'recognition.removed','HR removed a recognition','Associated points were reversed where applicable. Contact HR with questions.','/recognition');end loop;
 end if;
 insert into public.recognition_moderation_events(organization_id,recognition_id,actor_user_id,action,reason,points_reversed) values(r.organization_id,r.id,auth.uid(),case when p_action='remove' then 'removed' else 'dismissed' end,trim(p_reason),case when p_action='remove' then r.points_given else 0 end);
 for rep in update public.recognition_reports set status='resolved',resolution=trim(p_reason),resolved_at=now(),resolved_by=auth.uid() where recognition_id=r.id and status='open' returning reporter_employee_id loop
  select user_id into u from public.employees where id=rep.reporter_employee_id;
  if u is not null then perform private.create_notification(r.organization_id,u,rep.reporter_employee_id,'recognition.report_resolved','HR reviewed your recognition report',null,'/recognition');end if;
 end loop;
 perform private.log_audit_event(r.organization_id,'RECOGNITION_MODERATED','recognition',r.id,null,jsonb_build_object('action',p_action,'points_reversed',case when p_action='remove' then r.points_given else 0 end));
end; $$;
create function recognition_internal.save_recognition_settings(p_organization_id uuid,p_settings jsonb) returns public.organization_recognition_settings language plpgsql security definer set search_path='' as $$
declare s public.organization_recognition_settings;begin
 if not recognition_internal.manager(p_organization_id) then raise exception 'Recognition policy permission required';end if;perform private.assert_step_up(p_organization_id);
 update public.organization_recognition_settings set monthly_point_allowance=(p_settings->>'monthly_point_allowance')::int,max_points_per_recognition=(p_settings->>'max_points_per_recognition')::int,max_recognitions_per_day_per_giver=(p_settings->>'max_recognitions_per_day_per_giver')::int,default_visibility=p_settings->>'default_visibility',enabled=(p_settings->>'enabled')::boolean,require_value=(p_settings->>'require_value')::boolean,max_points_per_recipient_per_month=(p_settings->>'max_points_per_recipient_per_month')::int where organization_id=p_organization_id returning * into s;
 if s.organization_id is null then raise exception 'Recognition policy is unavailable';end if;return s;
end; $$;
create function recognition_internal.save_recognition_value(p_organization_id uuid,p_name text,p_description text default null,p_value_id uuid default null,p_active boolean default true) returns uuid language plpgsql security definer set search_path='' as $$ declare vid uuid;begin
 if not recognition_internal.manager(p_organization_id) then raise exception 'Recognition policy permission required';end if;perform private.assert_step_up(p_organization_id);
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text,95));
 if p_value_id is null then insert into public.recognition_values(organization_id,name,description,is_active) values(p_organization_id,p_name,p_description,p_active) returning id into vid;
 else update public.recognition_values set name=p_name,description=p_description,is_active=p_active where id=p_value_id and organization_id=p_organization_id returning id into vid;end if;
 if vid is null then raise exception 'Value not found in this organization';end if;return vid;
end; $$;
create function recognition_internal.recognition_health(p_organization_id uuid,p_from date,p_to date) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare zone text;v jsonb;begin
 if not recognition_internal.moderator(p_organization_id) then raise exception 'Recognition moderation permission required';end if;
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>366 then raise exception 'Choose a reporting period of at most one year';end if;
 select timezone into zone from public.organizations where id=p_organization_id;
 with rows as(select * from public.recognitions where organization_id=p_organization_id and created_at>=p_from::timestamp at time zone zone and created_at<(p_to+1)::timestamp at time zone zone),active as(select * from rows where status='active')
 select jsonb_build_object('active_employees',(select count(*) from public.employees where organization_id=p_organization_id and status in('active','leave')),'recognitions',(select count(*) from active),'givers',(select count(distinct giver_employee_id) from active),'recipients',(select count(distinct recipient_employee_id) from active),'points',(select coalesce(sum(points_given),0) from active),'private_count',(select count(*) from active where visibility='private'),'removed',(select count(*) from rows where status='removed'),'points_reversed',(select coalesce(sum(points_given),0) from rows where status='removed'),'open_reports',(select count(*) from public.recognition_reports where organization_id=p_organization_id and status='open'),'values',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from(select coalesce(value_name,'No value selected') as name,count(*) as recognitions from active group by value_name order by count(*) desc,value_name)x)) into v;return v;
end; $$;
-- Protect historical moderation decisions too.
create function recognition_internal.no_history_mutation() returns trigger language plpgsql set search_path='' as $$ begin raise exception 'Moderation history is append-only';end; $$;
create trigger immutable_recognition_moderation before update or delete on public.recognition_moderation_events for each row execute function recognition_internal.no_history_mutation();
-- The legacy endpoint remains available; new clients use a retry key.
alter function public.give_recognition(uuid,text,uuid,integer,text) set schema recognition_internal;
create or replace function recognition_internal.give_recognition(p_recipient_employee_id uuid,p_message text,p_recognition_value_id uuid default null,p_points integer default 0,p_visibility text default null) returns public.recognitions language sql security definer set search_path='' as $$ select * from recognition_internal.send_recognition(p_recipient_employee_id,p_message,p_recognition_value_id,p_points,p_visibility); $$;
-- Rewards redemptions obey the same feature and employee eligibility rules as the UI.
alter function public.redeem_reward(uuid) set schema recognition_internal;
alter function recognition_internal.redeem_reward(uuid) rename to redeem_reward_legacy;
create function recognition_internal.redeem_reward(p_product_id uuid) returns public.reward_redemptions language plpgsql security definer set search_path='' as $$ declare org uuid;e public.employees;begin
 select organization_id into org from public.reward_products where id=p_product_id;e:=recognition_internal.employee(org);
 if org is null or e.id is null or not public.organization_has_feature(org,'rewards_marketplace') or not private.has_permission(org,'rewards.redeem_self') or e.id is distinct from private.current_employee_id() then raise exception 'Reward redemption is unavailable for this employee or program';end if;
 perform private.assert_step_up(org);
 return recognition_internal.redeem_reward_legacy(p_product_id);
end; $$;

create function public.give_recognition(p_recipient_employee_id uuid,p_message text,p_recognition_value_id uuid default null,p_points integer default 0,p_visibility text default null) returns public.recognitions language sql security invoker set search_path='' as $$ select * from recognition_internal.give_recognition(p_recipient_employee_id,p_message,p_recognition_value_id,p_points,p_visibility); $$;
revoke all on function public.give_recognition(uuid,text,uuid,integer,text) from public,anon;
grant execute on function public.give_recognition(uuid,text,uuid,integer,text) to authenticated;

create function public.send_recognition(p_recipient_employee_id uuid,p_message text,p_recognition_value_id uuid default null,p_points integer default 0,p_visibility text default null,p_client_request_id uuid default null,p_organization_id uuid default null) returns public.recognitions language sql security invoker set search_path='' as $$ select * from recognition_internal.send_recognition(p_recipient_employee_id,p_message,p_recognition_value_id,p_points,p_visibility,p_client_request_id,p_organization_id); $$;
revoke all on function public.send_recognition(uuid,text,uuid,integer,text,uuid,uuid) from public,anon;
grant execute on function public.send_recognition(uuid,text,uuid,integer,text,uuid,uuid) to authenticated;

create function public.get_recognition_state(p_organization_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select recognition_internal.get_recognition_state(p_organization_id); $$;
revoke all on function public.get_recognition_state(uuid) from public,anon;
grant execute on function public.get_recognition_state(uuid) to authenticated;

create function public.search_recognition_coworkers(p_organization_id uuid,p_search text default '') returns jsonb language sql security invoker set search_path='' as $$ select recognition_internal.search_recognition_coworkers(p_organization_id,p_search); $$;
revoke all on function public.search_recognition_coworkers(uuid,text) from public,anon;
grant execute on function public.search_recognition_coworkers(uuid,text) to authenticated;

create function public.list_recognition_feed(p_organization_id uuid,p_scope text default 'all',p_page integer default 1,p_value_id uuid default null,p_from date default null,p_to date default null) returns jsonb language sql security invoker set search_path='' as $$ select recognition_internal.list_recognition_feed(p_organization_id,p_scope,p_page,p_value_id,p_from,p_to); $$;
revoke all on function public.list_recognition_feed(uuid,text,integer,uuid,date,date) from public,anon;
grant execute on function public.list_recognition_feed(uuid,text,integer,uuid,date,date) to authenticated;

create function public.set_recognition_preference(p_organization_id uuid,p_allow_public boolean) returns void language sql security invoker set search_path='' as $$ select recognition_internal.set_recognition_preference(p_organization_id,p_allow_public); $$;
revoke all on function public.set_recognition_preference(uuid,boolean) from public,anon;
grant execute on function public.set_recognition_preference(uuid,boolean) to authenticated;

create function public.make_recognition_private(p_recognition_id uuid) returns void language sql security invoker set search_path='' as $$ select recognition_internal.make_recognition_private(p_recognition_id); $$;
revoke all on function public.make_recognition_private(uuid) from public,anon;
grant execute on function public.make_recognition_private(uuid) to authenticated;

create function public.report_recognition(p_recognition_id uuid,p_reason text) returns uuid language sql security invoker set search_path='' as $$ select recognition_internal.report_recognition(p_recognition_id,p_reason); $$;
revoke all on function public.report_recognition(uuid,text) from public,anon;
grant execute on function public.report_recognition(uuid,text) to authenticated;

create function public.moderate_recognition(p_recognition_id uuid,p_action text,p_reason text) returns void language sql security invoker set search_path='' as $$ select recognition_internal.moderate_recognition(p_recognition_id,p_action,p_reason); $$;
revoke all on function public.moderate_recognition(uuid,text,text) from public,anon;
grant execute on function public.moderate_recognition(uuid,text,text) to authenticated;

create function public.save_recognition_settings(p_organization_id uuid,p_settings jsonb) returns public.organization_recognition_settings language sql security invoker set search_path='' as $$ select * from recognition_internal.save_recognition_settings(p_organization_id,p_settings); $$;
revoke all on function public.save_recognition_settings(uuid,jsonb) from public,anon;
grant execute on function public.save_recognition_settings(uuid,jsonb) to authenticated;

create function public.save_recognition_value(p_organization_id uuid,p_name text,p_description text default null,p_value_id uuid default null,p_active boolean default true) returns uuid language sql security invoker set search_path='' as $$ select recognition_internal.save_recognition_value(p_organization_id,p_name,p_description,p_value_id,p_active); $$;
revoke all on function public.save_recognition_value(uuid,text,text,uuid,boolean) from public,anon;
grant execute on function public.save_recognition_value(uuid,text,text,uuid,boolean) to authenticated;

create function public.recognition_health(p_organization_id uuid,p_from date,p_to date) returns jsonb language sql security invoker set search_path='' as $$ select recognition_internal.recognition_health(p_organization_id,p_from,p_to); $$;
revoke all on function public.recognition_health(uuid,date,date) from public,anon;
grant execute on function public.recognition_health(uuid,date,date) to authenticated;

create function public.redeem_reward(p_product_id uuid) returns public.reward_redemptions language sql security invoker set search_path='' as $$ select * from recognition_internal.redeem_reward(p_product_id); $$;
revoke all on function public.redeem_reward(uuid) from public,anon;
grant execute on function public.redeem_reward(uuid) to authenticated;

revoke all on all functions in schema recognition_internal from public,anon,authenticated;
grant execute on function recognition_internal.give_recognition(uuid,text,uuid,integer,text) to authenticated;
grant execute on function recognition_internal.send_recognition(uuid,text,uuid,integer,text,uuid,uuid) to authenticated;
grant execute on function recognition_internal.get_recognition_state(uuid) to authenticated;
grant execute on function recognition_internal.search_recognition_coworkers(uuid,text) to authenticated;
grant execute on function recognition_internal.list_recognition_feed(uuid,text,integer,uuid,date,date) to authenticated;
grant execute on function recognition_internal.set_recognition_preference(uuid,boolean) to authenticated;
grant execute on function recognition_internal.make_recognition_private(uuid) to authenticated;
grant execute on function recognition_internal.report_recognition(uuid,text) to authenticated;
grant execute on function recognition_internal.moderate_recognition(uuid,text,text) to authenticated;
grant execute on function recognition_internal.save_recognition_settings(uuid,jsonb) to authenticated;
grant execute on function recognition_internal.save_recognition_value(uuid,text,text,uuid,boolean) to authenticated;
grant execute on function recognition_internal.recognition_health(uuid,date,date) to authenticated;
grant execute on function recognition_internal.redeem_reward(uuid) to authenticated;
grant execute on function recognition_internal.can_read(uuid,uuid,uuid,text,text),recognition_internal.employee(uuid),recognition_internal.reader(uuid),recognition_internal.manager(uuid),recognition_internal.moderator(uuid) to authenticated;

create function recognition_internal.get_recognition(p_recognition_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$ declare r public.recognitions;e public.employees;begin
 select * into r from public.recognitions where id=p_recognition_id;
 if r.id is null or not recognition_internal.reader(r.organization_id) then raise exception using errcode='42501',message='Recognition unavailable';end if;e:=recognition_internal.employee(r.organization_id);
 if not recognition_internal.can_read(r.organization_id,r.giver_employee_id,r.recipient_employee_id,r.visibility,r.status) and not(r.status='removed' and e.id in(r.giver_employee_id,r.recipient_employee_id)) then raise exception using errcode='42501',message='Recognition unavailable';end if;
 return jsonb_build_object('id',r.id,'message',case when r.status='active' or recognition_internal.moderator(r.organization_id) then r.message end,'status',r.status,'visibility',r.visibility,'giver_name',r.giver_name,'recipient_name',r.recipient_name,'created_at',r.created_at,'value_name',r.value_name,'points_given',r.points_given,'can_make_private',r.status='active' and r.visibility='public' and r.recipient_employee_id=e.id);
end; $$;
create function recognition_internal.list_recognition_reports(p_organization_id uuid,p_status text default 'open',p_page integer default 1,p_self boolean default false) returns jsonb language plpgsql stable security definer set search_path='' as $$ declare e public.employees;v jsonb;begin
 if not recognition_internal.reader(p_organization_id) or (not p_self and not recognition_internal.moderator(p_organization_id)) then raise exception 'Recognition report access required';end if;
 if p_self is null or p_status is null or p_page is null or p_status not in ('open','resolved','all') or p_page not between 1 and 100000 then raise exception 'Invalid report filters';end if;e:=recognition_internal.employee(p_organization_id);
 with filtered as(select q.*,concat_ws(' ',coalesce(nullif(trim(x.preferred_name),''),x.first_name),x.last_name) reporter_name,r.points_given from public.recognition_reports q join public.employees x on x.id=q.reporter_employee_id join public.recognitions r on r.id=q.recognition_id where q.organization_id=p_organization_id and(not p_self or q.reporter_employee_id=e.id) and(p_status='all' or q.status=p_status))
 select jsonb_build_object('total',(select count(*) from filtered),'items',(select coalesce(jsonb_agg(to_jsonb(a) order by created_at,id),'[]') from(select id,recognition_id,reason,status,created_at,resolution,reporter_name,points_given from filtered order by created_at,id limit 20 offset(p_page-1)*20)a)) into v;return v;
end; $$;
create function public.get_recognition(p_recognition_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select recognition_internal.get_recognition(p_recognition_id); $$;
create function public.list_recognition_reports(p_organization_id uuid,p_status text default 'open',p_page integer default 1,p_self boolean default false) returns jsonb language sql security invoker set search_path='' as $$ select recognition_internal.list_recognition_reports(p_organization_id,p_status,p_page,p_self); $$;
revoke all on function public.get_recognition(uuid),recognition_internal.get_recognition(uuid),public.list_recognition_reports(uuid,text,int,boolean),recognition_internal.list_recognition_reports(uuid,text,int,boolean) from public,anon;
grant execute on function public.get_recognition(uuid),recognition_internal.get_recognition(uuid),public.list_recognition_reports(uuid,text,int,boolean),recognition_internal.list_recognition_reports(uuid,text,int,boolean) to authenticated;

-- Preserve employment eligibility on partial directory imports. The previous
-- update path defaulted missing status to prehire, disabling active staff.
alter function public.commit_employee_import_batch(uuid) set schema recognition_internal;
create or replace function recognition_internal.commit_employee_import_batch(p_batch_id uuid)
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
          status = coalesce(nullif(lower(btrim(v_data->>'status')),''),v_employee.status),
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


create function public.commit_employee_import_batch(p_batch_id uuid) returns public.employee_import_batches language sql security invoker set search_path='' as $$ select * from recognition_internal.commit_employee_import_batch(p_batch_id); $$;
revoke all on function public.commit_employee_import_batch(uuid),recognition_internal.commit_employee_import_batch(uuid) from public,anon;
grant execute on function public.commit_employee_import_batch(uuid),recognition_internal.commit_employee_import_batch(uuid) to authenticated;
