set check_function_bodies=false;
-- Onboarding: scoped HR actions, meaningful completion evidence and preserved records.
create schema onboarding_internal;
revoke all on schema onboarding_internal from public,anon;
grant usage on schema onboarding_internal to authenticated;
create function onboarding_internal.member(p_org uuid) returns boolean language sql stable security definer set search_path='' as $$ select auth.uid() is not null and private.network_policy_ok(p_org) and exists(select 1 from public.employees where organization_id=p_org and user_id=auth.uid() and status in ('prehire','active','leave')) and (not private.user_requires_mfa(p_org,auth.uid()) or coalesce(auth.jwt()->>'aal','aal1')='aal2'); $$;
create function onboarding_internal.manager(p_org uuid,p_employee uuid) returns boolean language sql stable security definer set search_path='' as $$ select onboarding_internal.member(p_org) and (private.has_permission(p_org,'employee.manage') or (private.has_permission(p_org,'onboarding.manage_team') and private.in_management_scope(p_employee))); $$;
create function onboarding_internal.reader(p_org uuid,p_employee uuid) returns boolean language sql stable security definer set search_path='' as $$ select onboarding_internal.member(p_org) and (onboarding_internal.manager(p_org,p_employee) or exists(select 1 from public.employees where id=p_employee and user_id=auth.uid()) or (private.has_permission(p_org,'onboarding.read_team') and private.in_management_scope(p_employee))); $$;
create function onboarding_internal.template_manager(p_org uuid) returns boolean language sql stable security definer set search_path='' as $$ select onboarding_internal.member(p_org) and private.has_permission(p_org,'onboarding.manage_templates'); $$;
create or replace function private.require_template_manager(p_template_id uuid) returns public.onboarding_templates language plpgsql security definer set search_path='' as $$ declare t public.onboarding_templates;begin select * into t from public.onboarding_templates where id=p_template_id;if not coalesce(onboarding_internal.template_manager(t.organization_id),false) then raise exception using errcode='42501',message='Onboarding template permission required';end if;perform private.assert_step_up(t.organization_id);return t;end; $$;
create function onboarding_internal.task_reader(p_task uuid) returns boolean language sql stable security definer set search_path='' as $$ select exists(select 1 from public.onboarding_tasks t where t.id=p_task and onboarding_internal.member(t.organization_id) and (onboarding_internal.reader(t.organization_id,t.employee_id) or t.assigned_to_user_id=auth.uid())); $$;
create function onboarding_internal.response_reader(p_task uuid) returns boolean language sql stable security definer set search_path='' as $$ select exists(select 1 from public.onboarding_tasks t join public.employees e on e.id=t.employee_id where t.id=p_task and onboarding_internal.member(t.organization_id) and (e.user_id=auth.uid() or t.assigned_to_user_id=auth.uid() or private.has_permission(t.organization_id,'employee.manage'))); $$;

alter table public.onboarding_runs add column template_name text,add column template_version_number integer,add column employee_name text;
update public.onboarding_runs r set template_name=t.name,template_version_number=v.version_number,employee_name=concat_ws(' ',coalesce(nullif(trim(e.preferred_name),''),e.first_name),e.last_name) from public.onboarding_template_versions v join public.onboarding_templates t on t.id=v.template_id,public.employees e where v.id=r.template_version_id and e.id=r.employee_id;
alter table public.onboarding_template_steps add column review_document_id uuid references public.documents(id);
alter table public.onboarding_tasks add column form_schema jsonb,add column review_document_version_id uuid references public.document_versions(id),add column review_document_title text,add column due_date_locked boolean not null default false;
update public.onboarding_tasks t set form_schema=s.form_schema from public.onboarding_template_steps s where s.id=t.template_step_id;
create table public.onboarding_task_responses(task_id uuid primary key references public.onboarding_tasks(id),organization_id uuid not null references public.organizations(id),data jsonb not null,recorded_by uuid references auth.users(id),recorded_at timestamptz not null default now());
alter table public.onboarding_task_responses enable row level security;
insert into public.onboarding_task_responses(task_id,organization_id,data,recorded_by,recorded_at) select id,organization_id,completion_data,completed_by,coalesce(completed_at,now()) from public.onboarding_tasks where completion_data is not null;
update public.onboarding_tasks set completion_data=jsonb_build_object('recorded',true) where completion_data is not null;
create policy "private onboarding responses" on public.onboarding_task_responses for select to authenticated using(onboarding_internal.response_reader(task_id));
revoke all on public.onboarding_task_responses from public,anon,authenticated;
grant select on public.onboarding_task_responses to authenticated;
alter table public.onboarding_task_documents add column document_version_id uuid references public.document_versions(id),add column document_title text;
update public.onboarding_task_documents e set document_version_id=d.current_version_id,document_title=d.title from public.documents d where d.id=e.document_id;
create table public.onboarding_task_files(id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id),task_id uuid not null references public.onboarding_tasks(id),storage_path text not null unique,file_name text not null,mime_type text not null,file_size bigint not null,attached_by uuid not null references auth.users(id),attached_at timestamptz not null default now());
alter table public.onboarding_task_files enable row level security;
create index onboarding_files_task_idx on public.onboarding_task_files(task_id);
create policy "private onboarding files" on public.onboarding_task_files for select to authenticated using(onboarding_internal.response_reader(task_id));
revoke all on public.onboarding_task_files from public,anon,authenticated;grant select on public.onboarding_task_files to authenticated;

-- Explicit grants and scopes apply to both the old pages and new RPC projections.
do $$ declare p record;begin for p in select tablename,policyname from pg_policies where schemaname='public' and tablename in ('onboarding_runs','onboarding_tasks','onboarding_task_documents','onboarding_responsibilities') loop execute format('drop policy %I on public.%I',p.policyname,p.tablename);end loop;end $$;
create policy "scoped onboarding runs" on public.onboarding_runs for select to authenticated using(onboarding_internal.reader(organization_id,employee_id));
create policy "scoped onboarding tasks" on public.onboarding_tasks for select to authenticated using(onboarding_internal.task_reader(id));
create policy "scoped onboarding evidence" on public.onboarding_task_documents for select to authenticated using(onboarding_internal.response_reader(task_id));
create policy "scoped onboarding responsibilities" on public.onboarding_responsibilities for select to authenticated using(onboarding_internal.member(organization_id) and (private.has_permission(organization_id,'onboarding.manage_templates') or private.has_permission(organization_id,'employee.manage')));
grant select on public.onboarding_runs,public.onboarding_tasks,public.onboarding_progress_v,public.onboarding_templates,public.onboarding_template_versions,public.onboarding_template_steps,public.onboarding_task_documents,public.onboarding_responsibilities to authenticated;
revoke insert,update,delete on public.onboarding_runs,public.onboarding_tasks,public.onboarding_task_documents,public.onboarding_responsibilities from authenticated;

create function onboarding_internal.validate_version(p_version uuid) returns void language plpgsql security definer set search_path='' as $$ begin
 if exists(select 1 from public.onboarding_template_steps s cross join lateral unnest(s.dependency_step_ids)d where s.template_version_id=p_version and not exists(select 1 from public.onboarding_template_steps x where x.id=d and x.template_version_id=p_version)) then raise exception 'Every prerequisite must belong to the same template version';end if;
 if exists(with recursive reach(root,node) as (select s.id,d from public.onboarding_template_steps s cross join lateral unnest(s.dependency_step_ids)d where s.template_version_id=p_version union select r.root,d from reach r join public.onboarding_template_steps s on s.id=r.node cross join lateral unnest(s.dependency_step_ids)d) select 1 from reach where root=node) then raise exception 'Onboarding prerequisites cannot contain a cycle';end if;
end; $$;
create function onboarding_internal.validate_schema(p_schema jsonb) returns void language plpgsql immutable set search_path='' as $$ declare f jsonb;begin
 if p_schema is null or p_schema='null'::jsonb then return;end if;
 if jsonb_typeof(p_schema)<>'object' or jsonb_typeof(p_schema->'fields') is distinct from 'array' or jsonb_array_length(p_schema->'fields') not between 1 and 20 then raise exception 'Forms need 1–20 configured fields';end if;
 for f in select * from jsonb_array_elements(p_schema->'fields') loop
  if coalesce(f->>'key','') !~ '^[a-z][a-z0-9_]{0,39}$' or length(trim(coalesce(f->>'label',''))) not between 1 and 120 or coalesce(f->>'type','') not in ('text','date','number','checkbox') or (f?'required' and jsonb_typeof(f->'required')<>'boolean') then raise exception 'Check form field key, label, type and required flag';end if;
 end loop;
 if (select count(*) from jsonb_array_elements(p_schema->'fields'))<>(select count(distinct field.value->>'key') from jsonb_array_elements(p_schema->'fields')field(value)) then raise exception 'Form field keys must be unique';end if;
end; $$;
-- Current versions that have been used cannot be edited directly; the versioning RPC forks first.
create function onboarding_internal.template_guard() returns trigger language plpgsql security definer set search_path='' as $$ declare org uuid;v uuid;begin
 if tg_table_name='onboarding_templates' then org:=case when tg_op='DELETE' then old.organization_id else new.organization_id end;
 else v:=case when tg_table_name='onboarding_template_versions' then (case when tg_op='DELETE' then old.id else new.id end) else (case when tg_op='DELETE' then old.template_version_id else new.template_version_id end) end;select t.organization_id into org from public.onboarding_templates t join public.onboarding_template_versions ver on ver.template_id=t.id where ver.id=v;
 end if;
 if auth.uid() is not null and pg_trigger_depth()=1 then if not onboarding_internal.template_manager(org) then raise exception 'Onboarding template permission required';end if;perform private.assert_step_up(org);end if;
 if tg_table_name='onboarding_template_steps' then
  if tg_op<>'INSERT' and exists(select 1 from public.onboarding_runs where template_version_id=old.template_version_id) then raise exception 'This version is in use. Edit through the versioned template builder';end if;
  if tg_op='INSERT' and exists(select 1 from public.onboarding_runs where template_version_id=new.template_version_id) then raise exception 'Cannot add steps to a version already in use';end if;
  if tg_op<>'DELETE' then
   new.title:=trim(new.title);if length(new.title) not between 1 and 160 or length(coalesce(new.description,''))>4000 or new.due_offset_days not between -3660 and 3660 then raise exception 'Check the step title, instructions and due offset';end if;
   perform onboarding_internal.validate_schema(new.form_schema);new.requires_signature:=new.requires_signature or new.step_type='signature';
   if new.review_document_id is not null and not exists(select 1 from public.documents where id=new.review_document_id and organization_id=org and employee_id is null and visibility='org' and is_active and current_version_id is not null) then raise exception 'Choose an active company document with a published version';end if;
  end if;
 elsif tg_table_name='onboarding_templates' and tg_op<>'DELETE' then
  new.name:=trim(new.name);if length(new.name) not between 1 and 120 or length(coalesce(new.description,''))>2000 then raise exception 'Check template name and description';end if;
  if tg_op='UPDATE' and new.organization_id<>old.organization_id then raise exception 'Templates cannot move organizations';end if;
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end; $$;
create trigger onboarding_template_guard before insert or update or delete on public.onboarding_templates for each row execute function onboarding_internal.template_guard();
create trigger onboarding_steps_guard before insert or update or delete on public.onboarding_template_steps for each row execute function onboarding_internal.template_guard();
create function onboarding_internal.graph_guard() returns trigger language plpgsql security definer set search_path='' as $$ begin perform onboarding_internal.validate_version(new.template_version_id);return null;end; $$;
create constraint trigger onboarding_graph_integrity after insert or update on public.onboarding_template_steps deferrable initially deferred for each row execute function onboarding_internal.graph_guard();

create function onboarding_internal.snapshot() returns trigger language plpgsql security definer set search_path='' as $$ declare s public.onboarding_template_steps;begin
 if tg_table_name='onboarding_runs' then
  select t.name,v.version_number into new.template_name,new.template_version_number from public.onboarding_template_versions v join public.onboarding_templates t on t.id=v.template_id where v.id=new.template_version_id and t.organization_id=new.organization_id;
  select concat_ws(' ',coalesce(nullif(trim(preferred_name),''),first_name),last_name) into new.employee_name from public.employees where id=new.employee_id and organization_id=new.organization_id;
  if new.template_name is null or new.employee_name is null then raise exception 'Run, template and employee must belong to one organization';end if;
 else
  select * into s from public.onboarding_template_steps where id=new.template_step_id;
  if not exists(select 1 from public.onboarding_runs where id=new.run_id and organization_id=new.organization_id and employee_id=new.employee_id and template_version_id=s.template_version_id) then raise exception 'Task must belong to its run, employee and template version';end if;
  new.form_schema:=s.form_schema;new.requires_signature:=new.requires_signature or s.requires_signature or new.step_type='signature';
  select d.current_version_id,d.title into new.review_document_version_id,new.review_document_title from public.documents d where d.id=s.review_document_id;
 end if;return new;
end; $$;
create trigger onboarding_run_snapshot before insert on public.onboarding_runs for each row execute function onboarding_internal.snapshot();
create trigger onboarding_task_snapshot before insert on public.onboarding_tasks for each row execute function onboarding_internal.snapshot();
create function onboarding_internal.task_guard() returns trigger language plpgsql security definer set search_path='' as $$ begin
 if tg_op='DELETE' then raise exception 'Onboarding task history cannot be deleted';end if;
 if (to_jsonb(new)-'status'-'completion_data'-'completed_at'-'completed_by'-'signed_at'-'assigned_to_user_id'-'assignee_employee_id'-'assignment_locked'-'due_date'-'due_date_locked') is distinct from (to_jsonb(old)-'status'-'completion_data'-'completed_at'-'completed_by'-'signed_at'-'assigned_to_user_id'-'assignee_employee_id'-'assignment_locked'-'due_date'-'due_date_locked') then raise exception 'Started task instructions and evidence requirements are immutable';end if;
 if old.status in ('completed','skipped') and to_jsonb(new) is distinct from to_jsonb(old) then raise exception 'Closed onboarding steps are immutable';end if;return new;
end; $$;
create trigger onboarding_task_history before update or delete on public.onboarding_tasks for each row execute function onboarding_internal.task_guard();

-- New starts serialize per employee. Existing duplicates are retained for HR review.
alter function private.instantiate_onboarding_run(uuid,uuid,uuid) rename to instantiate_onboarding_run_legacy;
create function private.instantiate_onboarding_run(p_employee_id uuid,p_template_id uuid,p_actor uuid) returns public.onboarding_runs language plpgsql security definer set search_path='' as $$ declare e public.employees;t public.onboarding_templates;v uuid;r public.onboarding_runs;begin
 perform pg_advisory_xact_lock(hashtextextended(p_employee_id::text,95));
 select * into e from public.employees where id=p_employee_id;
 if e.id is null or e.status not in ('prehire','active','leave') then raise exception 'Onboarding requires a prehire, active employee or employee on leave';end if;
 select * into t from public.onboarding_templates where organization_id=e.organization_id and is_active and (id=p_template_id or (p_template_id is null and is_default)) order by created_at desc,id limit 1 for update;
 if t.id is null then raise exception 'Choose an active onboarding template';end if;
 select * into r from public.onboarding_runs where employee_id=e.id and status='in_progress' order by started_at,id limit 1;
 if r.id is not null then
  if exists(select 1 from public.onboarding_template_versions where id=r.template_version_id and template_id=t.id) then return r;end if;
  raise exception 'This employee already has an active plan. Review or cancel it before starting another';
 end if;
 select id into v from public.onboarding_template_versions where template_id=t.id and is_current;
 if v is null or not exists(select 1 from public.onboarding_template_steps where template_version_id=v) then raise exception 'Add at least one step to the current template before starting';end if;
 perform onboarding_internal.validate_version(v);
 return private.instantiate_onboarding_run_legacy(e.id,t.id,p_actor);
end; $$;
revoke all on function private.instantiate_onboarding_run_legacy(uuid,uuid,uuid) from public,anon,authenticated;
create function onboarding_internal.start(p_employee uuid,p_template uuid) returns public.onboarding_runs language plpgsql security definer set search_path='' as $$ declare org uuid;begin select organization_id into org from public.employees where id=p_employee;if not coalesce(onboarding_internal.manager(org,p_employee),false) then raise exception using errcode='42501',message='Onboarding management permission and scope required';end if;perform private.assert_step_up(org);return private.instantiate_onboarding_run(p_employee,p_template,auth.uid());end; $$;
create or replace function public.start_onboarding(p_employee_id uuid,p_template_id uuid default null) returns public.onboarding_runs language sql security invoker set search_path='' as $$ select * from onboarding_internal.start(p_employee_id,p_template_id); $$;

create function onboarding_internal.lock_task(p_task uuid,p_manage boolean default false) returns public.onboarding_tasks language plpgsql security definer set search_path='' as $$ declare t public.onboarding_tasks;r public.onboarding_runs;begin
 select * into t from public.onboarding_tasks where id=p_task;
 if t.id is null or not onboarding_internal.member(t.organization_id) or not (onboarding_internal.manager(t.organization_id,t.employee_id) or (not p_manage and t.assigned_to_user_id=auth.uid())) then raise exception using errcode='42501',message='This onboarding task is unavailable to your account or scope';end if;
 perform private.assert_step_up(t.organization_id);
 select * into r from public.onboarding_runs where id=t.run_id for update;
 select * into t from public.onboarding_tasks where id=p_task for update;
 if not onboarding_internal.member(t.organization_id) or not (onboarding_internal.manager(t.organization_id,t.employee_id) or (not p_manage and t.assigned_to_user_id=auth.uid())) then raise exception 'This task was reassigned or access changed';end if;
 if r.status='cancelled' then raise exception 'This onboarding plan is cancelled';end if;return t;
end; $$;
create function onboarding_internal.prerequisites(p_task public.onboarding_tasks) returns void language plpgsql security definer set search_path='' as $$ begin
 if exists(select 1 from unnest(p_task.dependency_step_ids)d where not exists(select 1 from public.onboarding_tasks where run_id=p_task.run_id and template_step_id=d and status in ('completed','skipped'))) then raise exception 'Finish or formally waive every prerequisite first';end if;
end; $$;
create or replace function private.maybe_complete_onboarding_run(p_run_id uuid) returns boolean language plpgsql security definer set search_path='' as $$ declare r public.onboarding_runs;begin
 if not exists(select 1 from public.onboarding_tasks where run_id=p_run_id) or exists(select 1 from public.onboarding_tasks where run_id=p_run_id and (required or not exists(select 1 from public.onboarding_tasks where run_id=p_run_id and required)) and status not in ('completed','skipped')) then return false;end if;
 update public.onboarding_runs set status='completed',completed_at=now() where id=p_run_id and status='in_progress' returning * into r;
 if r.id is not null then perform private.log_audit_event(r.organization_id,'ONBOARDING_COMPLETED','onboarding_run',r.id,null,jsonb_build_object('employee_id',r.employee_id));end if;return r.id is not null;
end; $$;
create function onboarding_internal.complete(p_task uuid,p_data jsonb) returns public.onboarding_tasks language plpgsql security definer set search_path='' as $$ declare t public.onboarding_tasks;d jsonb:=coalesce(p_data,'{}');f jsonb;answer jsonb;begin
 t:=onboarding_internal.lock_task(p_task);
 if t.status='completed' then return t;end if;if t.status='skipped' then raise exception 'This step was waived and cannot be rewritten';end if;
 if jsonb_typeof(d)<>'object' or octet_length(d::text)>24000 or length(coalesce(d->>'notes',''))>4000 then raise exception 'Completion must be a small structured response; notes at most 4000 characters';end if;
 if (t.requires_signature or (t.step_type in ('signature','acknowledgement') or (t.step_type='form' and t.assignee_type='employee'))) and t.assigned_to_user_id is distinct from auth.uid() then raise exception 'The assigned person must submit their own response or attestation';end if;
 if t.step_type='approval' and exists(select 1 from public.employees where id=t.employee_id and user_id=auth.uid()) then raise exception 'Another authorized person must approve this step';end if;
 perform onboarding_internal.prerequisites(t);
 if t.step_type='document_upload' and not exists(select 1 from public.onboarding_task_documents where task_id=t.id) and not exists(select 1 from public.onboarding_task_files where task_id=t.id) then raise exception 'Attach an actual document or upload evidence before completing this step';end if;
 if t.review_document_version_id is not null and not onboarding_internal.version_reader(t.review_document_version_id) then raise exception 'You must have access to the document being reviewed';end if;
 if t.requires_signature or t.step_type in ('signature','acknowledgement','document_review') then
  if d->'confirmed' is distinct from 'true'::jsonb then raise exception 'Explicitly confirm that you reviewed and completed this step';end if;
 end if;
 if t.requires_signature or t.step_type='signature' then if length(trim(coalesce(d->>'typed_name',''))) not between 2 and 200 then raise exception 'Enter your name to record this attestation';end if;end if;
 if t.step_type in ('meeting','training','approval','checkpoint') or (t.step_type='form' and t.form_schema is null) then if length(trim(coalesce(d->>'notes',''))) <3 then raise exception 'Record what was completed or decided in a brief note';end if;end if;
 if t.step_type='form' and t.form_schema is not null then
  perform onboarding_internal.validate_schema(t.form_schema);
  if jsonb_typeof(d->'answers') is distinct from 'object' then raise exception 'Complete the configured form fields';end if;
  if exists(select 1 from jsonb_object_keys(d->'answers')k where not exists(select 1 from jsonb_array_elements(t.form_schema->'fields')x where x->>'key'=k)) then raise exception 'Unknown form field';end if;
  for f in select * from jsonb_array_elements(t.form_schema->'fields') loop
   answer:=d->'answers'->(f->>'key');
   if coalesce((f->>'required')::boolean,false) and (answer is null or answer='null'::jsonb or answer='""'::jsonb or (f->>'type'='checkbox' and answer<>'true'::jsonb)) then raise exception 'A required form field is missing';end if;
   if answer is not null and answer<>'null'::jsonb and answer<>'""'::jsonb then
    if (f->>'type'='text' and (jsonb_typeof(answer)<>'string' or length(answer#>>'{}')>2000)) or (f->>'type'='number' and jsonb_typeof(answer)<>'number') or (f->>'type'='checkbox' and jsonb_typeof(answer)<>'boolean') or (f->>'type'='date' and ((answer#>>'{}')!~ '^\d{4}-\d{2}-\d{2}$' or private.safe_import_date(answer#>>'{}') is null)) then raise exception 'Invalid form field value';end if;
   end if;
  end loop;
 end if;
 insert into public.onboarding_task_responses(task_id,organization_id,data,recorded_by) values(t.id,t.organization_id,d||jsonb_build_object('actor_user_id',auth.uid(),'review_document_version_id',t.review_document_version_id),auth.uid()) on conflict(task_id) do update set data=excluded.data,recorded_by=excluded.recorded_by,recorded_at=now();
 update public.onboarding_tasks set status='completed',completion_data=jsonb_build_object('recorded',true),completed_at=now(),completed_by=auth.uid(),signed_at=case when t.requires_signature or t.step_type='signature' then now() end where id=t.id returning * into t;
 perform private.log_audit_event(t.organization_id,'ONBOARDING_TASK_COMPLETED','onboarding_task',t.id,null,jsonb_build_object('employee_id',t.employee_id,'step_type',t.step_type,'attested',t.signed_at is not null));perform private.maybe_complete_onboarding_run(t.run_id);return t;
end; $$;
create or replace function public.complete_onboarding_task(p_task_id uuid,p_completion_data jsonb default null) returns public.onboarding_tasks language sql security invoker set search_path='' as $$ select * from onboarding_internal.complete(p_task_id,p_completion_data); $$;
create function onboarding_internal.skip(p_task uuid,p_reason text) returns public.onboarding_tasks language plpgsql security definer set search_path='' as $$ declare t public.onboarding_tasks;begin
 t:=onboarding_internal.lock_task(p_task);
 if not onboarding_internal.manager(t.organization_id,t.employee_id) and t.required then raise exception 'Only scoped onboarding managers may waive a required step';end if;
 if length(trim(coalesce(p_reason,''))) not between 3 and 1000 then raise exception 'Explain the waiver in 3–1000 characters';end if;
 if t.status='skipped' then return t;end if;if t.status='completed' then raise exception 'A completed step cannot be waived';end if;
 insert into public.onboarding_task_responses(task_id,organization_id,data,recorded_by) values(t.id,t.organization_id,jsonb_build_object('skip_reason',trim(p_reason)),auth.uid()) on conflict(task_id) do update set data=excluded.data,recorded_by=excluded.recorded_by,recorded_at=now();
 update public.onboarding_tasks set status='skipped',completed_at=now(),completed_by=auth.uid(),completion_data=jsonb_build_object('recorded',true) where id=t.id returning * into t;
 perform private.log_audit_event(t.organization_id,'ONBOARDING_TASK_SKIPPED','onboarding_task',t.id,null,jsonb_build_object('employee_id',t.employee_id,'required',t.required));perform private.maybe_complete_onboarding_run(t.run_id);return t;
end; $$;
create or replace function public.skip_onboarding_task(p_task_id uuid,p_reason text) returns public.onboarding_tasks language sql security invoker set search_path='' as $$ select * from onboarding_internal.skip(p_task_id,p_reason); $$;
create function onboarding_internal.cancel(p_run uuid,p_reason text) returns public.onboarding_runs language plpgsql security definer set search_path='' as $$ declare r public.onboarding_runs;begin
 select * into r from public.onboarding_runs where id=p_run;
 if r.id is null or not onboarding_internal.manager(r.organization_id,r.employee_id) then raise exception using errcode='42501',message='Onboarding management permission and scope required';end if;perform private.assert_step_up(r.organization_id);
 select * into r from public.onboarding_runs where id=p_run for update;
 if length(trim(coalesce(p_reason,''))) not between 3 and 1000 then raise exception 'Explain cancellation in 3–1000 characters';end if;
 if r.status='cancelled' then return r;end if;if r.status<>'in_progress' then raise exception 'Only an active plan can be cancelled';end if;
 update public.onboarding_runs set status='cancelled',cancelled_at=now(),cancelled_by=auth.uid(),cancel_reason=trim(p_reason) where id=r.id returning * into r;
 perform private.log_audit_event(r.organization_id,'ONBOARDING_CANCELLED','onboarding_run',r.id,null,jsonb_build_object('employee_id',r.employee_id));return r;
end; $$;
create or replace function public.cancel_onboarding_run(p_run_id uuid,p_reason text) returns public.onboarding_runs language sql security invoker set search_path='' as $$ select * from onboarding_internal.cancel(p_run_id,p_reason); $$;

create function onboarding_internal.version_reader(p_version uuid) returns boolean language sql stable security definer set search_path='' as $$ select exists(select 1 from public.document_versions v join public.documents d on d.id=v.document_id where v.id=p_version and onboarding_internal.member(d.organization_id) and case d.visibility when 'org' then true when 'hr_only' then private.has_permission(d.organization_id,'documents.manage_org') when 'self' then exists(select 1 from public.employees e where e.id=d.employee_id and e.user_id=auth.uid()) or private.has_permission(d.organization_id,'documents.manage_org') when 'team' then exists(select 1 from public.employees e where e.id=d.employee_id and e.user_id=auth.uid()) or private.has_permission(d.organization_id,'documents.manage_org') or (private.has_permission(d.organization_id,'documents.manage_team') and private.in_management_scope(d.employee_id)) else false end); $$;
create function onboarding_internal.attach(p_task uuid,p_document uuid) returns public.onboarding_task_documents language plpgsql security definer set search_path='' as $$ declare t public.onboarding_tasks;d public.documents;e public.onboarding_task_documents;begin
 t:=onboarding_internal.lock_task(p_task);if t.status in ('completed','skipped') then raise exception 'Evidence is closed with the task';end if;
 select * into d from public.documents where id=p_document;
 if d.id is null or d.organization_id<>t.organization_id or not d.is_active or (d.employee_id is not null and d.employee_id<>t.employee_id) or d.current_version_id is null or not onboarding_internal.version_reader(d.current_version_id) then raise exception 'Choose an accessible, published document for this employee';end if;
 insert into public.onboarding_task_documents(task_id,document_id,organization_id,attached_by,document_version_id,document_title) values(t.id,d.id,t.organization_id,auth.uid(),d.current_version_id,d.title) on conflict(task_id,document_id) do nothing returning * into e;
 if e.task_id is null then select * into e from public.onboarding_task_documents where task_id=t.id and document_id=d.id;end if;
 perform private.log_audit_event(t.organization_id,'ONBOARDING_EVIDENCE_ATTACHED','onboarding_task',t.id,null,jsonb_build_object('document_version_id',e.document_version_id));return e;
end; $$;
create or replace function public.attach_onboarding_task_document(p_task_id uuid,p_document_id uuid) returns public.onboarding_task_documents language sql security invoker set search_path='' as $$ select * from onboarding_internal.attach(p_task_id,p_document_id); $$;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('onboarding-evidence','onboarding-evidence',false,15728640,array['application/pdf','image/jpeg','image/png']) on conflict(id) do nothing;
create function onboarding_internal.file_upload_allowed(p_path text) returns boolean language plpgsql stable security definer set search_path='' as $$ declare t public.onboarding_tasks;parts text[];begin
 parts:=string_to_array(p_path,'/');if array_length(parts,1)<>3 or parts[1]!~ '^[0-9a-f-]{36}$' or parts[2]!~ '^[0-9a-f-]{36}$' or parts[3]!~ '^[0-9a-f-]{36}\.(pdf|png|jpg)$' then return false;end if;
 select * into t from public.onboarding_tasks where id=parts[2]::uuid and organization_id=parts[1]::uuid;
 return coalesce(t.id is not null and onboarding_internal.response_reader(t.id) and onboarding_internal.member(t.organization_id) and (t.assigned_to_user_id=auth.uid() or onboarding_internal.manager(t.organization_id,t.employee_id)) and t.status not in ('completed','skipped') and exists(select 1 from public.onboarding_runs where id=t.run_id and status<>'cancelled') and (not coalesce((select step_up_for_sensitive_actions from public.organization_security_policies where organization_id=t.organization_id),false) or coalesce(auth.jwt()->>'aal','aal1')='aal2'),false);
 exception when invalid_text_representation then return false;
end; $$;
create policy "upload scoped onboarding evidence" on storage.objects for insert to authenticated with check(bucket_id='onboarding-evidence' and onboarding_internal.file_upload_allowed(name));
create policy "read scoped onboarding evidence" on storage.objects for select to authenticated using(bucket_id='onboarding-evidence' and exists(select 1 from public.onboarding_task_files f where f.storage_path=name and onboarding_internal.response_reader(f.task_id)));
create function onboarding_internal.register_file(p_task uuid,p_path text,p_name text,p_mime text,p_size bigint) returns public.onboarding_task_files language plpgsql security definer set search_path='' as $$ declare t public.onboarding_tasks;f public.onboarding_task_files;begin
 t:=onboarding_internal.lock_task(p_task);if not onboarding_internal.file_upload_allowed(p_path) or p_path not like t.organization_id::text||'/'||t.id::text||'/%' then raise exception 'This upload path is unavailable';end if;
 if length(trim(coalesce(p_name,''))) not between 1 and 180 or p_mime is null or p_mime not in ('application/pdf','image/png','image/jpeg') or p_size is null or p_size not between 1 and 15728640 or not exists(select 1 from storage.objects o where bucket_id='onboarding-evidence' and name=p_path and (to_jsonb(o)->'metadata'->>'size' is null or (to_jsonb(o)->'metadata'->>'size')::bigint=p_size) and (to_jsonb(o)->'metadata'->>'mimetype' is null or to_jsonb(o)->'metadata'->>'mimetype'=p_mime)) then raise exception 'Upload a PDF, PNG or JPEG up to 15 MB before attaching it';end if;
 insert into public.onboarding_task_files(organization_id,task_id,storage_path,file_name,mime_type,file_size,attached_by) values(t.organization_id,t.id,p_path,trim(p_name),p_mime,p_size,auth.uid()) on conflict(storage_path) do nothing returning * into f;
 if f.id is null then select * into f from public.onboarding_task_files where storage_path=p_path and task_id=t.id;end if;
 perform private.log_audit_event(t.organization_id,'ONBOARDING_FILE_ATTACHED','onboarding_task',t.id,null,jsonb_build_object('file_id',f.id));return f;
end; $$;
create function public.register_onboarding_file(p_task_id uuid,p_storage_path text,p_file_name text,p_mime_type text,p_file_size bigint) returns public.onboarding_task_files language sql security invoker set search_path='' as $$ select * from onboarding_internal.register_file(p_task_id,p_storage_path,p_file_name,p_mime_type,p_file_size); $$;
-- Retain the exact reviewed or submitted version. Upload a new version for future use.
create function onboarding_internal.document_guard() returns trigger language plpgsql security definer set search_path='' as $$ begin if exists(select 1 from public.onboarding_task_documents where document_version_id=old.id) or exists(select 1 from public.onboarding_tasks where review_document_version_id=old.id) then raise exception 'This version is preserved as onboarding evidence. Create a new document version';end if;if tg_op='DELETE' then return old;end if;return new;end; $$;
create trigger onboarding_document_version_history before update or delete on public.document_versions for each row execute function onboarding_internal.document_guard();
create function onboarding_internal.protected_object(p_bucket text,p_name text) returns boolean language sql stable security definer set search_path='' as $$ select exists(select 1 from public.document_versions v where v.storage_bucket=p_bucket and v.storage_path=p_name and (exists(select 1 from public.onboarding_task_documents where document_version_id=v.id) or exists(select 1 from public.onboarding_tasks where review_document_version_id=v.id))); $$;
create policy "preserve onboarding evidence files" on storage.objects as restrictive for delete to authenticated using(bucket_id<>'onboarding-evidence' and not onboarding_internal.protected_object(bucket_id,name));
create policy "preserve onboarding evidence content" on storage.objects as restrictive for update to authenticated using(bucket_id<>'onboarding-evidence' and not onboarding_internal.protected_object(bucket_id,name)) with check(bucket_id<>'onboarding-evidence' and not onboarding_internal.protected_object(bucket_id,name));

-- Scope existing configuration APIs before calling their established versioning logic.
do $$ declare f record;args text;callargs text;begin
 for f in select p.oid,p.proname,pg_get_function_arguments(p.oid) declarations,pg_get_function_identity_arguments(p.oid) identity,pg_get_function_result(p.oid) result,p.proargnames,p.pronargs from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('save_onboarding_template_step','delete_onboarding_template_step','move_onboarding_template_step','duplicate_onboarding_template','set_default_onboarding_template','delete_onboarding_template','set_employee_onboarding_plan','recommend_onboarding_template','set_onboarding_responsible','reassign_onboarding_task') loop
  select string_agg(quote_ident(x),',') into callargs from unnest(f.proargnames[1:f.pronargs])x;
  execute format('alter function public.%I(%s) set schema onboarding_internal',f.proname,f.identity);
  execute format('alter function onboarding_internal.%I(%s) rename to %I',f.proname,f.identity,f.proname||'_legacy');
  -- The compatibility wrapper routes through a function with explicit modern authorization.
  execute format('create function public.%I(%s) returns %s language sql security invoker set search_path='''' as %L',f.proname,f.declarations,f.result,'select * from onboarding_internal.'||f.proname||'('||callargs||');');
 end loop;
end $$;
create function onboarding_internal.save_onboarding_template_step(p_template_id uuid,p_step_id uuid,p_title text,p_description text,p_step_type text,p_assignee_type text,p_due_anchor text,p_due_offset_days integer,p_required boolean,p_phase text default null,p_dependency_step_ids uuid[] default '{}',p_assignee_employee_id uuid default null) returns public.onboarding_template_steps language plpgsql security definer set search_path='' as $$ declare s public.onboarding_template_steps;t public.onboarding_templates;v uuid;begin
 t:=private.require_template_manager(p_template_id);select id into v from public.onboarding_template_versions where template_id=p_template_id and is_current;
 if exists(select 1 from unnest(p_dependency_step_ids)d where not exists(select 1 from public.onboarding_template_steps where id=d and template_version_id=v)) or p_step_id=any(p_dependency_step_ids) then raise exception 'Select valid prerequisites from the current version';end if;
 if p_assignee_employee_id is not null and not exists(select 1 from public.employees where id=p_assignee_employee_id and organization_id=t.organization_id and status in ('active','leave')) then raise exception 'Choose an active owner in this organization';end if;
 s:=onboarding_internal.save_onboarding_template_step_legacy(p_template_id,p_step_id,p_title,p_description,p_step_type,p_assignee_type,p_due_anchor,p_due_offset_days,p_required,p_phase,p_dependency_step_ids,p_assignee_employee_id);perform onboarding_internal.validate_version(s.template_version_id);return s;
end; $$;
create function onboarding_internal.delete_onboarding_template_step(p_template_id uuid,p_step_id uuid) returns void language plpgsql security definer set search_path='' as $$ begin perform private.require_template_manager(p_template_id);perform onboarding_internal.delete_onboarding_template_step_legacy(p_template_id,p_step_id);end; $$;
create function onboarding_internal.move_onboarding_template_step(p_template_id uuid,p_step_id uuid,p_direction integer) returns void language plpgsql security definer set search_path='' as $$ begin perform private.require_template_manager(p_template_id);if p_direction is null or p_direction not in(-1,1) then raise exception 'Choose up or down';end if;perform onboarding_internal.move_onboarding_template_step_legacy(p_template_id,p_step_id,p_direction);end; $$;
create function onboarding_internal.duplicate_onboarding_template(p_template_id uuid,p_name text) returns public.onboarding_templates language plpgsql security definer set search_path='' as $$ begin perform private.require_template_manager(p_template_id);return onboarding_internal.duplicate_onboarding_template_legacy(p_template_id,p_name);end; $$;
create function onboarding_internal.set_default_onboarding_template(p_template_id uuid) returns public.onboarding_templates language plpgsql security definer set search_path='' as $$ begin perform private.require_template_manager(p_template_id);perform pg_advisory_xact_lock(hashtextextended((select organization_id::text from public.onboarding_templates where id=p_template_id),96));return onboarding_internal.set_default_onboarding_template_legacy(p_template_id);end; $$;
create function onboarding_internal.delete_onboarding_template(p_template_id uuid) returns void language plpgsql security definer set search_path='' as $$ begin perform private.require_template_manager(p_template_id);perform onboarding_internal.delete_onboarding_template_legacy(p_template_id);end; $$;
create function onboarding_internal.set_employee_onboarding_plan(p_employee_id uuid,p_template_id uuid,p_was_recommended boolean default false) returns public.employee_access_setup language plpgsql security definer set search_path='' as $$ declare org uuid;begin select organization_id into org from public.employees where id=p_employee_id;if not coalesce(onboarding_internal.manager(org,p_employee_id),false) then raise exception 'Onboarding management permission and scope required';end if;perform private.assert_step_up(org);return onboarding_internal.set_employee_onboarding_plan_legacy(p_employee_id,p_template_id,p_was_recommended);end; $$;
create function onboarding_internal.recommend_onboarding_template(p_employee_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$ declare org uuid;begin select organization_id into org from public.employees where id=p_employee_id;if not coalesce(onboarding_internal.manager(org,p_employee_id),false) then raise exception 'Onboarding management permission and scope required';end if;return onboarding_internal.recommend_onboarding_template_legacy(p_employee_id);end; $$;

create or replace function private.onboarding_assignee_employee(p_employee public.employees,p_assignee_type text,p_step_assignee uuid) returns uuid language sql stable security definer set search_path='' as $$
 select e.id from public.employees e where e.organization_id=p_employee.organization_id and e.status in ('prehire','active','leave') and e.id=case p_assignee_type when 'employee' then p_employee.id when 'supervisor' then (select a.supervisor_employee_id from public.employee_assignments a where a.employee_id=p_employee.id and a.start_date<=private.org_today(p_employee.organization_id) and (a.end_date is null or a.end_date>=private.org_today(p_employee.organization_id)) order by a.start_date desc limit 1) when 'manager' then (select a.manager_employee_id from public.employee_assignments a where a.employee_id=p_employee.id and a.start_date<=private.org_today(p_employee.organization_id) and (a.end_date is null or a.end_date>=private.org_today(p_employee.organization_id)) order by a.start_date desc limit 1) else coalesce((select id from public.employees where id=p_step_assignee and organization_id=p_employee.organization_id and status in ('active','leave')),(select r.employee_id from public.onboarding_responsibilities r join public.employees p on p.id=r.employee_id and p.status in ('active','leave') where r.organization_id=p_employee.organization_id and r.assignee_type=p_assignee_type)) end;
$$;
create or replace function private.resolve_onboarding_assignees(p_employee_id uuid) returns integer language plpgsql security definer set search_path='' as $$ declare n integer;begin
 with owners as(select t.id,case when t.assignment_locked then t.assignee_employee_id else private.onboarding_assignee_employee(e,t.assignee_type,s.assignee_employee_id) end owner from public.onboarding_tasks t join public.onboarding_runs r on r.id=t.run_id and r.status in ('in_progress','completed') join public.employees e on e.id=t.employee_id join public.onboarding_template_steps s on s.id=t.template_step_id where t.organization_id=(select organization_id from public.employees where id=p_employee_id) and t.status not in ('completed','skipped'))
 update public.onboarding_tasks t set assignee_employee_id=o.owner,assigned_to_user_id=case when e.status in ('prehire','active','leave') then e.user_id end from owners o left join public.employees e on e.id=o.owner where t.id=o.id and (t.assignee_employee_id is distinct from o.owner or t.assigned_to_user_id is distinct from case when e.status in ('prehire','active','leave') then e.user_id end);get diagnostics n=row_count;return n;
end; $$;
create function onboarding_internal.set_onboarding_responsible(p_organization_id uuid,p_assignee_type text,p_employee_id uuid) returns integer language plpgsql security definer set search_path='' as $$ declare n integer;original_count integer;begin
 if not onboarding_internal.member(p_organization_id) or not(private.has_permission(p_organization_id,'employee.manage') or private.has_permission(p_organization_id,'onboarding.manage_templates')) then raise exception 'Onboarding responsibility permission required';end if;perform private.assert_step_up(p_organization_id);
 if p_assignee_type is null or p_assignee_type not in ('hr','it') then raise exception 'Choose HR or IT responsibility';end if;
 if p_employee_id is not null and not exists(select 1 from public.employees where id=p_employee_id and organization_id=p_organization_id and status in ('active','leave')) then raise exception 'Choose an active employee in this organization';end if;
 original_count:=onboarding_internal.set_onboarding_responsible_legacy(p_organization_id,p_assignee_type,p_employee_id);
 select id into p_employee_id from public.employees where organization_id=p_organization_id order by id limit 1;n:=private.resolve_onboarding_assignees(p_employee_id);return original_count+n;
end; $$;
create function onboarding_internal.reassign_onboarding_task(p_task_id uuid,p_employee_id uuid) returns public.onboarding_tasks language plpgsql security definer set search_path='' as $$ declare t public.onboarding_tasks;begin
 t:=onboarding_internal.lock_task(p_task_id,true);if t.status in ('completed','skipped') then raise exception 'This step is closed';end if;
 if not exists(select 1 from public.employees where id=p_employee_id and organization_id=t.organization_id and status in ('active','leave','prehire')) then raise exception 'Choose an eligible employee in this organization';end if;
 if t.assignee_type='employee' and (t.requires_signature or t.step_type in ('form','signature','acknowledgement')) and p_employee_id<>t.employee_id then raise exception 'Personal responses and attestations stay assigned to the employee';end if;
 return onboarding_internal.reassign_onboarding_task_legacy(p_task_id,p_employee_id);
end; $$;
create function onboarding_internal.reschedule(p_task uuid,p_due date,p_reason text) returns public.onboarding_tasks language plpgsql security definer set search_path='' as $$ declare t public.onboarding_tasks;e public.employees;r public.onboarding_runs;begin
 t:=onboarding_internal.lock_task(p_task,true);if t.status in ('completed','skipped') or length(trim(coalesce(p_reason,''))) not between 3 and 1000 then raise exception 'An open step and a scheduling explanation are required';end if;
 select * into e from public.employees where id=t.employee_id;select * into r from public.onboarding_runs where id=t.run_id;
 update public.onboarding_tasks set due_date=coalesce(p_due,private.onboarding_anchor_date(t.due_anchor,e,private.org_local_date(t.organization_id,r.started_at))+t.due_offset_days),due_date_locked=p_due is not null where id=t.id returning * into t;
 perform private.log_audit_event(t.organization_id,'ONBOARDING_TASK_RESCHEDULED','onboarding_task',t.id,null,jsonb_build_object('due_date',t.due_date,'reason',trim(p_reason)));return t;
end; $$;
create function public.reschedule_onboarding_task(p_task_id uuid,p_due_date date,p_reason text) returns public.onboarding_tasks language sql security invoker set search_path='' as $$ select * from onboarding_internal.reschedule(p_task_id,p_due_date,p_reason); $$;
create function onboarding_internal.progress(p_task uuid,p_status text,p_note text) returns public.onboarding_tasks language plpgsql security definer set search_path='' as $$ declare t public.onboarding_tasks;begin
 t:=onboarding_internal.lock_task(p_task);
 if t.status in ('completed','skipped') or p_status is null or p_status not in ('pending','in_progress','blocked') or length(trim(coalesce(p_note,''))) not between 3 and 1000 then raise exception 'Choose an open status and explain the update';end if;
 insert into public.onboarding_task_responses(task_id,organization_id,data,recorded_by) values(t.id,t.organization_id,jsonb_build_object('progress_note',trim(p_note)),auth.uid()) on conflict(task_id) do update set data=excluded.data,recorded_at=now(),recorded_by=excluded.recorded_by;
 update public.onboarding_tasks set status=p_status where id=t.id returning * into t;perform private.log_audit_event(t.organization_id,'ONBOARDING_TASK_PROGRESS','onboarding_task',t.id,null,jsonb_build_object('status',p_status));return t;
end; $$;
create function public.update_onboarding_task_progress(p_task_id uuid,p_status text,p_note text) returns public.onboarding_tasks language sql security invoker set search_path='' as $$ select * from onboarding_internal.progress(p_task_id,p_status,p_note); $$;
create or replace function private.notify_onboarding_task_assigned() returns trigger language plpgsql security definer set search_path='' as $$ begin
 if new.assigned_to_user_id is not null and (tg_op='INSERT' or old.assigned_to_user_id is distinct from new.assigned_to_user_id) then perform private.create_notification(new.organization_id,new.assigned_to_user_id,new.employee_id,'onboarding.task_assigned','An onboarding step is assigned to you','Open Onboarding to review your assigned work.','/onboarding/tasks/'||new.id,jsonb_build_object('task_id',new.id));end if;return new;
end; $$;
create trigger onboarding_tasks_notify_reassigned after update of assigned_to_user_id on public.onboarding_tasks for each row execute function private.notify_onboarding_task_assigned();
create trigger onboarding_employee_status_follow after update of status on public.employees for each row execute function private.onboarding_follow_employee_changes();

create or replace function private.clone_onboarding_steps(p_from_version uuid, p_to_version uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.onboarding_template_steps (
    template_version_id, title, description, step_type, assignee_type, sequence, due_offset_days,
    required, dependency_step_ids, form_schema, document_template_id, requires_signature,
    due_anchor, phase, source_step_id, assignee_employee_id, review_document_id
  )
  select p_to_version, s.title, s.description, s.step_type, s.assignee_type, s.sequence, s.due_offset_days,
         s.required, '{}', s.form_schema, s.document_template_id, s.requires_signature,
         s.due_anchor, s.phase, s.id, s.assignee_employee_id, s.review_document_id
  from public.onboarding_template_steps s
  where s.template_version_id = p_from_version;

  update public.onboarding_template_steps n
  set dependency_step_ids = coalesce((
    select array_agg(m.id)
    from public.onboarding_template_steps old_step
    cross join lateral unnest(old_step.dependency_step_ids) as dep(step_id)
    join public.onboarding_template_steps m
      on m.template_version_id = p_to_version and m.source_step_id = dep.step_id
    where old_step.id = n.source_step_id
  ), '{}')
  where n.template_version_id = p_to_version;
end;
$$;


create or replace function private.recompute_onboarding_due_dates(p_employee_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.onboarding_tasks t
  set due_date = private.onboarding_anchor_date(t.due_anchor, e, private.org_local_date(r.organization_id, r.started_at)) + t.due_offset_days
  from public.onboarding_runs r, public.employees e
  where t.employee_id = p_employee_id
    and r.id = t.run_id
    and e.id = t.employee_id
    and r.status = 'in_progress'
    and t.status not in ('completed', 'skipped')
    and not t.due_date_locked and t.due_offset_days is not null
    and t.due_date is distinct from (
      private.onboarding_anchor_date(t.due_anchor, e, private.org_local_date(r.organization_id, r.started_at)) + t.due_offset_days
    );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;


create function onboarding_internal.create_template(p_org uuid,p_name text,p_default boolean) returns public.onboarding_templates language plpgsql security definer set search_path='' as $$ declare t public.onboarding_templates;begin
 if not onboarding_internal.template_manager(p_org) then raise exception 'Template management permission required';end if;perform private.assert_step_up(p_org);
 perform pg_advisory_xact_lock(hashtextextended(p_org::text,96));
 if p_default then update public.onboarding_templates set is_default=false where organization_id=p_org and is_default;end if;
 insert into public.onboarding_templates(organization_id,name,is_default,created_by) values(p_org,trim(p_name),coalesce(p_default,false),auth.uid()) returning * into t;
 insert into public.onboarding_template_versions(template_id,version_number,is_current,created_by) values(t.id,1,true,auth.uid());return t;
end; $$;
create function public.create_onboarding_template(p_organization_id uuid,p_name text,p_is_default boolean default false) returns public.onboarding_templates language sql security invoker set search_path='' as $$ select * from onboarding_internal.create_template(p_organization_id,p_name,p_is_default); $$;
create function onboarding_internal.save_step(p_template uuid,p_step uuid,p_data jsonb) returns public.onboarding_template_steps language plpgsql security definer set search_path='' as $$ declare s public.onboarding_template_steps;deps uuid[];begin
 perform private.require_template_manager(p_template);perform onboarding_internal.validate_schema(p_data->'form_schema');
 select coalesce(array_agg(x::uuid),'{}') into deps from jsonb_array_elements_text(coalesce(p_data->'dependency_step_ids','[]'::jsonb))x;
 s:=onboarding_internal.save_onboarding_template_step(p_template,p_step,p_data->>'title',p_data->>'description',p_data->>'step_type',p_data->>'assignee_type',p_data->>'due_anchor',(p_data->>'due_offset_days')::integer,(p_data->>'required')::boolean,p_data->>'phase',deps,(p_data->>'assignee_employee_id')::uuid);
 update public.onboarding_template_steps set form_schema=nullif(p_data->'form_schema','null'::jsonb),review_document_id=(p_data->>'review_document_id')::uuid where id=s.id returning * into s;return s;
end; $$;
create function public.save_onboarding_step(p_template_id uuid,p_step_id uuid,p_data jsonb) returns public.onboarding_template_steps language sql security invoker set search_path='' as $$ select * from onboarding_internal.save_step(p_template_id,p_step_id,p_data); $$;
create function onboarding_internal.task_json(p_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$ declare t public.onboarding_tasks;r public.onboarding_runs;can_manage boolean;can_response boolean;begin
 select * into t from public.onboarding_tasks where id=p_id;if not coalesce(onboarding_internal.task_reader(p_id),false) then raise exception using errcode='42501',message='Onboarding task unavailable';end if;
 select * into r from public.onboarding_runs where id=t.run_id;can_manage:=onboarding_internal.manager(t.organization_id,t.employee_id);can_response:=onboarding_internal.response_reader(t.id);
 return to_jsonb(t)||jsonb_build_object('completed_by_label',(select concat_ws(' ',coalesce(nullif(trim(preferred_name),''),first_name),last_name) from public.employees where organization_id=t.organization_id and user_id=t.completed_by limit 1),'assignee_label',(select concat_ws(' ',coalesce(nullif(trim(preferred_name),''),first_name),last_name) from public.employees where id=t.assignee_employee_id),'run_status',r.status,'template_name',r.template_name,'template_version_number',r.template_version_number,'subject_name',r.employee_name,'can_manage',can_manage,'can_respond',r.status<>'cancelled' and (can_manage or t.assigned_to_user_id=auth.uid()) and ((not t.requires_signature and t.step_type not in ('form','signature','acknowledgement')) or t.assigned_to_user_id=auth.uid()),'can_evidence',can_response and (can_manage or t.assigned_to_user_id=auth.uid()),'can_skip',can_manage or (not t.required and t.assigned_to_user_id=auth.uid()),
 'response',case when can_response then (select data from public.onboarding_task_responses where task_id=t.id) end,
 'review_document',case when onboarding_internal.version_reader(t.review_document_version_id) then (select jsonb_build_object('id',v.id,'title',t.review_document_title,'bucket',v.storage_bucket,'path',v.storage_path) from public.document_versions v where v.id=t.review_document_version_id) end,
 'prerequisites',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'title',x.title,'status',x.status)) from public.onboarding_tasks x where x.run_id=t.run_id and x.template_step_id=any(t.dependency_step_ids)),'[]'::jsonb),
 'files',case when can_response then coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'title',f.file_name,'bucket','onboarding-evidence','path',f.storage_path)) from public.onboarding_task_files f where f.task_id=t.id),'[]'::jsonb)||coalesce((select jsonb_agg(jsonb_build_object('id',e.document_version_id,'title',e.document_title,'bucket',v.storage_bucket,'path',v.storage_path)) from public.onboarding_task_documents e join public.document_versions v on v.id=e.document_version_id where e.task_id=t.id and onboarding_internal.version_reader(v.id)),'[]'::jsonb) else '[]'::jsonb end,
 'documents',case when can_response then coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'title',d.title)) from public.documents d where d.organization_id=t.organization_id and d.is_active and (d.employee_id=t.employee_id or d.employee_id is null) and onboarding_internal.version_reader(d.current_version_id)),'[]'::jsonb) else '[]'::jsonb end);
end; $$;
create function public.get_onboarding_task(p_task_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select onboarding_internal.task_json(p_task_id); $$;
create function onboarding_internal.run_json(p_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$ declare r public.onboarding_runs;begin
 select * into r from public.onboarding_runs where id=p_id;if r.id is null or not onboarding_internal.reader(r.organization_id,r.employee_id) then raise exception using errcode='42501',message='Onboarding record unavailable';end if;
 return to_jsonb(r)||jsonb_build_object('can_manage',onboarding_internal.manager(r.organization_id,r.employee_id),'tasks',coalesce((select jsonb_agg(onboarding_internal.task_json(t.id) order by sequence,id) from public.onboarding_tasks t where t.run_id=r.id),'[]'::jsonb));
end; $$;
create function public.get_onboarding_run(p_run_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select onboarding_internal.run_json(p_run_id); $$;
create function onboarding_internal.work(p_org uuid,p_view text,p_page integer) returns jsonb language plpgsql stable security definer set search_path='' as $$ begin
 if not onboarding_internal.member(p_org) then raise exception 'Onboarding access unavailable';end if;
 if p_view is null or p_view not in ('open','history','all') or p_page is null or p_page not between 1 and 100000 then raise exception 'Invalid onboarding filter';end if;
 return jsonb_build_object('total',(select count(*) from public.onboarding_tasks t join public.onboarding_runs r on r.id=t.run_id where t.organization_id=p_org and (t.assigned_to_user_id=auth.uid() or exists(select 1 from public.employees where id=t.employee_id and user_id=auth.uid())) and (p_view='all' or (p_view='open' and r.status<>'cancelled' and t.status not in ('completed','skipped')) or (p_view='history' and (r.status='cancelled' or t.status in ('completed','skipped'))))),
 'tasks',coalesce((select jsonb_agg(onboarding_internal.task_json(x.id)) from (select t.id from public.onboarding_tasks t join public.onboarding_runs r on r.id=t.run_id where t.organization_id=p_org and (t.assigned_to_user_id=auth.uid() or exists(select 1 from public.employees where id=t.employee_id and user_id=auth.uid())) and (p_view='all' or (p_view='open' and r.status<>'cancelled' and t.status not in ('completed','skipped')) or (p_view='history' and (r.status='cancelled' or t.status in ('completed','skipped')))) order by case when t.assigned_to_user_id=auth.uid() then 0 else 1 end,t.due_date nulls last,r.started_at,t.sequence,t.id limit 20 offset (p_page-1)*20)x),'[]'::jsonb));
end; $$;
create function public.list_onboarding_work(p_organization_id uuid,p_view text default 'open',p_page integer default 1) returns jsonb language sql security invoker set search_path='' as $$ select onboarding_internal.work(p_organization_id,p_view,p_page); $$;
create function onboarding_internal.people(p_org uuid) returns table(id uuid,label text,status text) language plpgsql stable security definer set search_path='' as $$ begin
 if not onboarding_internal.member(p_org) or not(private.has_permission(p_org,'employee.manage') or private.has_permission(p_org,'onboarding.manage_templates') or private.has_permission(p_org,'onboarding.manage_team')) then raise exception 'Onboarding administration permission required';end if;
 return query select e.id,concat_ws(' ',coalesce(nullif(trim(e.preferred_name),''),e.first_name),e.last_name)||' ('||e.employee_number||')',e.status from public.employees e where e.organization_id=p_org and e.status in ('prehire','active','leave') and (private.has_permission(p_org,'employee.manage') or private.has_permission(p_org,'onboarding.manage_templates') or private.in_management_scope(e.id)) order by e.last_name,e.first_name,e.id;
end; $$;
create function public.list_onboarding_people(p_organization_id uuid) returns table(id uuid,label text,status text) language sql security invoker set search_path='' as $$ select * from onboarding_internal.people(p_organization_id); $$;
create function onboarding_internal.admin(p_org uuid,p_view text,p_page integer,p_query text) returns jsonb language plpgsql stable security definer set search_path='' as $$ begin
 if not onboarding_internal.member(p_org) or not(private.has_permission(p_org,'employee.manage') or private.has_permission(p_org,'onboarding.manage_team') or private.has_permission(p_org,'onboarding.read_team') or private.has_permission(p_org,'onboarding.manage_templates')) then raise exception 'Onboarding administration permission required';end if;
 if p_view is null or p_view not in ('all','in_progress','completed','cancelled') or p_page is null or p_page not between 1 and 100000 or length(coalesce(p_query,''))>120 then raise exception 'Invalid onboarding filter';end if;
 return jsonb_build_object('total',(select count(*) from public.onboarding_runs r where r.organization_id=p_org and onboarding_internal.reader(p_org,r.employee_id) and (p_view='all' or r.status=p_view) and concat_ws(' ',r.employee_name,r.template_name) ilike '%'||trim(coalesce(p_query,''))||'%'),
 'runs',coalesce((select jsonb_agg(to_jsonb(x)) from (select r.*,p.total_tasks,p.completed_tasks,p.overdue_tasks,p.percent_complete,(select count(*) from public.onboarding_tasks where run_id=r.id and status='skipped') waived_tasks,(select count(*) from public.onboarding_tasks where run_id=r.id and status='blocked') blocked_tasks,(select count(*) from public.onboarding_tasks where run_id=r.id and assigned_to_user_id is null and status not in('completed','skipped')) unassigned_tasks,(select count(*) from public.onboarding_runs where employee_id=r.employee_id and status='in_progress') active_plan_count from public.onboarding_runs r join public.onboarding_progress_v p on p.run_id=r.id where r.organization_id=p_org and onboarding_internal.reader(p_org,r.employee_id) and (p_view='all' or r.status=p_view) and concat_ws(' ',r.employee_name,r.template_name) ilike '%'||trim(coalesce(p_query,''))||'%' order by r.started_at desc,r.id limit 25 offset (p_page-1)*25)x),'[]'::jsonb));
end; $$;
create function public.list_onboarding_admin(p_organization_id uuid,p_view text default 'in_progress',p_page integer default 1,p_query text default '') returns jsonb language sql security invoker set search_path='' as $$ select onboarding_internal.admin(p_organization_id,p_view,p_page,p_query); $$;
create or replace function public.list_my_onboarding_subjects() returns table(run_id uuid,run_status text,employee_id uuid,display_name text,employee_number text) language sql security invoker set search_path='' as $$ select * from onboarding_internal.subjects(); $$;
create function onboarding_internal.subjects() returns table(run_id uuid,run_status text,employee_id uuid,display_name text,employee_number text) language sql stable security definer set search_path='' as $$ select distinct r.id,r.status,e.id,coalesce(nullif(trim(e.preferred_name),''),e.first_name)||' '||e.last_name,e.employee_number from public.onboarding_tasks t join public.onboarding_runs r on r.id=t.run_id join public.employees e on e.id=t.employee_id where t.assigned_to_user_id=auth.uid() and onboarding_internal.member(t.organization_id); $$;

-- No implementation or compatibility bypass is anonymously executable.
revoke all on all functions in schema onboarding_internal from public,anon,authenticated;
do $$ declare f record;begin for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='onboarding_internal' and p.proname=any(array['member','manager','reader','template_manager','task_reader','response_reader','version_reader','file_upload_allowed','protected_object','start','complete','skip','cancel','attach','register_file','save_onboarding_template_step','delete_onboarding_template_step','move_onboarding_template_step','duplicate_onboarding_template','set_default_onboarding_template','delete_onboarding_template','set_employee_onboarding_plan','recommend_onboarding_template','set_onboarding_responsible','reassign_onboarding_task','reschedule','progress','create_template','save_step','task_json','run_json','work','people','admin','subjects']) loop execute format('grant execute on function %s to authenticated',f.signature);end loop;for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like '%onboarding%' and p.proname<>'link_invited_employee_account') loop execute format('revoke all on function %s from public,anon',f.signature);execute format('grant execute on function %s to authenticated',f.signature);end loop;end $$;


create function onboarding_internal.protected_read(p_bucket text,p_name text) returns boolean language sql stable security definer set search_path='' as $$ select not onboarding_internal.protected_object(p_bucket,p_name) or exists(select 1 from public.document_versions v where v.storage_bucket=p_bucket and v.storage_path=p_name and onboarding_internal.version_reader(v.id)); $$;
create policy "respect onboarding document audience" on storage.objects as restrictive for select to authenticated using(onboarding_internal.protected_read(bucket_id,name));
revoke all on function onboarding_internal.protected_read(text,text) from public,anon;grant execute on function onboarding_internal.protected_read(text,text) to authenticated;
set check_function_bodies=true;
create function onboarding_internal.version_guard() returns trigger language plpgsql security definer set search_path='' as $$ declare org uuid;begin
 if tg_op='DELETE' then select organization_id into org from public.onboarding_templates where id=old.template_id;else select organization_id into org from public.onboarding_templates where id=new.template_id;end if;
 if auth.uid() is not null and pg_trigger_depth()=1 then if not onboarding_internal.template_manager(org) then raise exception 'Template permission required';end if;perform private.assert_step_up(org);end if;
 if tg_op<>'INSERT' and exists(select 1 from public.onboarding_runs where template_version_id=old.id) then
  if tg_op='DELETE' then raise exception 'This version is preserved by an onboarding record';end if;
  if (to_jsonb(new)-'is_current') is distinct from (to_jsonb(old)-'is_current') then raise exception 'Used template versions are immutable';end if;
 end if;if tg_op='DELETE' then return old;end if;return new;
end; $$;
create trigger onboarding_versions_guard before insert or update or delete on public.onboarding_template_versions for each row execute function onboarding_internal.version_guard();
create function onboarding_internal.run_guard() returns trigger language plpgsql security definer set search_path='' as $$ begin
 if tg_op='DELETE' then raise exception 'Onboarding records are retained; cancel an active plan instead';end if;
 if (to_jsonb(new)-'status'-'completed_at'-'cancelled_at'-'cancelled_by'-'cancel_reason') is distinct from (to_jsonb(old)-'status'-'completed_at'-'cancelled_at'-'cancelled_by'-'cancel_reason') then raise exception 'Onboarding identity and template snapshots are immutable';end if;
 if old.status in ('completed','cancelled') and to_jsonb(new) is distinct from to_jsonb(old) then raise exception 'Closed onboarding records cannot be rewritten';end if;return new;
end; $$;
create trigger onboarding_run_history before update or delete on public.onboarding_runs for each row execute function onboarding_internal.run_guard();
revoke all on function onboarding_internal.version_guard(),onboarding_internal.run_guard() from public,anon,authenticated;

create function onboarding_internal.version_org(p_version uuid) returns uuid language sql stable security definer set search_path='' as $$ select t.organization_id from public.onboarding_template_versions v join public.onboarding_templates t on t.id=v.template_id where v.id=p_version; $$;
create policy "onboarding template account security" on public.onboarding_templates as restrictive for all to authenticated using(onboarding_internal.member(organization_id)) with check(onboarding_internal.member(organization_id));
create policy "onboarding version account security" on public.onboarding_template_versions as restrictive for all to authenticated using(onboarding_internal.member((select organization_id from public.onboarding_templates where id=template_id))) with check(onboarding_internal.member((select organization_id from public.onboarding_templates where id=template_id)));
create policy "onboarding step account security" on public.onboarding_template_steps as restrictive for all to authenticated using(onboarding_internal.member(onboarding_internal.version_org(template_version_id))) with check(onboarding_internal.member(onboarding_internal.version_org(template_version_id)));
revoke all on function onboarding_internal.version_org(uuid) from public,anon;grant execute on function onboarding_internal.version_org(uuid) to authenticated;
