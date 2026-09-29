-- Halomanage — versioned onboarding template editing
--
-- Onboarding templates were always versioned in the schema, but the
-- builder inserted steps straight into the current version — so a version
-- that employees had already been onboarded with kept changing underneath
-- their permanent record ("Template v1" no longer meant what they got).
--
-- Every step edit now goes through an RPC that first makes sure the
-- current version is editable: a version no run has used yet is edited in
-- place; a version that has been used is copied to a new version, which
-- becomes current, and the edit lands there. Historical runs keep pointing
-- at the exact version they were started from.
--
-- Also: duplicate a template, and choose the organization default.

alter table public.onboarding_template_steps
  add column if not exists source_step_id uuid;

comment on column public.onboarding_template_steps.source_step_id is
  'The step this one was copied from when its version was forked — lets an edit addressed to the previous version''s step id land on its successor.';

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
    due_anchor, phase, source_step_id
  )
  select p_to_version, s.title, s.description, s.step_type, s.assignee_type, s.sequence, s.due_offset_days,
         s.required, '{}', s.form_schema, s.document_template_id, s.requires_signature,
         s.due_anchor, s.phase, s.id
  from public.onboarding_template_steps s
  where s.template_version_id = p_from_version;

  -- Re-point dependencies at the copies.
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

create or replace function private.ensure_editable_onboarding_version(p_template_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_template public.onboarding_templates;
  v_current public.onboarding_template_versions;
  v_new_id uuid;
  v_next integer;
begin
  select * into v_template from public.onboarding_templates where id = p_template_id for update;
  if v_template.id is null then
    raise exception 'Onboarding template not found';
  end if;

  select * into v_current from public.onboarding_template_versions
  where template_id = p_template_id and is_current;

  if v_current.id is null then
    select coalesce(max(version_number), 0) + 1 into v_next
    from public.onboarding_template_versions where template_id = p_template_id;
    insert into public.onboarding_template_versions (template_id, version_number, is_current, created_by)
    values (p_template_id, v_next, true, auth.uid())
    returning id into v_new_id;
    return v_new_id;
  end if;

  if not exists (select 1 from public.onboarding_runs where template_version_id = v_current.id) then
    return v_current.id;
  end if;

  select max(version_number) + 1 into v_next
  from public.onboarding_template_versions where template_id = p_template_id;

  insert into public.onboarding_template_versions (template_id, version_number, is_current, created_by)
  values (p_template_id, v_next, false, auth.uid())
  returning id into v_new_id;

  perform private.clone_onboarding_steps(v_current.id, v_new_id);

  update public.onboarding_template_versions set is_current = false where id = v_current.id;
  update public.onboarding_template_versions set is_current = true, published_at = now() where id = v_new_id;

  perform private.log_audit_event(
    v_template.organization_id, 'ONBOARDING_TEMPLATE_VERSION_CREATED', 'onboarding_template', p_template_id,
    jsonb_build_object('version_number', v_current.version_number),
    jsonb_build_object('version_number', v_next, 'reason', 'Edited after the previous version was used')
  );
  return v_new_id;
end;
$$;

-- Resolves a step id (possibly from the version that was just forked) to
-- its counterpart in p_version_id.
create or replace function private.map_onboarding_step(p_step_id uuid, p_version_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select s.id from public.onboarding_template_steps s where s.id = p_step_id and s.template_version_id = p_version_id),
    (select s.id from public.onboarding_template_steps s where s.source_step_id = p_step_id and s.template_version_id = p_version_id)
  );
$$;

create or replace function private.require_template_manager(p_template_id uuid)
returns public.onboarding_templates
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_template public.onboarding_templates;
begin
  select * into v_template from public.onboarding_templates where id = p_template_id;
  if v_template.id is null then
    raise exception 'Onboarding template not found';
  end if;
  if not private.has_permission(v_template.organization_id, 'onboarding.manage_templates') then
    raise exception using errcode = '42501', message = 'Not authorized to edit onboarding templates';
  end if;
  return v_template;
end;
$$;

create or replace function public.save_onboarding_template_step(
  p_template_id uuid,
  p_step_id uuid,
  p_title text,
  p_description text,
  p_step_type text,
  p_assignee_type text,
  p_due_anchor text,
  p_due_offset_days integer,
  p_required boolean,
  p_phase text default null,
  p_dependency_step_ids uuid[] default '{}'
)
returns public.onboarding_template_steps
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_template public.onboarding_templates;
  v_version uuid;
  v_step_id uuid;
  v_dependencies uuid[];
  v_step public.onboarding_template_steps;
begin
  v_template := private.require_template_manager(p_template_id);
  if nullif(btrim(coalesce(p_title, '')), '') is null then
    raise exception using errcode = '22023', message = 'A step needs a title';
  end if;

  v_version := private.ensure_editable_onboarding_version(p_template_id);

  if p_step_id is not null then
    v_step_id := private.map_onboarding_step(p_step_id, v_version);
    if v_step_id is null then
      raise exception 'That step is not part of this template';
    end if;
  end if;

  select coalesce(array_agg(mapped), '{}') into v_dependencies
  from (
    select private.map_onboarding_step(d, v_version) as mapped
    from unnest(coalesce(p_dependency_step_ids, '{}')) as d
  ) m
  where mapped is not null and mapped is distinct from v_step_id;

  if v_step_id is null then
    insert into public.onboarding_template_steps (
      template_version_id, title, description, step_type, assignee_type, sequence,
      due_anchor, due_offset_days, required, phase, dependency_step_ids
    ) values (
      v_version, btrim(p_title), nullif(btrim(coalesce(p_description, '')), ''), p_step_type, p_assignee_type,
      coalesce((select max(sequence) from public.onboarding_template_steps where template_version_id = v_version), 0) + 1,
      coalesce(p_due_anchor, 'run_start'), coalesce(p_due_offset_days, 0), coalesce(p_required, true), p_phase, v_dependencies
    )
    returning * into v_step;
  else
    update public.onboarding_template_steps
    set title = btrim(p_title),
        description = nullif(btrim(coalesce(p_description, '')), ''),
        step_type = p_step_type,
        assignee_type = p_assignee_type,
        due_anchor = coalesce(p_due_anchor, 'run_start'),
        due_offset_days = coalesce(p_due_offset_days, 0),
        required = coalesce(p_required, true),
        phase = p_phase,
        dependency_step_ids = v_dependencies
    where id = v_step_id
    returning * into v_step;
  end if;

  perform private.log_audit_event(
    v_template.organization_id, 'ONBOARDING_TEMPLATE_STEP_SAVED', 'onboarding_template', p_template_id, null,
    jsonb_build_object('step_id', v_step.id, 'title', v_step.title)
  );
  return v_step;
end;
$$;

revoke execute on function public.save_onboarding_template_step(uuid, uuid, text, text, text, text, text, integer, boolean, text, uuid[]) from public, anon;
grant execute on function public.save_onboarding_template_step(uuid, uuid, text, text, text, text, text, integer, boolean, text, uuid[]) to authenticated;

create or replace function private.resequence_onboarding_steps(p_version_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Two passes so the (template_version_id, sequence) unique constraint
  -- never sees a transient duplicate.
  update public.onboarding_template_steps set sequence = sequence + 100000 where template_version_id = p_version_id;
  update public.onboarding_template_steps s
  set sequence = ordered.rn
  from (
    select id, row_number() over (order by sequence) as rn
    from public.onboarding_template_steps where template_version_id = p_version_id
  ) ordered
  where s.id = ordered.id;
end;
$$;

create or replace function public.delete_onboarding_template_step(p_template_id uuid, p_step_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_template public.onboarding_templates;
  v_version uuid;
  v_step_id uuid;
  v_title text;
begin
  v_template := private.require_template_manager(p_template_id);
  v_version := private.ensure_editable_onboarding_version(p_template_id);
  v_step_id := private.map_onboarding_step(p_step_id, v_version);
  if v_step_id is null then
    raise exception 'That step is not part of this template';
  end if;

  update public.onboarding_template_steps
  set dependency_step_ids = array_remove(dependency_step_ids, v_step_id)
  where template_version_id = v_version and v_step_id = any(dependency_step_ids);

  delete from public.onboarding_template_steps where id = v_step_id returning title into v_title;
  perform private.resequence_onboarding_steps(v_version);

  perform private.log_audit_event(
    v_template.organization_id, 'ONBOARDING_TEMPLATE_STEP_DELETED', 'onboarding_template', p_template_id, null,
    jsonb_build_object('title', v_title)
  );
end;
$$;

revoke execute on function public.delete_onboarding_template_step(uuid, uuid) from public, anon;
grant execute on function public.delete_onboarding_template_step(uuid, uuid) to authenticated;

create or replace function public.move_onboarding_template_step(p_template_id uuid, p_step_id uuid, p_direction integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version uuid;
  v_step public.onboarding_template_steps;
  v_other public.onboarding_template_steps;
begin
  perform private.require_template_manager(p_template_id);
  v_version := private.ensure_editable_onboarding_version(p_template_id);
  select * into v_step from public.onboarding_template_steps where id = private.map_onboarding_step(p_step_id, v_version);
  if v_step.id is null then
    raise exception 'That step is not part of this template';
  end if;

  select * into v_other from public.onboarding_template_steps
  where template_version_id = v_version
    and case when p_direction < 0 then sequence < v_step.sequence else sequence > v_step.sequence end
  order by case when p_direction < 0 then -sequence else sequence end
  limit 1;
  if v_other.id is null then
    return;
  end if;

  update public.onboarding_template_steps set sequence = -1 where id = v_step.id;
  update public.onboarding_template_steps set sequence = v_step.sequence where id = v_other.id;
  update public.onboarding_template_steps set sequence = v_other.sequence where id = v_step.id;
end;
$$;

revoke execute on function public.move_onboarding_template_step(uuid, uuid, integer) from public, anon;
grant execute on function public.move_onboarding_template_step(uuid, uuid, integer) to authenticated;

create or replace function public.duplicate_onboarding_template(p_template_id uuid, p_name text)
returns public.onboarding_templates
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source public.onboarding_templates;
  v_source_version uuid;
  v_copy public.onboarding_templates;
  v_version uuid;
begin
  v_source := private.require_template_manager(p_template_id);
  if nullif(btrim(coalesce(p_name, '')), '') is null then
    raise exception using errcode = '22023', message = 'Give the copy a name';
  end if;

  select id into v_source_version from public.onboarding_template_versions where template_id = p_template_id and is_current;

  insert into public.onboarding_templates (organization_id, name, description, applies_to, is_default, is_active, created_by)
  values (v_source.organization_id, btrim(p_name), v_source.description, v_source.applies_to, false, true, auth.uid())
  returning * into v_copy;

  insert into public.onboarding_template_versions (template_id, version_number, is_current, created_by)
  values (v_copy.id, 1, true, auth.uid())
  returning id into v_version;

  if v_source_version is not null then
    perform private.clone_onboarding_steps(v_source_version, v_version);
  end if;

  perform private.log_audit_event(
    v_source.organization_id, 'ONBOARDING_TEMPLATE_DUPLICATED', 'onboarding_template', v_copy.id, null,
    jsonb_build_object('source_template_id', p_template_id, 'name', v_copy.name)
  );
  return v_copy;
end;
$$;

revoke execute on function public.duplicate_onboarding_template(uuid, text) from public, anon;
grant execute on function public.duplicate_onboarding_template(uuid, text) to authenticated;

create or replace function public.set_default_onboarding_template(p_template_id uuid)
returns public.onboarding_templates
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_template public.onboarding_templates;
begin
  v_template := private.require_template_manager(p_template_id);
  if not v_template.is_active then
    raise exception using errcode = '23514', message = 'Activate this template before making it the default';
  end if;

  update public.onboarding_templates set is_default = false
  where organization_id = v_template.organization_id and is_default and id <> p_template_id;
  update public.onboarding_templates set is_default = true where id = p_template_id
  returning * into v_template;

  perform private.log_audit_event(
    v_template.organization_id, 'ONBOARDING_TEMPLATE_DEFAULT_SET', 'onboarding_template', p_template_id, null,
    jsonb_build_object('name', v_template.name)
  );
  return v_template;
end;
$$;

revoke execute on function public.set_default_onboarding_template(uuid) from public, anon;
grant execute on function public.set_default_onboarding_template(uuid) to authenticated;
