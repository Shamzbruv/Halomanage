-- Halomanage — performance checkpoints (appraisals as configurable cycles)
-- Ref: PRODUCT_BLUEPRINT.md "Your appraisal/checkpoint vision"; ARCHITECTURE.md
-- "Appraisals and checkpoints".
--
-- An appraisal is never "everyone gets an annual review on Dec 31" — it's a
-- template (goals/competencies/questions/rating scale) driving cycles that
-- can be 30/60/90-day probation checkpoints, quarterly, twice-yearly,
-- PIP-monthly, or ad-hoc, all built from the same engine.

create table public.appraisal_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  description text,
  -- e.g. [{"value": 1, "label": "Unsatisfactory"}, ..., {"value": 5, "label": "Exceptional"}]
  rating_scale jsonb not null default '[]'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.appraisal_templates enable row level security;
create index appraisal_templates_org_idx on public.appraisal_templates(organization_id);

create table public.appraisal_sections (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.appraisal_templates(id) on delete cascade,
  title text not null,
  sequence integer not null,
  unique (template_id, sequence)
);
alter table public.appraisal_sections enable row level security;

create table public.appraisal_questions (
  id uuid primary key default gen_random_uuid(),
  section_id uuid not null references public.appraisal_sections(id) on delete cascade,
  prompt text not null,
  question_type text not null check (question_type in ('text', 'numeric_rating', 'rating_scale', 'yes_no', 'multiple_choice', 'goal')),
  options jsonb,
  weight numeric(5,2) not null default 1,
  sequence integer not null,
  unique (section_id, sequence)
);
alter table public.appraisal_questions enable row level security;

create table public.appraisal_cycles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  template_id uuid not null references public.appraisal_templates(id) on delete restrict,
  name text not null,
  -- employee targeting filter, e.g. {"status": ["active"], "employment_type": ["full_time"]}
  employee_filter jsonb not null default '{}'::jsonb,
  start_date date not null,
  self_review_due date,
  supervisor_review_due date,
  manager_review_due date,
  acknowledgement_due date,
  repeat_interval text not null default 'none' check (repeat_interval in ('none', 'monthly', 'quarterly', 'annually')),
  status text not null default 'draft' check (status in ('draft', 'open', 'closed', 'cancelled')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
alter table public.appraisal_cycles enable row level security;
create index appraisal_cycles_org_idx on public.appraisal_cycles(organization_id, status);

create table public.appraisal_instances (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  cycle_id uuid references public.appraisal_cycles(id) on delete set null,
  template_id uuid not null references public.appraisal_templates(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete cascade,
  -- freeform label for non-cycle checkpoints, e.g. "30-day probation checkpoint"
  label text,
  status text not null default 'open' check (status in (
    'open', 'self_review_submitted', 'supervisor_review', 'manager_review',
    'employee_acknowledgement', 'complete', 'cancelled'
  )),
  acknowledged_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.appraisal_instances enable row level security;
create index appraisal_instances_employee_idx on public.appraisal_instances(employee_id, created_at desc);
create index appraisal_instances_org_status_idx on public.appraisal_instances(organization_id, status);

create table public.appraisal_reviewers (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid not null references public.appraisal_instances(id) on delete cascade,
  role text not null check (role in ('self', 'supervisor', 'manager', 'hr', 'peer')),
  reviewer_user_id uuid references auth.users(id),
  sequence smallint not null,
  status text not null default 'pending' check (status in ('pending', 'submitted', 'skipped')),
  submitted_at timestamptz,
  unique (instance_id, role, reviewer_user_id)
);
alter table public.appraisal_reviewers enable row level security;
create index appraisal_reviewers_instance_idx on public.appraisal_reviewers(instance_id);
create index appraisal_reviewers_user_idx on public.appraisal_reviewers(reviewer_user_id);

-- Previous-checkpoint comparison (PRODUCT_BLUEPRINT.md: "Previous Checkpoint
-- → Current Checkpoint") just needs responses queryable by
-- employee_id + question_id across instances/time, hence the join through
-- appraisal_instances rather than duplicating employee_id here.
create table public.appraisal_responses (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid not null references public.appraisal_instances(id) on delete cascade,
  reviewer_id uuid not null references public.appraisal_reviewers(id) on delete cascade,
  question_id uuid not null references public.appraisal_questions(id) on delete cascade,
  response_text text,
  response_numeric numeric(6,2),
  response_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (reviewer_id, question_id)
);
alter table public.appraisal_responses enable row level security;
create index appraisal_responses_instance_idx on public.appraisal_responses(instance_id);
create trigger appraisal_responses_set_updated_at
  before update on public.appraisal_responses
  for each row execute function private.set_updated_at();

create table public.appraisal_signoffs (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid not null references public.appraisal_instances(id) on delete cascade,
  signed_by_user_id uuid not null references auth.users(id),
  role text not null,
  note text,
  signed_at timestamptz not null default now()
);
alter table public.appraisal_signoffs enable row level security;
create index appraisal_signoffs_instance_idx on public.appraisal_signoffs(instance_id);

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

create or replace function public.launch_appraisal_cycle(p_cycle_id uuid)
returns setof public.appraisal_instances
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cycle public.appraisal_cycles;
  emp record;
  v_instance public.appraisal_instances;
  v_seq smallint;
begin
  select * into v_cycle from public.appraisal_cycles where id = p_cycle_id for update;
  if v_cycle.id is null then
    raise exception 'Appraisal cycle not found';
  end if;
  if not private.has_permission(v_cycle.organization_id, 'appraisal.manage_cycles') then
    raise exception 'Not authorized to launch appraisal cycles';
  end if;
  if v_cycle.status != 'draft' then
    raise exception 'Cycle has already been launched';
  end if;

  for emp in
    select e.id as employee_id, e.user_id, ea.supervisor_employee_id, ea.manager_employee_id
    from public.employees e
    left join public.employee_assignments ea on ea.employee_id = e.id and ea.end_date is null
    where e.organization_id = v_cycle.organization_id
      and e.status = 'active'
      and (v_cycle.employee_filter = '{}'::jsonb or true) -- filter refinement is a future enhancement; documented in ROADMAP.md
  loop
    insert into public.appraisal_instances (organization_id, cycle_id, template_id, employee_id, label)
    values (v_cycle.organization_id, v_cycle.id, v_cycle.template_id, emp.employee_id, v_cycle.name)
    returning * into v_instance;

    v_seq := 1;
    insert into public.appraisal_reviewers (instance_id, role, reviewer_user_id, sequence)
    values (v_instance.id, 'self', emp.user_id, v_seq);

    if emp.supervisor_employee_id is not null then
      v_seq := v_seq + 1;
      insert into public.appraisal_reviewers (instance_id, role, reviewer_user_id, sequence)
      values (v_instance.id, 'supervisor', (select user_id from public.employees where id = emp.supervisor_employee_id), v_seq);
    end if;

    if emp.manager_employee_id is not null then
      v_seq := v_seq + 1;
      insert into public.appraisal_reviewers (instance_id, role, reviewer_user_id, sequence)
      values (v_instance.id, 'manager', (select user_id from public.employees where id = emp.manager_employee_id), v_seq);
    end if;

    return next v_instance;
  end loop;

  update public.appraisal_cycles set status = 'open' where id = p_cycle_id;
  perform private.log_audit_event(v_cycle.organization_id, 'APPRAISAL_CYCLE_LAUNCHED', 'appraisal_cycle', v_cycle.id, null, to_jsonb(v_cycle));

  return;
end;
$$;

-- Marks the caller's reviewer stage submitted and advances the instance to
-- the next stage in sequence, or to employee_acknowledgement / complete once
-- every reviewer has submitted.
create or replace function public.submit_appraisal(p_instance_id uuid)
returns public.appraisal_instances
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_instance public.appraisal_instances;
  v_reviewer public.appraisal_reviewers;
  v_next public.appraisal_reviewers;
begin
  select * into v_instance from public.appraisal_instances where id = p_instance_id for update;
  if v_instance.id is null then
    raise exception 'Appraisal instance not found';
  end if;

  select * into v_reviewer from public.appraisal_reviewers
  where instance_id = p_instance_id and reviewer_user_id = (select auth.uid()) and status = 'pending'
  order by sequence asc limit 1;

  if v_reviewer.id is null then
    raise exception 'No pending review stage found for the current user on this appraisal';
  end if;

  update public.appraisal_reviewers set status = 'submitted', submitted_at = now() where id = v_reviewer.id;

  select * into v_next from public.appraisal_reviewers
  where instance_id = p_instance_id and status = 'pending' order by sequence asc limit 1;

  if v_next.id is not null then
    update public.appraisal_instances
    set status = case v_next.role
      when 'supervisor' then 'supervisor_review'
      when 'manager' then 'manager_review'
      else 'self_review_submitted'
    end
    where id = p_instance_id
    returning * into v_instance;
  else
    update public.appraisal_instances set status = 'employee_acknowledgement' where id = p_instance_id
    returning * into v_instance;
  end if;

  perform private.log_audit_event(v_instance.organization_id, 'APPRAISAL_STAGE_SUBMITTED', 'appraisal_instance', v_instance.id, null, to_jsonb(v_instance));

  return v_instance;
end;
$$;

create or replace function public.acknowledge_appraisal(p_instance_id uuid, p_note text default null)
returns public.appraisal_instances
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_instance public.appraisal_instances;
begin
  select * into v_instance from public.appraisal_instances where id = p_instance_id for update;
  if v_instance.id is null then
    raise exception 'Appraisal instance not found';
  end if;
  if v_instance.employee_id != private.current_employee_id() then
    raise exception 'Only the employee being appraised can acknowledge it';
  end if;
  if v_instance.status != 'employee_acknowledgement' then
    raise exception 'Appraisal is not awaiting acknowledgement';
  end if;

  update public.appraisal_instances set status = 'complete', acknowledged_at = now() where id = p_instance_id
  returning * into v_instance;

  insert into public.appraisal_signoffs (instance_id, signed_by_user_id, role, note)
  values (p_instance_id, auth.uid(), 'employee', p_note);

  perform private.log_audit_event(v_instance.organization_id, 'APPRAISAL_ACKNOWLEDGED', 'appraisal_instance', v_instance.id, null, to_jsonb(v_instance));

  return v_instance;
end;
$$;

revoke execute on function public.launch_appraisal_cycle(uuid) from public;
revoke execute on function public.submit_appraisal(uuid) from public;
revoke execute on function public.acknowledge_appraisal(uuid, text) from public;
grant execute on function public.launch_appraisal_cycle(uuid) to authenticated;
grant execute on function public.submit_appraisal(uuid) to authenticated;
grant execute on function public.acknowledge_appraisal(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS policies
-- ---------------------------------------------------------------------------

create policy "org members read appraisal templates" on public.appraisal_templates for select to authenticated
  using (private.is_org_member(organization_id));
create policy "admins manage appraisal templates" on public.appraisal_templates for all to authenticated
  using (private.has_permission(organization_id, 'appraisal.manage_cycles'))
  with check (private.has_permission(organization_id, 'appraisal.manage_cycles'));

create policy "org members read appraisal sections" on public.appraisal_sections for select to authenticated
  using (private.is_org_member((select organization_id from public.appraisal_templates t where t.id = template_id)));
create policy "admins manage appraisal sections" on public.appraisal_sections for all to authenticated
  using (private.has_permission((select organization_id from public.appraisal_templates t where t.id = template_id), 'appraisal.manage_cycles'))
  with check (private.has_permission((select organization_id from public.appraisal_templates t where t.id = template_id), 'appraisal.manage_cycles'));

create policy "org members read appraisal questions" on public.appraisal_questions for select to authenticated
  using (private.is_org_member((
    select t.organization_id from public.appraisal_sections s join public.appraisal_templates t on t.id = s.template_id
    where s.id = section_id
  )));
create policy "admins manage appraisal questions" on public.appraisal_questions for all to authenticated
  using (private.has_permission((
    select t.organization_id from public.appraisal_sections s join public.appraisal_templates t on t.id = s.template_id
    where s.id = section_id
  ), 'appraisal.manage_cycles'))
  with check (private.has_permission((
    select t.organization_id from public.appraisal_sections s join public.appraisal_templates t on t.id = s.template_id
    where s.id = section_id
  ), 'appraisal.manage_cycles'));

create policy "org members read appraisal cycles" on public.appraisal_cycles for select to authenticated
  using (private.is_org_member(organization_id));
create policy "admins manage appraisal cycles" on public.appraisal_cycles for all to authenticated
  using (private.has_permission(organization_id, 'appraisal.manage_cycles'))
  with check (private.has_permission(organization_id, 'appraisal.manage_cycles'));

-- appraisal_instances and appraisal_reviewers each need to check the
-- other's rows to decide visibility (an instance is visible to its
-- reviewers; a reviewer row is visible to the person being appraised).
-- Written as plain subqueries, that's a genuine mutual dependency —
-- evaluating one table's RLS policy requires evaluating the other's, which
-- requires evaluating the first's again, and Postgres correctly rejects it
-- with "infinite recursion detected in policy" (reproduced with a scripted
-- run before shipping this fix; see the equivalent note on
-- payroll_import_batches in 20260818001200_payroll_import.sql for the same
-- pattern). SECURITY DEFINER helpers break the cycle the same way.
create or replace function private.is_appraisal_reviewer(p_instance_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.appraisal_reviewers ar
    where ar.instance_id = p_instance_id and ar.reviewer_user_id = (select auth.uid())
  );
$$;

create or replace function private.is_appraisal_subject(p_instance_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.appraisal_instances ai
    where ai.id = p_instance_id and ai.employee_id = private.current_employee_id()
  );
$$;

create or replace function private.can_manage_appraisal_instance(p_instance_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_permission(
    (select ai.organization_id from public.appraisal_instances ai where ai.id = p_instance_id),
    'appraisal.manage_cycles'
  );
$$;

create policy "read own appraisal instances" on public.appraisal_instances for select to authenticated
  using (employee_id = private.current_employee_id());
create policy "read assigned appraisal instances" on public.appraisal_instances for select to authenticated
  using (private.is_appraisal_reviewer(id));
create policy "read team appraisal instances" on public.appraisal_instances for select to authenticated
  using (private.has_permission(organization_id, 'appraisal.review_direct_reports') and private.in_management_scope(employee_id));
create policy "hr read appraisal instances" on public.appraisal_instances for select to authenticated
  using (private.has_permission(organization_id, 'appraisal.manage_cycles'));

create policy "read own appraisal reviewer rows" on public.appraisal_reviewers for select to authenticated
  using (reviewer_user_id = (select auth.uid()) or private.is_appraisal_subject(instance_id));
create policy "hr read appraisal reviewers" on public.appraisal_reviewers for select to authenticated
  using (private.can_manage_appraisal_instance(instance_id));

create policy "reviewer manages own responses" on public.appraisal_responses for all to authenticated
  using (reviewer_id in (select id from public.appraisal_reviewers where reviewer_user_id = (select auth.uid()) and status = 'pending'))
  with check (reviewer_id in (select id from public.appraisal_reviewers where reviewer_user_id = (select auth.uid()) and status = 'pending'));
create policy "read visible responses" on public.appraisal_responses for select to authenticated
  using (
    private.is_appraisal_subject(instance_id)
    or private.is_appraisal_reviewer(instance_id)
    or private.can_manage_appraisal_instance(instance_id)
  );

create policy "read appraisal signoffs" on public.appraisal_signoffs for select to authenticated
  using (
    private.is_appraisal_subject(instance_id)
    or private.is_appraisal_reviewer(instance_id)
    or private.can_manage_appraisal_instance(instance_id)
  );
