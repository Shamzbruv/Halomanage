-- Pin evidence against concurrent content replacement or deletion.
create function onboarding_internal.lock_version(p_version uuid) returns void language plpgsql security definer set search_path='' as $$ declare v public.document_versions;begin
 select * into v from public.document_versions where id=p_version for share;
 if v.id is null or not exists(select 1 from storage.objects where bucket_id=v.storage_bucket and name=v.storage_path) then raise exception 'The document file is unavailable. Ask HR to upload a valid version';end if;
end; $$;
revoke all on function onboarding_internal.lock_version(uuid) from public,anon,authenticated;
create or replace function onboarding_internal.snapshot() returns trigger language plpgsql security definer set search_path='' as $$ declare s public.onboarding_template_steps;begin
 if tg_table_name='onboarding_runs' then
  select t.name,v.version_number into new.template_name,new.template_version_number from public.onboarding_template_versions v join public.onboarding_templates t on t.id=v.template_id where v.id=new.template_version_id and t.organization_id=new.organization_id;
  select concat_ws(' ',coalesce(nullif(trim(preferred_name),''),first_name),last_name) into new.employee_name from public.employees where id=new.employee_id and organization_id=new.organization_id;
  if new.template_name is null or new.employee_name is null then raise exception 'Run, template and employee must belong to one organization';end if;
 else
  select * into s from public.onboarding_template_steps where id=new.template_step_id;
  if not exists(select 1 from public.onboarding_runs where id=new.run_id and organization_id=new.organization_id and employee_id=new.employee_id and template_version_id=s.template_version_id) then raise exception 'Task must belong to its run, employee and template version';end if;
  new.form_schema:=s.form_schema;new.requires_signature:=new.requires_signature or s.requires_signature or new.step_type='signature';
  select d.current_version_id,d.title into new.review_document_version_id,new.review_document_title from public.documents d where d.id=s.review_document_id and d.organization_id=new.organization_id and d.is_active and d.visibility='org' for share;
  if s.review_document_id is not null then if new.review_document_version_id is null then raise exception 'The template review document is no longer available';end if;perform onboarding_internal.lock_version(new.review_document_version_id);end if;
 end if;return new;
end; $$;
create or replace function onboarding_internal.attach(p_task uuid,p_document uuid) returns public.onboarding_task_documents language plpgsql security definer set search_path='' as $$ declare t public.onboarding_tasks;d public.documents;e public.onboarding_task_documents;begin
 t:=onboarding_internal.lock_task(p_task);if t.status in ('completed','skipped') then raise exception 'Evidence is closed with the task';end if;
 select * into d from public.documents where id=p_document for share;
 if d.id is null or d.organization_id<>t.organization_id or not d.is_active or (d.employee_id is not null and d.employee_id<>t.employee_id) or d.current_version_id is null or not onboarding_internal.version_reader(d.current_version_id) then raise exception 'Choose an accessible, published document for this employee';end if;
 perform onboarding_internal.lock_version(d.current_version_id);
 insert into public.onboarding_task_documents(task_id,document_id,organization_id,attached_by,document_version_id,document_title) values(t.id,d.id,t.organization_id,auth.uid(),d.current_version_id,d.title) on conflict(task_id,document_id) do nothing returning * into e;
 if e.task_id is null then select * into e from public.onboarding_task_documents where task_id=t.id and document_id=d.id;end if;
 perform private.log_audit_event(t.organization_id,'ONBOARDING_EVIDENCE_ATTACHED','onboarding_task',t.id,null,jsonb_build_object('document_version_id',e.document_version_id));return e;
end; $$;

create function onboarding_internal.preserve_object() returns trigger language plpgsql security definer set search_path='' as $$ declare v public.document_versions;begin
 if tg_op='UPDATE' and new.bucket_id=old.bucket_id and new.name=old.name and (to_jsonb(new)->'metadata') is not distinct from (to_jsonb(old)->'metadata') and (to_jsonb(new)->'version') is not distinct from (to_jsonb(old)->'version') then return new;end if;
 for v in select * from public.document_versions where storage_bucket=old.bucket_id and storage_path=old.name order by id for update loop
  if exists(select 1 from public.onboarding_task_documents where document_version_id=v.id) or exists(select 1 from public.onboarding_tasks where review_document_version_id=v.id) then raise exception 'This file is preserved as onboarding evidence. Upload a new version';end if;
 end loop;
 if tg_op='DELETE' then return old;end if;return new;
end; $$;
revoke all on function onboarding_internal.preserve_object() from public,anon,authenticated;
create trigger onboarding_preserve_storage_content before update or delete on storage.objects for each row execute function onboarding_internal.preserve_object();
