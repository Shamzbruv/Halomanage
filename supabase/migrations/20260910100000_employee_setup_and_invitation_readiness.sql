-- Halomanage — employee setup, invitation readiness, and onboarding wiring
--
-- Implements the HR-professional feedback blueprint (docs/ARCHITECTURE.md
-- "Employee setup before invitation"). The principle: an employee account
-- is the *last* step of HR setup, not the first. HR builds the complete
-- record, prepares access and onboarding, the database says whether it is
-- ready, and only then can an invitation go out.
--
-- Nothing here replaces existing foundations — employees.user_id stays
-- nullable before invitation, employee_private stays the protected PII
-- layer, employee_assignments stays effective-dated, onboarding stays
-- versioned, and every mutation still lands in audit_events.
--
--   1. employees.middle_name (legal name) + protected-column guard update
--   2. Organization employee-number settings + transactional allocation
--   3. Organization setup requirements (which personal fields are mandatory)
--   4. employee_identifiers (TRN, NIS, national ID, passport…) — protected PII
--   5. employee_emergency_contacts (several contacts, one primary)
--   6. employee_access_setup — the role and onboarding plan HR prepares
--      *before* an Auth account exists
--   7. create_employee_record() — the only supported manual-create path
--   8. Onboarding: due-date anchors, phases, assignee backfill, skip/cancel,
--      onboarding.read_team, template recommendation
--   9. get_employee_setup_readiness() — single source of truth for "can
--      this person be invited yet?"
--  10. link_invited_employee_account() — now applies the prepared role and
--      starts the prepared onboarding in the same transaction
--  11. HaloManage Standard Onboarding — the professional default framework
--  12. Audit triggers that record *that* protected values changed without
--      copying the values themselves into audit JSON

-- ---------------------------------------------------------------------------
-- 1. Legal middle name
-- ---------------------------------------------------------------------------

alter table public.employees add column if not exists middle_name text;

create or replace function private.enforce_employee_protected_columns()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or private.has_permission(new.organization_id, 'employee.manage') then
    return new;
  end if;

  if new.organization_id is distinct from old.organization_id
    or new.user_id is distinct from old.user_id
    or new.employee_number is distinct from old.employee_number
    or new.external_payroll_id is distinct from old.external_payroll_id
    or new.first_name is distinct from old.first_name
    or new.middle_name is distinct from old.middle_name
    or new.last_name is distinct from old.last_name
    or new.work_email is distinct from old.work_email
    or new.status is distinct from old.status
    or new.hire_date is distinct from old.hire_date
    or new.probation_end_date is distinct from old.probation_end_date
    or new.termination_date is distinct from old.termination_date
    or new.termination_reason is distinct from old.termination_reason
    or new.created_at is distinct from old.created_at
  then
    raise exception using errcode = '42501', message = 'Only an HR administrator can change identity or employment fields';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Employee-number settings and allocation
-- ---------------------------------------------------------------------------

create table public.organization_employee_number_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  -- automatic: HaloManage generates numbers (an existing number may still
  --            be supplied for a migrated employee when allowed)
  -- manual:    HR always types the number
  mode text not null default 'automatic' check (mode in ('automatic', 'manual')),
  prefix text not null default 'EMP-' check (char_length(prefix) <= 20),
  padding integer not null default 4 check (padding between 0 and 12),
  starting_number bigint not null default 1 check (starting_number >= 0),
  next_sequence bigint not null default 1 check (next_sequence >= 0),
  allow_manual_override boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.organization_employee_number_settings enable row level security;
create trigger organization_employee_number_settings_set_updated_at
  before update on public.organization_employee_number_settings
  for each row execute function private.set_updated_at();

create policy "hr read employee number settings" on public.organization_employee_number_settings
  for select to authenticated
  using (private.has_permission(organization_id, 'employee.manage'));
-- Writes only through update_employee_record_settings() / allocation.
grant select on public.organization_employee_number_settings to authenticated;

create or replace function private.format_employee_number(p_prefix text, p_padding integer, p_sequence bigint)
returns text
language sql
immutable
set search_path = ''
as $$
  -- lpad() truncates when the value is longer than the pad width, so only
  -- pad when there is room: EMP- + 4 padding + 12345 must be EMP-12345,
  -- never EMP-1234.
  select coalesce(p_prefix, '') || case
    when char_length(p_sequence::text) >= coalesce(p_padding, 0) then p_sequence::text
    else lpad(p_sequence::text, p_padding, '0')
  end;
$$;

-- Existing organizations continue from their highest EMP-style number so
-- the first generated number never collides with what HR already typed.
insert into public.organization_employee_number_settings (organization_id, next_sequence)
select
  o.id,
  coalesce((
    select max((substring(e.employee_number from '^EMP-([0-9]{1,15})$'))::bigint) + 1
    from public.employees e
    where e.organization_id = o.id
      and e.employee_number ~ '^EMP-[0-9]{1,15}$'
  ), 1)
from public.organizations o
on conflict (organization_id) do nothing;

-- Serialized per organization by the settings row lock. Skips any number
-- already taken (migrated or manually entered) so allocation never fails
-- on a collision and never hands out a duplicate.
create or replace function private.allocate_employee_number(p_organization_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.organization_employee_number_settings;
  v_sequence bigint;
  v_candidate text;
  v_attempts integer := 0;
begin
  insert into public.organization_employee_number_settings (organization_id)
  values (p_organization_id)
  on conflict (organization_id) do nothing;

  select * into v_settings
  from public.organization_employee_number_settings
  where organization_id = p_organization_id
  for update;

  v_sequence := greatest(v_settings.next_sequence, v_settings.starting_number);
  loop
    v_candidate := private.format_employee_number(v_settings.prefix, v_settings.padding, v_sequence);
    exit when not exists (
      select 1 from public.employees
      where organization_id = p_organization_id and employee_number = v_candidate
    );
    v_sequence := v_sequence + 1;
    v_attempts := v_attempts + 1;
    if v_attempts > 100000 then
      raise exception 'Could not allocate a free employee number — review the numbering settings';
    end if;
  end loop;

  update public.organization_employee_number_settings
  set next_sequence = v_sequence + 1
  where organization_id = p_organization_id;

  return v_candidate;
end;
$$;

-- Read-only preview for the Add Employee dialog. Not a reservation: the
-- real number is allocated inside create_employee_record(), so two admins
-- previewing at once may both see EMP-0042, but only one receives it.
create or replace function public.preview_next_employee_number(p_organization_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_settings public.organization_employee_number_settings;
  v_sequence bigint;
  v_candidate text;
begin
  if not private.has_permission(p_organization_id, 'employee.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to manage this organization''s employees';
  end if;

  select * into v_settings from public.organization_employee_number_settings where organization_id = p_organization_id;
  if v_settings.organization_id is null then
    return private.format_employee_number('EMP-', 4, 1);
  end if;
  if v_settings.mode = 'manual' then
    return null;
  end if;

  v_sequence := greatest(v_settings.next_sequence, v_settings.starting_number);
  loop
    v_candidate := private.format_employee_number(v_settings.prefix, v_settings.padding, v_sequence);
    exit when not exists (
      select 1 from public.employees
      where organization_id = p_organization_id and employee_number = v_candidate
    );
    v_sequence := v_sequence + 1;
  end loop;
  return v_candidate;
end;
$$;

revoke execute on function public.preview_next_employee_number(uuid) from public, anon;
grant execute on function public.preview_next_employee_number(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Organization setup requirements
-- ---------------------------------------------------------------------------

-- The identity/employment/access checks in get_employee_setup_readiness()
-- are always mandatory. These flags decide which *additional* items an
-- organization treats as blocking — not every employer or jurisdiction
-- needs identical information before someone starts.
create table public.employee_setup_preferences (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  require_reporting_line boolean not null default true,
  require_onboarding_plan boolean not null default true,
  require_date_of_birth boolean not null default false,
  require_trn boolean not null default false,
  require_personal_email boolean not null default false,
  require_personal_phone boolean not null default false,
  require_home_address boolean not null default false,
  require_emergency_contact boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.employee_setup_preferences enable row level security;
create trigger employee_setup_preferences_set_updated_at
  before update on public.employee_setup_preferences
  for each row execute function private.set_updated_at();

create policy "hr read employee setup preferences" on public.employee_setup_preferences
  for select to authenticated
  using (private.has_permission(organization_id, 'employee.manage'));
grant select on public.employee_setup_preferences to authenticated;

create or replace function public.update_employee_record_settings(
  p_organization_id uuid,
  p_numbering jsonb default null,
  p_requirements jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_numbering jsonb;
  v_old_requirements jsonb;
  v_numbering public.organization_employee_number_settings;
  v_requirements public.employee_setup_preferences;
begin
  if not private.has_permission(p_organization_id, 'employee.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to manage this organization''s employee settings';
  end if;

  insert into public.organization_employee_number_settings (organization_id)
  values (p_organization_id) on conflict (organization_id) do nothing;
  insert into public.employee_setup_preferences (organization_id)
  values (p_organization_id) on conflict (organization_id) do nothing;

  select to_jsonb(s) into v_old_numbering from public.organization_employee_number_settings s where s.organization_id = p_organization_id for update;
  select to_jsonb(p) into v_old_requirements from public.employee_setup_preferences p where p.organization_id = p_organization_id for update;

  if p_numbering is not null then
    if p_numbering ? 'mode' and p_numbering->>'mode' not in ('automatic', 'manual') then
      raise exception using errcode = '22023', message = 'Numbering mode must be automatic or manual';
    end if;
    if p_numbering ? 'prefix' and char_length(coalesce(p_numbering->>'prefix', '')) > 20 then
      raise exception using errcode = '22023', message = 'The prefix can be at most 20 characters';
    end if;
    if p_numbering ? 'padding' and ((p_numbering->>'padding')::integer < 0 or (p_numbering->>'padding')::integer > 12) then
      raise exception using errcode = '22023', message = 'Padding must be between 0 and 12 digits';
    end if;
    if p_numbering ? 'next_sequence' and (p_numbering->>'next_sequence')::bigint < 0 then
      raise exception using errcode = '22023', message = 'The next number cannot be negative';
    end if;

    update public.organization_employee_number_settings
    set mode = coalesce(p_numbering->>'mode', mode),
        prefix = case when p_numbering ? 'prefix' then coalesce(p_numbering->>'prefix', '') else prefix end,
        padding = coalesce((p_numbering->>'padding')::integer, padding),
        next_sequence = coalesce((p_numbering->>'next_sequence')::bigint, next_sequence),
        allow_manual_override = coalesce((p_numbering->>'allow_manual_override')::boolean, allow_manual_override)
    where organization_id = p_organization_id
    returning * into v_numbering;
  else
    select * into v_numbering from public.organization_employee_number_settings where organization_id = p_organization_id;
  end if;

  if p_requirements is not null then
    update public.employee_setup_preferences
    set require_reporting_line = coalesce((p_requirements->>'require_reporting_line')::boolean, require_reporting_line),
        require_onboarding_plan = coalesce((p_requirements->>'require_onboarding_plan')::boolean, require_onboarding_plan),
        require_date_of_birth = coalesce((p_requirements->>'require_date_of_birth')::boolean, require_date_of_birth),
        require_trn = coalesce((p_requirements->>'require_trn')::boolean, require_trn),
        require_personal_email = coalesce((p_requirements->>'require_personal_email')::boolean, require_personal_email),
        require_personal_phone = coalesce((p_requirements->>'require_personal_phone')::boolean, require_personal_phone),
        require_home_address = coalesce((p_requirements->>'require_home_address')::boolean, require_home_address),
        require_emergency_contact = coalesce((p_requirements->>'require_emergency_contact')::boolean, require_emergency_contact)
    where organization_id = p_organization_id
    returning * into v_requirements;
  else
    select * into v_requirements from public.employee_setup_preferences where organization_id = p_organization_id;
  end if;

  perform private.log_audit_event(
    p_organization_id, 'EMPLOYEE_SETTINGS_UPDATED', 'organization', p_organization_id,
    jsonb_build_object('numbering', v_old_numbering, 'requirements', v_old_requirements),
    jsonb_build_object('numbering', to_jsonb(v_numbering), 'requirements', to_jsonb(v_requirements))
  );

  return jsonb_build_object('numbering', to_jsonb(v_numbering), 'requirements', to_jsonb(v_requirements));
end;
$$;

revoke execute on function public.update_employee_record_settings(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.update_employee_record_settings(uuid, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Government / compliance identifiers
-- ---------------------------------------------------------------------------

-- A row per identifier rather than a column per country: TRN and NIS for
-- Jamaica today, anything else an employer needs tomorrow, without ever
-- widening the directory-level employees table. Same audience as
-- employee_private: the employee themself (read-only — verified IDs are
-- HR controlled) and employee.manage. Never supervisors by default.
create table public.employee_identifiers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  identifier_type text not null check (identifier_type in (
    'trn', 'nis', 'national_id', 'passport', 'drivers_licence', 'other'
  )),
  -- Required for 'other' so the value is never an unlabeled number.
  label text,
  identifier_value text not null check (char_length(btrim(identifier_value)) between 1 and 100),
  country_code text,
  is_primary boolean not null default true,
  issued_on date,
  expires_on date,
  verified_at timestamptz,
  verified_by uuid references auth.users(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (identifier_type <> 'other' or char_length(btrim(coalesce(label, ''))) > 0),
  check (expires_on is null or issued_on is null or expires_on >= issued_on)
);
alter table public.employee_identifiers enable row level security;
create index employee_identifiers_employee_idx on public.employee_identifiers(employee_id);
create index employee_identifiers_org_idx on public.employee_identifiers(organization_id);
create unique index employee_identifiers_one_primary_per_type
  on public.employee_identifiers(employee_id, identifier_type)
  where is_primary and identifier_type <> 'other';
-- A TRN / NIS number identifies exactly one person; formatting (spaces,
-- hyphens) must not let the same number be entered twice.
create unique index employee_identifiers_unique_tax_numbers
  on public.employee_identifiers(organization_id, identifier_type, upper(regexp_replace(identifier_value, '[^0-9A-Za-z]', '', 'g')))
  where identifier_type in ('trn', 'nis');
create trigger employee_identifiers_set_updated_at
  before update on public.employee_identifiers
  for each row execute function private.set_updated_at();

create policy "read own identifiers" on public.employee_identifiers for select to authenticated
  using (employee_id = private.current_employee_id());
create policy "hr read identifiers" on public.employee_identifiers for select to authenticated
  using (private.has_permission(organization_id, 'employee.manage'));
create policy "hr manage identifiers" on public.employee_identifiers for all to authenticated
  using (private.has_permission(organization_id, 'employee.manage'))
  with check (
    private.has_permission(organization_id, 'employee.manage')
    and organization_id = (select e.organization_id from public.employees e where e.id = employee_id)
  );
grant select, insert, update, delete on public.employee_identifiers to authenticated;

create or replace function private.mask_identifier(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_value is null then null
    when char_length(p_value) <= 3 then '•••'
    else '•••' || right(p_value, 3)
  end;
$$;

-- Verification is stamped by the database: a changed value is no longer
-- verified, and verified_by is always the real caller.
create or replace function private.employee_identifiers_stamp()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
    if new.verified_at is not null then
      new.verified_by := auth.uid();
    end if;
    return new;
  end if;

  if new.identifier_value is distinct from old.identifier_value
     and new.verified_at is not distinct from old.verified_at then
    new.verified_at := null;
    new.verified_by := null;
  elsif new.verified_at is not null and old.verified_at is null then
    new.verified_by := auth.uid();
  elsif new.verified_at is null then
    new.verified_by := null;
  end if;
  return new;
end;
$$;

create trigger employee_identifiers_stamp
  before insert or update on public.employee_identifiers
  for each row execute function private.employee_identifiers_stamp();

create or replace function private.employee_identifiers_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.employee_identifiers := coalesce(new, old);
  v_action text;
begin
  v_action := case
    when tg_op = 'INSERT' then 'EMPLOYEE_IDENTIFIER_ADDED'
    when tg_op = 'DELETE' then 'EMPLOYEE_IDENTIFIER_REMOVED'
    when new.verified_at is not null and old.verified_at is null
         and new.identifier_value is not distinct from old.identifier_value then 'EMPLOYEE_IDENTIFIER_VERIFIED'
    else 'EMPLOYEE_IDENTIFIER_UPDATED'
  end;

  -- Masked, never the full value (see comment on public.audit_events).
  perform private.log_audit_event(
    v_row.organization_id, v_action, 'employee', v_row.employee_id,
    case when tg_op in ('UPDATE', 'DELETE') then jsonb_build_object(
      'identifier_type', old.identifier_type, 'value', private.mask_identifier(old.identifier_value),
      'verified', old.verified_at is not null
    ) end,
    case when tg_op in ('INSERT', 'UPDATE') then jsonb_build_object(
      'identifier_id', new.id, 'identifier_type', new.identifier_type, 'label', new.label,
      'value', private.mask_identifier(new.identifier_value), 'verified', new.verified_at is not null
    ) end
  );
  return null;
end;
$$;

create trigger employee_identifiers_audit
  after insert or update or delete on public.employee_identifiers
  for each row execute function private.employee_identifiers_audit();

-- Carry any existing employee_private.national_id forward so HR sees it in
-- the new Government IDs section. The old column is left in place (not
-- dropped) for backward compatibility with already-deployed clients.
insert into public.employee_identifiers (organization_id, employee_id, identifier_type, identifier_value)
select ep.organization_id, ep.employee_id, 'national_id', btrim(ep.national_id)
from public.employee_private ep
where nullif(btrim(ep.national_id), '') is not null
  and not exists (
    select 1 from public.employee_identifiers ei
    where ei.employee_id = ep.employee_id and ei.identifier_type = 'national_id'
  );

-- ---------------------------------------------------------------------------
-- 5. Emergency contacts
-- ---------------------------------------------------------------------------

create table public.employee_emergency_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  full_name text not null check (char_length(btrim(full_name)) between 1 and 200),
  relationship text,
  phone text,
  alternate_phone text,
  email citext,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.employee_emergency_contacts enable row level security;
create index employee_emergency_contacts_employee_idx on public.employee_emergency_contacts(employee_id);
create unique index employee_emergency_contacts_one_primary
  on public.employee_emergency_contacts(employee_id) where is_primary;
create trigger employee_emergency_contacts_set_updated_at
  before update on public.employee_emergency_contacts
  for each row execute function private.set_updated_at();

-- Employee-editable (blueprint §16) as well as HR-managed.
create policy "read own emergency contacts" on public.employee_emergency_contacts for select to authenticated
  using (employee_id = private.current_employee_id());
create policy "manage own emergency contacts" on public.employee_emergency_contacts for all to authenticated
  using (employee_id = private.current_employee_id())
  with check (
    employee_id = private.current_employee_id()
    and organization_id = (select e.organization_id from public.employees e where e.id = employee_id)
  );
create policy "hr manage emergency contacts" on public.employee_emergency_contacts for all to authenticated
  using (private.has_permission(organization_id, 'employee.manage'))
  with check (
    private.has_permission(organization_id, 'employee.manage')
    and organization_id = (select e.organization_id from public.employees e where e.id = employee_id)
  );
grant select, insert, update, delete on public.employee_emergency_contacts to authenticated;

insert into public.employee_emergency_contacts (organization_id, employee_id, full_name, relationship, phone, is_primary)
select ep.organization_id, ep.employee_id, btrim(ep.emergency_contact_name), ep.emergency_contact_relationship, ep.emergency_contact_phone, true
from public.employee_private ep
where nullif(btrim(ep.emergency_contact_name), '') is not null
  and not exists (select 1 from public.employee_emergency_contacts c where c.employee_id = ep.employee_id);

comment on column public.employee_private.emergency_contact_name is
  'Superseded by public.employee_emergency_contacts (backfilled 2026-09-10); kept for compatibility, no longer written by the app.';

create or replace function private.employee_emergency_contacts_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.employee_emergency_contacts := coalesce(new, old);
begin
  perform private.log_audit_event(
    v_row.organization_id,
    case tg_op when 'INSERT' then 'EMERGENCY_CONTACT_ADDED' when 'DELETE' then 'EMERGENCY_CONTACT_REMOVED' else 'EMERGENCY_CONTACT_UPDATED' end,
    'employee', v_row.employee_id, null,
    jsonb_build_object('contact_id', v_row.id, 'relationship', v_row.relationship, 'is_primary', v_row.is_primary)
  );
  return null;
end;
$$;

create trigger employee_emergency_contacts_audit
  after insert or update or delete on public.employee_emergency_contacts
  for each row execute function private.employee_emergency_contacts_audit();

-- Personal information changes are audited by *field name* only.
create or replace function private.employee_private_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fields text[];
begin
  select coalesce(array_agg(n.key order by n.key), '{}')
  into v_fields
  from jsonb_each(to_jsonb(new)) n
  where n.key not in ('updated_at', 'employee_id', 'organization_id')
    and (tg_op = 'INSERT' or n.value is distinct from (to_jsonb(old) -> n.key))
    and (tg_op = 'UPDATE' or n.value <> 'null'::jsonb);

  if cardinality(v_fields) = 0 then
    return null;
  end if;

  perform private.log_audit_event(
    new.organization_id, 'EMPLOYEE_PERSONAL_INFO_UPDATED', 'employee', new.employee_id,
    null, jsonb_build_object('fields', to_jsonb(v_fields))
  );
  return null;
end;
$$;

create trigger employee_private_audit
  after insert or update on public.employee_private
  for each row execute function private.employee_private_audit();

create or replace function private.employees_number_change_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.log_audit_event(
    new.organization_id, 'EMPLOYEE_NUMBER_CHANGED', 'employee', new.id,
    jsonb_build_object('employee_number', old.employee_number),
    jsonb_build_object('employee_number', new.employee_number)
  );
  return null;
end;
$$;

create trigger employees_number_change_audit
  after update of employee_number on public.employees
  for each row
  when (old.employee_number is distinct from new.employee_number)
  execute function private.employees_number_change_audit();

-- ---------------------------------------------------------------------------
-- 6. Prepared access and onboarding (before an Auth account exists)
-- ---------------------------------------------------------------------------

-- role_assignments needs an auth user_id, which a pre-hire does not have.
-- HR's decision is stored here and applied by link_invited_employee_account()
-- in the same transaction that links the account, so the employee never
-- holds an accidental default role while HR is still deciding.
create table public.employee_access_setup (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  pending_role public.app_role default 'employee',
  pending_custom_role_id uuid references public.organization_roles(id) on delete set null,
  configured_by uuid references auth.users(id),
  configured_at timestamptz,
  onboarding_template_id uuid references public.onboarding_templates(id) on delete set null,
  onboarding_was_recommended boolean not null default false,
  onboarding_selected_by uuid references auth.users(id),
  onboarding_selected_at timestamptz,
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (pending_role is null or pending_custom_role_id is null)
);
alter table public.employee_access_setup enable row level security;
create index employee_access_setup_org_idx on public.employee_access_setup(organization_id);
create trigger employee_access_setup_set_updated_at
  before update on public.employee_access_setup
  for each row execute function private.set_updated_at();

create policy "hr read employee access setup" on public.employee_access_setup for select to authenticated
  using (private.has_permission(organization_id, 'employee.manage'));
-- Writes only through prepare_employee_access()/set_employee_onboarding_plan().
grant select on public.employee_access_setup to authenticated;

create or replace function public.prepare_employee_access(
  p_employee_id uuid,
  p_role public.app_role default null,
  p_custom_role_id uuid default null
)
returns public.employee_access_setup
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  v_setup public.employee_access_setup;
begin
  select * into v_employee from public.employees where id = p_employee_id for update;
  if v_employee.id is null then
    raise exception 'Employee not found';
  end if;
  if not private.has_permission(v_employee.organization_id, 'employee.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to manage this organization''s employees';
  end if;
  if (p_role is null) = (p_custom_role_id is null) then
    raise exception using errcode = '22023', message = 'Choose exactly one built-in role or one custom role';
  end if;
  -- Preparing anything above baseline access is a role grant in waiting,
  -- so it needs the same permission as granting a role directly —
  -- otherwise employee.manage alone could stage an Admin account.
  if (p_custom_role_id is not null or p_role <> 'employee')
     and not private.has_permission(v_employee.organization_id, 'roles.manage') then
    raise exception using errcode = '42501', message = 'Only someone who can manage roles can prepare elevated access';
  end if;
  if p_custom_role_id is not null and not exists (
    select 1 from public.organization_roles r
    where r.id = p_custom_role_id and r.organization_id = v_employee.organization_id and r.is_active
  ) then
    raise exception using errcode = '23514', message = 'That role is not available for this organization';
  end if;
  if v_employee.status = 'terminated' then
    raise exception using errcode = '23514', message = 'A terminated employee cannot be given access';
  end if;

  -- Already has an account: the prepared role *is* the live role.
  if v_employee.user_id is not null then
    perform public.set_member_role(p_employee_id, p_role, null, p_custom_role_id);
  end if;

  insert into public.employee_access_setup (
    employee_id, organization_id, pending_role, pending_custom_role_id, configured_by, configured_at,
    applied_at
  ) values (
    p_employee_id, v_employee.organization_id, p_role, p_custom_role_id, auth.uid(), now(),
    case when v_employee.user_id is not null then now() end
  )
  on conflict (employee_id) do update
  set pending_role = excluded.pending_role,
      pending_custom_role_id = excluded.pending_custom_role_id,
      configured_by = excluded.configured_by,
      configured_at = excluded.configured_at,
      applied_at = coalesce(excluded.applied_at, public.employee_access_setup.applied_at)
  returning * into v_setup;

  perform private.log_audit_event(
    v_employee.organization_id, 'EMPLOYEE_ACCESS_PREPARED', 'employee', p_employee_id, null,
    jsonb_build_object('role', p_role, 'custom_role_id', p_custom_role_id)
  );
  return v_setup;
end;
$$;

revoke execute on function public.prepare_employee_access(uuid, public.app_role, uuid) from public, anon;
grant execute on function public.prepare_employee_access(uuid, public.app_role, uuid) to authenticated;

create or replace function public.set_employee_onboarding_plan(
  p_employee_id uuid,
  p_template_id uuid,
  p_was_recommended boolean default false
)
returns public.employee_access_setup
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  v_setup public.employee_access_setup;
begin
  select * into v_employee from public.employees where id = p_employee_id;
  if v_employee.id is null then
    raise exception 'Employee not found';
  end if;
  if not private.has_permission(v_employee.organization_id, 'employee.manage')
     and not private.has_permission(v_employee.organization_id, 'onboarding.manage_team') then
    raise exception using errcode = '42501', message = 'Not authorized to plan onboarding for this employee';
  end if;
  if p_template_id is not null and not exists (
    select 1
    from public.onboarding_templates t
    join public.onboarding_template_versions v on v.template_id = t.id and v.is_current
    where t.id = p_template_id and t.organization_id = v_employee.organization_id and t.is_active
  ) then
    raise exception using errcode = '23514', message = 'That onboarding template is not available (inactive or has no published version)';
  end if;

  insert into public.employee_access_setup (
    employee_id, organization_id, onboarding_template_id, onboarding_was_recommended,
    onboarding_selected_by, onboarding_selected_at
  ) values (
    p_employee_id, v_employee.organization_id, p_template_id, coalesce(p_was_recommended, false),
    auth.uid(), now()
  )
  on conflict (employee_id) do update
  set onboarding_template_id = excluded.onboarding_template_id,
      onboarding_was_recommended = excluded.onboarding_was_recommended,
      onboarding_selected_by = excluded.onboarding_selected_by,
      onboarding_selected_at = excluded.onboarding_selected_at
  returning * into v_setup;

  perform private.log_audit_event(
    v_employee.organization_id, 'ONBOARDING_TEMPLATE_ASSIGNED', 'employee', p_employee_id, null,
    jsonb_build_object('template_id', p_template_id, 'recommended', coalesce(p_was_recommended, false))
  );
  return v_setup;
end;
$$;

revoke execute on function public.set_employee_onboarding_plan(uuid, uuid, boolean) from public, anon;
grant execute on function public.set_employee_onboarding_plan(uuid, uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. create_employee_record()
-- ---------------------------------------------------------------------------

create or replace function public.create_employee_record(
  p_organization_id uuid,
  p_first_name text,
  p_last_name text,
  p_work_email text default null,
  p_existing_employee_number text default null,
  p_middle_name text default null,
  p_preferred_name text default null,
  p_work_phone text default null
)
returns public.employees
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.organization_employee_number_settings;
  v_number text := nullif(btrim(coalesce(p_existing_employee_number, '')), '');
  v_source text;
  v_employee public.employees;
begin
  if not private.has_permission(p_organization_id, 'employee.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to create employees in this organization';
  end if;
  if nullif(btrim(coalesce(p_first_name, '')), '') is null or nullif(btrim(coalesce(p_last_name, '')), '') is null then
    raise exception using errcode = '22023', message = 'First and last name are required';
  end if;

  insert into public.organization_employee_number_settings (organization_id)
  values (p_organization_id) on conflict (organization_id) do nothing;
  -- Row lock serializes concurrent creates for this organization, so the
  -- uniqueness check below and the allocation cannot race each other.
  select * into v_settings
  from public.organization_employee_number_settings
  where organization_id = p_organization_id
  for update;

  if v_number is not null then
    if v_settings.mode = 'automatic' and not v_settings.allow_manual_override then
      raise exception using errcode = '23514', message = 'This organization only uses automatically generated employee numbers';
    end if;
    if char_length(v_number) > 50 then
      raise exception using errcode = '22023', message = 'Employee numbers can be at most 50 characters';
    end if;
    if exists (select 1 from public.employees where organization_id = p_organization_id and employee_number = v_number) then
      raise exception using errcode = '23505', message = format('Employee number %s is already in use', v_number);
    end if;
    v_source := case when v_settings.mode = 'manual' then 'manual' else 'existing' end;
  else
    if v_settings.mode = 'manual' then
      raise exception using errcode = '22023', message = 'This organization enters employee numbers manually — please provide one';
    end if;
    v_number := private.allocate_employee_number(p_organization_id);
    v_source := 'generated';
  end if;

  insert into public.employees (
    organization_id, employee_number, first_name, middle_name, last_name, preferred_name,
    work_email, work_phone, status
  ) values (
    p_organization_id, v_number, btrim(p_first_name), nullif(btrim(coalesce(p_middle_name, '')), ''),
    btrim(p_last_name), nullif(btrim(coalesce(p_preferred_name, '')), ''),
    nullif(btrim(coalesce(p_work_email, '')), ''), nullif(btrim(coalesce(p_work_phone, '')), ''), 'prehire'
  )
  returning * into v_employee;

  -- The setup record exists from the start; configured_at stays null until
  -- HR actually confirms the portal role, which readiness requires.
  insert into public.employee_access_setup (employee_id, organization_id)
  values (v_employee.id, p_organization_id)
  on conflict (employee_id) do nothing;

  perform private.log_audit_event(
    p_organization_id, 'EMPLOYEE_CREATED', 'employee', v_employee.id, null,
    jsonb_build_object('employee_number', v_number, 'first_name', v_employee.first_name,
      'last_name', v_employee.last_name, 'status', v_employee.status)
  );
  perform private.log_audit_event(
    p_organization_id, 'EMPLOYEE_NUMBER_ASSIGNED', 'employee', v_employee.id, null,
    jsonb_build_object('employee_number', v_number, 'source', v_source)
  );
  return v_employee;
end;
$$;

revoke execute on function public.create_employee_record(uuid, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.create_employee_record(uuid, text, text, text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Onboarding: anchors, phases, assignee backfill, skip/cancel, read_team
-- ---------------------------------------------------------------------------

alter table public.onboarding_template_steps
  add column if not exists due_anchor text not null default 'run_start'
    check (due_anchor in ('run_start', 'hire_date', 'invitation_date', 'probation_end_date')),
  add column if not exists phase text
    check (phase in ('preboarding', 'first_day', 'first_week', 'first_30_days', 'probation'));

alter table public.onboarding_tasks
  add column if not exists due_anchor text not null default 'run_start'
    check (due_anchor in ('run_start', 'hire_date', 'invitation_date', 'probation_end_date')),
  add column if not exists due_offset_days integer,
  add column if not exists phase text
    check (phase in ('preboarding', 'first_day', 'first_week', 'first_30_days', 'probation'));

alter table public.onboarding_runs
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid references auth.users(id),
  add column if not exists cancel_reason text;

-- Evidence attached to a task: files live in the normal document system
-- (never base64 in completion_data) and are referenced from here.
create table public.onboarding_task_documents (
  task_id uuid not null references public.onboarding_tasks(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  attached_by uuid references auth.users(id),
  attached_at timestamptz not null default now(),
  primary key (task_id, document_id)
);
alter table public.onboarding_task_documents enable row level security;
create index onboarding_task_documents_org_idx on public.onboarding_task_documents(organization_id);
grant select on public.onboarding_task_documents to authenticated;

create or replace function private.onboarding_anchor_date(
  p_anchor text,
  p_employee public.employees,
  p_run_start date
)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select case p_anchor
    when 'run_start' then p_run_start
    when 'hire_date' then p_employee.hire_date
    when 'probation_end_date' then p_employee.probation_end_date
    when 'invitation_date' then (
      select coalesce(u.invited_at, u.created_at)::date from auth.users u where u.id = p_employee.user_id
    )
  end;
$$;

-- Core instantiation, separated from the permission check so the
-- service-role invitation path can start a *prepared* plan (HR's
-- authorization was checked when they selected it).
create or replace function private.instantiate_onboarding_run(
  p_employee_id uuid,
  p_template_id uuid,
  p_actor uuid
)
returns public.onboarding_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  v_version public.onboarding_template_versions;
  v_run public.onboarding_runs;
  v_supervisor_employee uuid;
  v_manager_employee uuid;
  step record;
  v_assignee uuid;
begin
  select * into v_employee from public.employees where id = p_employee_id;
  if v_employee.id is null then
    raise exception 'Employee not found';
  end if;

  select v.* into v_version
  from public.onboarding_template_versions v
  join public.onboarding_templates t on t.id = v.template_id
  where t.organization_id = v_employee.organization_id
    and v.is_current
    and (p_template_id is null or t.id = p_template_id)
    and (p_template_id is not null or t.is_default)
  order by v.published_at desc
  limit 1;

  if v_version.id is null then
    raise exception 'No current onboarding template version found';
  end if;

  insert into public.onboarding_runs (organization_id, employee_id, template_version_id, created_by)
  values (v_employee.organization_id, p_employee_id, v_version.id, p_actor)
  returning * into v_run;

  select supervisor_employee_id, manager_employee_id
  into v_supervisor_employee, v_manager_employee
  from public.employee_assignments where employee_id = p_employee_id and end_date is null;

  for step in
    select * from public.onboarding_template_steps
    where template_version_id = v_version.id order by sequence asc
  loop
    v_assignee := case step.assignee_type
      when 'employee' then v_employee.user_id
      when 'supervisor' then (select user_id from public.employees where id = v_supervisor_employee)
      when 'manager' then (select user_id from public.employees where id = v_manager_employee)
      else null
    end;

    insert into public.onboarding_tasks (
      run_id, template_step_id, organization_id, employee_id, title, description, step_type,
      assignee_type, assigned_to_user_id, sequence, due_date, required, dependency_step_ids,
      requires_signature, due_anchor, due_offset_days, phase
    )
    values (
      v_run.id, step.id, v_employee.organization_id, p_employee_id, step.title, step.description, step.step_type,
      step.assignee_type, v_assignee, step.sequence,
      private.onboarding_anchor_date(step.due_anchor, v_employee, v_run.started_at::date) + step.due_offset_days,
      step.required, step.dependency_step_ids, step.requires_signature,
      step.due_anchor, step.due_offset_days, step.phase
    );
  end loop;

  perform private.log_audit_event(
    v_employee.organization_id, 'ONBOARDING_STARTED', 'onboarding_run', v_run.id, null,
    to_jsonb(v_run) || jsonb_build_object('template_id', v_version.template_id, 'version_number', v_version.version_number)
  );

  return v_run;
end;
$$;

create or replace function public.start_onboarding(p_employee_id uuid, p_template_id uuid default null)
returns public.onboarding_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.employees where id = p_employee_id;
  if v_org is null then
    raise exception 'Employee not found';
  end if;

  if not private.has_permission(v_org, 'onboarding.manage_team')
     and not private.has_permission(v_org, 'employee.manage')
  then
    raise exception 'Not authorized to start onboarding';
  end if;

  return private.instantiate_onboarding_run(p_employee_id, p_template_id, auth.uid());
end;
$$;

-- Employee tasks created before the employee had an account (a run started
-- during preboarding) and supervisor/manager tasks created before the
-- reporting line — or the leader's account — existed would otherwise stay
-- unassigned forever. Re-resolves every still-open task that concerns this
-- employee, either as the onboardee or as their supervisor/manager.
create or replace function private.resolve_onboarding_assignees(p_employee_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with resolved as (
    select t.id,
      case t.assignee_type
        when 'employee' then e.user_id
        when 'supervisor' then sup.user_id
        when 'manager' then mgr.user_id
      end as user_id
    from public.onboarding_tasks t
    join public.onboarding_runs r on r.id = t.run_id and r.status = 'in_progress'
    join public.employees e on e.id = t.employee_id
    left join public.employee_assignments a on a.employee_id = e.id and a.end_date is null
    left join public.employees sup on sup.id = a.supervisor_employee_id
    left join public.employees mgr on mgr.id = a.manager_employee_id
    where t.status not in ('completed', 'skipped')
      and t.assignee_type in ('employee', 'supervisor', 'manager')
      and (t.employee_id = p_employee_id or a.supervisor_employee_id = p_employee_id or a.manager_employee_id = p_employee_id)
  )
  update public.onboarding_tasks t
  set assigned_to_user_id = resolved.user_id
  from resolved
  where t.id = resolved.id
    and resolved.user_id is not null
    and t.assigned_to_user_id is distinct from resolved.user_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Due dates follow the employee's real dates: moving the start date moves
-- every still-open hire-date-anchored task with it.
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
  set due_date = private.onboarding_anchor_date(t.due_anchor, e, r.started_at::date) + t.due_offset_days
  from public.onboarding_runs r, public.employees e
  where t.employee_id = p_employee_id
    and r.id = t.run_id
    and e.id = t.employee_id
    and r.status = 'in_progress'
    and t.status not in ('completed', 'skipped')
    and t.due_offset_days is not null
    and t.due_date is distinct from (private.onboarding_anchor_date(t.due_anchor, e, r.started_at::date) + t.due_offset_days);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function private.onboarding_follow_employee_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.resolve_onboarding_assignees(new.id);
  perform private.recompute_onboarding_due_dates(new.id);
  return null;
end;
$$;

create trigger employees_onboarding_follow_changes
  after update of hire_date, probation_end_date, user_id on public.employees
  for each row
  when (
    old.hire_date is distinct from new.hire_date
    or old.probation_end_date is distinct from new.probation_end_date
    or old.user_id is distinct from new.user_id
  )
  execute function private.onboarding_follow_employee_changes();

create or replace function private.onboarding_follow_assignment_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.end_date is null then
    perform private.resolve_onboarding_assignees(new.employee_id);
  end if;
  return null;
end;
$$;

create trigger employee_assignments_onboarding_follow_changes
  after insert or update of supervisor_employee_id, manager_employee_id, end_date on public.employee_assignments
  for each row execute function private.onboarding_follow_assignment_changes();

create or replace function private.maybe_complete_onboarding_run(p_run_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.onboarding_runs;
begin
  if exists (
    select 1 from public.onboarding_tasks
    where run_id = p_run_id and required and status not in ('completed', 'skipped')
  ) then
    return false;
  end if;

  update public.onboarding_runs
  set status = 'completed', completed_at = now()
  where id = p_run_id and status = 'in_progress'
  returning * into v_run;

  if v_run.id is not null then
    perform private.log_audit_event(
      v_run.organization_id, 'ONBOARDING_COMPLETED', 'onboarding_run', v_run.id, null,
      jsonb_build_object('employee_id', v_run.employee_id, 'completed_at', v_run.completed_at)
    );
  end if;
  return v_run.id is not null;
end;
$$;

create or replace function public.complete_onboarding_task(
  p_task_id uuid,
  p_completion_data jsonb default null
)
returns public.onboarding_tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.onboarding_tasks;
  v_run_status text;
  v_incomplete_deps integer;
begin
  select * into v_task
  from public.onboarding_tasks
  where id = p_task_id
  for update;

  if v_task.id is null then
    raise exception 'Onboarding task not found';
  end if;
  if v_task.status = 'completed' then
    return v_task;
  end if;

  if v_task.assigned_to_user_id is distinct from (select auth.uid())
     and not private.has_permission(v_task.organization_id, 'onboarding.manage_team')
  then
    raise exception using errcode = '42501', message = 'Not authorized to complete this task';
  end if;

  select status into v_run_status from public.onboarding_runs where id = v_task.run_id;
  if v_run_status = 'cancelled' then
    raise exception using errcode = '23514', message = 'This onboarding was cancelled';
  end if;

  if array_length(v_task.dependency_step_ids, 1) > 0 then
    select count(*) into v_incomplete_deps
    from public.onboarding_tasks t
    where t.run_id = v_task.run_id
      and t.template_step_id = any(v_task.dependency_step_ids)
      and t.status not in ('completed', 'skipped');
    if v_incomplete_deps > 0 then
      raise exception 'This task has incomplete prerequisite steps';
    end if;
  end if;

  update public.onboarding_tasks
  set status = 'completed',
      completed_at = now(),
      completed_by = auth.uid(),
      completion_data = p_completion_data,
      signed_at = case when v_task.requires_signature then now() else signed_at end
  where id = p_task_id
  returning * into v_task;

  perform private.log_audit_event(
    v_task.organization_id, 'ONBOARDING_TASK_COMPLETED', 'onboarding_task',
    v_task.id, null, to_jsonb(v_task)
  );
  perform private.maybe_complete_onboarding_run(v_task.run_id);
  return v_task;
end;
$$;

create or replace function public.skip_onboarding_task(p_task_id uuid, p_reason text)
returns public.onboarding_tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.onboarding_tasks;
begin
  select * into v_task from public.onboarding_tasks where id = p_task_id for update;
  if v_task.id is null then
    raise exception 'Onboarding task not found';
  end if;
  if not private.has_permission(v_task.organization_id, 'onboarding.manage_team') then
    raise exception using errcode = '42501', message = 'Not authorized to skip onboarding tasks';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception using errcode = '22023', message = 'Give a reason for skipping this step';
  end if;
  if v_task.status in ('completed', 'skipped') then
    raise exception using errcode = '23514', message = 'This step is already closed';
  end if;
  if (select status from public.onboarding_runs where id = v_task.run_id) <> 'in_progress' then
    raise exception using errcode = '23514', message = 'This onboarding is no longer in progress';
  end if;

  update public.onboarding_tasks
  set status = 'skipped', completed_at = now(), completed_by = auth.uid(),
      completion_data = coalesce(completion_data, '{}'::jsonb) || jsonb_build_object('skip_reason', btrim(p_reason))
  where id = p_task_id
  returning * into v_task;

  perform private.log_audit_event(
    v_task.organization_id, 'ONBOARDING_TASK_SKIPPED', 'onboarding_task', v_task.id, null,
    jsonb_build_object('title', v_task.title, 'reason', btrim(p_reason), 'employee_id', v_task.employee_id)
  );
  perform private.maybe_complete_onboarding_run(v_task.run_id);
  return v_task;
end;
$$;

revoke execute on function public.skip_onboarding_task(uuid, text) from public, anon;
grant execute on function public.skip_onboarding_task(uuid, text) to authenticated;

-- Cancelling keeps the run and every task exactly as they were — the
-- record is permanent; only its status changes.
create or replace function public.cancel_onboarding_run(p_run_id uuid, p_reason text)
returns public.onboarding_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.onboarding_runs;
begin
  select * into v_run from public.onboarding_runs where id = p_run_id for update;
  if v_run.id is null then
    raise exception 'Onboarding run not found';
  end if;
  if not private.has_permission(v_run.organization_id, 'onboarding.manage_team')
     and not private.has_permission(v_run.organization_id, 'employee.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to cancel onboarding';
  end if;
  if v_run.status <> 'in_progress' then
    raise exception using errcode = '23514', message = 'Only onboarding in progress can be cancelled';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception using errcode = '22023', message = 'Give a reason for cancelling';
  end if;

  update public.onboarding_runs
  set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = btrim(p_reason)
  where id = p_run_id
  returning * into v_run;

  perform private.log_audit_event(
    v_run.organization_id, 'ONBOARDING_CANCELLED', 'onboarding_run', v_run.id, null,
    jsonb_build_object('employee_id', v_run.employee_id, 'reason', v_run.cancel_reason)
  );
  return v_run;
end;
$$;

revoke execute on function public.cancel_onboarding_run(uuid, text) from public, anon;
grant execute on function public.cancel_onboarding_run(uuid, text) to authenticated;

create or replace function public.attach_onboarding_task_document(p_task_id uuid, p_document_id uuid)
returns public.onboarding_task_documents
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.onboarding_tasks;
  v_document public.documents;
  v_row public.onboarding_task_documents;
begin
  select * into v_task from public.onboarding_tasks where id = p_task_id;
  if v_task.id is null then
    raise exception 'Onboarding task not found';
  end if;
  if v_task.assigned_to_user_id is distinct from (select auth.uid())
     and not private.has_permission(v_task.organization_id, 'onboarding.manage_team')
     and not private.has_permission(v_task.organization_id, 'employee.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to attach evidence to this task';
  end if;
  select * into v_document from public.documents where id = p_document_id;
  if v_document.id is null or v_document.organization_id <> v_task.organization_id
     or (v_document.employee_id is not null and v_document.employee_id <> v_task.employee_id) then
    raise exception using errcode = '23514', message = 'That document does not belong to this employee''s record';
  end if;

  insert into public.onboarding_task_documents (task_id, document_id, organization_id, attached_by)
  values (p_task_id, p_document_id, v_task.organization_id, auth.uid())
  on conflict (task_id, document_id) do update set attached_at = public.onboarding_task_documents.attached_at
  returning * into v_row;

  perform private.log_audit_event(
    v_task.organization_id, 'ONBOARDING_EVIDENCE_ATTACHED', 'onboarding_task', p_task_id, null,
    jsonb_build_object('document_id', p_document_id, 'title', v_document.title)
  );
  return v_row;
end;
$$;

revoke execute on function public.attach_onboarding_task_document(uuid, uuid) from public, anon;
grant execute on function public.attach_onboarding_task_document(uuid, uuid) to authenticated;

-- Monitor without modify: onboarding.read_team sees runs/tasks within the
-- holder's management scope — never HR-only data (employee_private and
-- employee_identifiers stay employee.manage-only).
create policy "read team onboarding runs (monitor)" on public.onboarding_runs for select to authenticated
  using (private.has_permission(organization_id, 'onboarding.read_team') and private.in_management_scope(employee_id));
create policy "read team onboarding tasks (monitor)" on public.onboarding_tasks for select to authenticated
  using (private.has_permission(organization_id, 'onboarding.read_team') and private.in_management_scope(employee_id));

create policy "read task evidence" on public.onboarding_task_documents for select to authenticated
  using (exists (select 1 from public.onboarding_tasks t where t.id = task_id));

insert into public.role_permissions (organization_id, role, permission)
select null, r.role, 'onboarding.read_team'::public.app_permission
from (values ('supervisor'::public.app_role), ('manager'::public.app_role), ('admin'::public.app_role)) as r(role)
where not exists (
  select 1 from public.role_permissions rp
  where rp.organization_id is null and rp.role = r.role and rp.permission = 'onboarding.read_team'
);

-- Template targeting. applies_to keys (all optional; an absent or empty
-- key matches everyone): department_ids (org_unit_ids accepted as an
-- alias), position_ids, location_ids, employment_types. A template matches
-- only if every key it sets matches; the most specific match wins, then
-- the organization default.
create or replace function private.recommend_onboarding_template(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  v_assignment public.employee_assignments;
  v_best record;
begin
  select * into v_employee from public.employees where id = p_employee_id;
  select * into v_assignment from public.employee_assignments where employee_id = p_employee_id and end_date is null;

  select t.id, t.name, t.is_default, m.matched, m.score
  into v_best
  from public.onboarding_templates t
  join public.onboarding_template_versions v on v.template_id = t.id and v.is_current
  cross join lateral (
    select
      coalesce(t.applies_to->'department_ids', t.applies_to->'org_unit_ids', '[]'::jsonb) as departments,
      coalesce(t.applies_to->'position_ids', '[]'::jsonb) as positions,
      coalesce(t.applies_to->'location_ids', '[]'::jsonb) as locations,
      coalesce(t.applies_to->'employment_types', '[]'::jsonb) as employment_types
  ) f
  cross join lateral (
    select
      array_remove(array[
        case when jsonb_array_length(f.departments) > 0 then 'department' end,
        case when jsonb_array_length(f.positions) > 0 then 'position' end,
        case when jsonb_array_length(f.locations) > 0 then 'location' end,
        case when jsonb_array_length(f.employment_types) > 0 then 'employment type' end
      ], null) as matched,
      (jsonb_array_length(f.departments) > 0)::int + (jsonb_array_length(f.positions) > 0)::int
        + (jsonb_array_length(f.locations) > 0)::int + (jsonb_array_length(f.employment_types) > 0)::int as score
  ) m
  where t.organization_id = v_employee.organization_id
    and t.is_active
    and (jsonb_array_length(f.departments) = 0 or f.departments ? coalesce(v_assignment.org_unit_id::text, ''))
    and (jsonb_array_length(f.positions) = 0 or f.positions ? coalesce(v_assignment.position_id::text, ''))
    and (jsonb_array_length(f.locations) = 0 or f.locations ? coalesce(v_assignment.location_id::text, ''))
    and (jsonb_array_length(f.employment_types) = 0 or f.employment_types ? coalesce(v_assignment.employment_type, ''))
  order by m.score desc, t.is_default desc, t.created_at asc
  limit 1;

  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'template_id', v_best.id,
    'template_name', v_best.name,
    'matched_on', to_jsonb(v_best.matched),
    'reason', case
      when v_best.score > 0 then 'Matches this employee''s ' || array_to_string(v_best.matched, ', ')
      when v_best.is_default then 'Your organization''s default onboarding plan'
      else 'Applies to every employee'
    end
  );
end;
$$;

create or replace function public.recommend_onboarding_template(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.employees where id = p_employee_id;
  if v_org is null then
    raise exception 'Employee not found';
  end if;
  if not private.has_permission(v_org, 'employee.manage')
     and not private.has_permission(v_org, 'onboarding.manage_team') then
    raise exception using errcode = '42501', message = 'Not authorized to plan onboarding for this employee';
  end if;
  return private.recommend_onboarding_template(p_employee_id);
end;
$$;

revoke execute on function public.recommend_onboarding_template(uuid) from public, anon;
grant execute on function public.recommend_onboarding_template(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. Setup readiness — the single source of truth
-- ---------------------------------------------------------------------------

create or replace function private.setup_item(
  p_code text, p_label text, p_section text, p_required boolean, p_complete boolean
)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'code', p_code, 'label', p_label, 'section', p_section,
    'required', p_required, 'complete', coalesce(p_complete, false),
    'message', p_label || ' is missing'
  );
$$;

create or replace function private.employee_setup_readiness(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  v_assignment public.employee_assignments;
  v_private public.employee_private;
  v_prefs public.employee_setup_preferences;
  v_setup public.employee_access_setup;
  v_invited_at timestamptz;
  v_last_sign_in_at timestamptz;
  v_items jsonb := '[]'::jsonb;
  v_required integer;
  v_complete integer;
  v_blockers jsonb;
  v_warnings jsonb;
  v_has_trn boolean;
  v_has_contact boolean;
  v_has_run boolean;
  v_account text;
begin
  select * into v_employee from public.employees where id = p_employee_id;
  if v_employee.id is null then
    raise exception 'Employee not found';
  end if;

  select * into v_assignment from public.employee_assignments where employee_id = p_employee_id and end_date is null;
  select * into v_private from public.employee_private where employee_id = p_employee_id;
  select * into v_prefs from public.employee_setup_preferences where organization_id = v_employee.organization_id;
  if v_prefs.organization_id is null then
    v_prefs.require_reporting_line := true;
    v_prefs.require_onboarding_plan := true;
    v_prefs.require_date_of_birth := false;
    v_prefs.require_trn := false;
    v_prefs.require_personal_email := false;
    v_prefs.require_personal_phone := false;
    v_prefs.require_home_address := false;
    v_prefs.require_emergency_contact := false;
  end if;
  select * into v_setup from public.employee_access_setup where employee_id = p_employee_id;
  select u.invited_at, u.last_sign_in_at into v_invited_at, v_last_sign_in_at from auth.users u where u.id = v_employee.user_id;

  v_has_trn := exists (select 1 from public.employee_identifiers where employee_id = p_employee_id and identifier_type = 'trn');
  v_has_contact := exists (select 1 from public.employee_emergency_contacts where employee_id = p_employee_id);
  v_has_run := exists (select 1 from public.onboarding_runs where employee_id = p_employee_id and status in ('in_progress', 'completed'));

  v_items := jsonb_build_array(
    private.setup_item('employee_number', 'Employee number', 'identity', true, nullif(btrim(v_employee.employee_number), '') is not null),
    private.setup_item('first_name', 'First name', 'identity', true, nullif(btrim(v_employee.first_name), '') is not null),
    private.setup_item('last_name', 'Last name', 'identity', true, nullif(btrim(v_employee.last_name), '') is not null),
    private.setup_item('work_email', 'Work email', 'identity', true, v_employee.work_email is not null),
    private.setup_item('hire_date', 'Hire date', 'employment', true, v_employee.hire_date is not null),
    private.setup_item('employment_type', 'Employment type', 'employment', true, v_assignment.employment_type is not null),
    private.setup_item('department', 'Department', 'employment', true, v_assignment.org_unit_id is not null),
    private.setup_item('position', 'Position', 'employment', true, v_assignment.position_id is not null),
    private.setup_item('location', 'Work location', 'employment', true, v_assignment.location_id is not null),
    private.setup_item('reporting_line', 'Supervisor or manager', 'reporting', v_prefs.require_reporting_line,
      v_assignment.supervisor_employee_id is not null or v_assignment.manager_employee_id is not null),
    private.setup_item('date_of_birth', 'Date of birth', 'personal', v_prefs.require_date_of_birth, v_private.date_of_birth is not null),
    private.setup_item('trn', 'TRN', 'identifiers', v_prefs.require_trn, v_has_trn),
    private.setup_item('personal_email', 'Personal email', 'personal', v_prefs.require_personal_email, v_private.personal_email is not null),
    private.setup_item('personal_phone', 'Personal phone', 'personal', v_prefs.require_personal_phone, nullif(btrim(v_private.personal_phone), '') is not null),
    private.setup_item('home_address', 'Home address', 'personal', v_prefs.require_home_address,
      nullif(btrim(v_private.address_line1), '') is not null and nullif(btrim(v_private.city), '') is not null),
    private.setup_item('emergency_contact', 'Emergency contact', 'emergency', v_prefs.require_emergency_contact, v_has_contact),
    private.setup_item('portal_access', 'Portal access level', 'access', true,
      v_employee.user_id is not null or v_setup.configured_at is not null),
    private.setup_item('onboarding_plan', 'Onboarding plan', 'onboarding', v_prefs.require_onboarding_plan,
      v_setup.onboarding_template_id is not null or v_has_run)
  );

  select count(*) filter (where (i->>'required')::boolean),
         count(*) filter (where (i->>'required')::boolean and (i->>'complete')::boolean)
  into v_required, v_complete
  from jsonb_array_elements(v_items) i;

  select coalesce(jsonb_agg(i), '[]'::jsonb) into v_blockers
  from jsonb_array_elements(v_items) i
  where (i->>'required')::boolean and not (i->>'complete')::boolean;

  -- Optional items still worth flagging even when an organization has not
  -- made them mandatory.
  select coalesce(jsonb_agg(i), '[]'::jsonb) into v_warnings
  from jsonb_array_elements(v_items) i
  where not (i->>'required')::boolean and not (i->>'complete')::boolean
    and i->>'code' in ('emergency_contact', 'trn', 'date_of_birth', 'reporting_line', 'onboarding_plan');

  if v_employee.status = 'terminated' then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'terminated', 'label', 'Employment status', 'section', 'employment',
      'required', true, 'complete', false, 'message', 'This employee has been terminated'
    ));
  end if;

  v_account := case
    when v_employee.user_id is null then 'not_invited'
    when v_last_sign_in_at is null then 'invited'
    else 'active'
  end;

  return jsonb_build_object(
    'employee_id', p_employee_id,
    'ready', jsonb_array_length(v_blockers) = 0,
    'percent', case when v_required = 0 then 100 else floor(v_complete * 100.0 / v_required)::int end,
    'required_count', v_required,
    'complete_count', v_complete,
    'blockers', v_blockers,
    'warnings', v_warnings,
    'items', v_items,
    'account', jsonb_build_object(
      'state', v_account,
      'invited_at', v_invited_at,
      'last_sign_in_at', v_last_sign_in_at
    ),
    'access', jsonb_build_object(
      'pending_role', v_setup.pending_role,
      'pending_custom_role_id', v_setup.pending_custom_role_id,
      'configured_at', v_setup.configured_at,
      'applied_at', v_setup.applied_at,
      'onboarding_template_id', v_setup.onboarding_template_id,
      'onboarding_was_recommended', coalesce(v_setup.onboarding_was_recommended, false)
    )
  );
end;
$$;

create or replace function public.get_employee_setup_readiness(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.employees where id = p_employee_id;
  if v_org is null or not private.has_permission(v_org, 'employee.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to view this employee''s setup';
  end if;
  return private.employee_setup_readiness(p_employee_id);
end;
$$;

revoke execute on function public.get_employee_setup_readiness(uuid) from public, anon;
grant execute on function public.get_employee_setup_readiness(uuid) to authenticated;

-- One row per employee for the People directory.
create or replace function public.list_employee_setup_summary(p_organization_id uuid)
returns table (
  employee_id uuid,
  ready boolean,
  percent integer,
  blocker_count integer,
  account_state text,
  invited_at timestamptz,
  last_sign_in_at timestamptz,
  onboarding_status text,
  onboarding_completed integer,
  onboarding_total integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_permission(p_organization_id, 'employee.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to view this organization''s employees';
  end if;

  return query
  select
    e.id,
    (r.readiness->>'ready')::boolean,
    (r.readiness->>'percent')::integer,
    jsonb_array_length(r.readiness->'blockers'),
    r.readiness->'account'->>'state',
    (r.readiness->'account'->>'invited_at')::timestamptz,
    (r.readiness->'account'->>'last_sign_in_at')::timestamptz,
    latest.status,
    coalesce(latest.completed, 0)::integer,
    coalesce(latest.total, 0)::integer
  from public.employees e
  cross join lateral (select private.employee_setup_readiness(e.id) as readiness) r
  left join lateral (
    select run.status,
      (select count(*) from public.onboarding_tasks t where t.run_id = run.id and t.status in ('completed', 'skipped')) as completed,
      (select count(*) from public.onboarding_tasks t where t.run_id = run.id) as total
    from public.onboarding_runs run
    where run.employee_id = e.id
    order by (run.status = 'in_progress') desc, run.started_at desc
    limit 1
  ) latest on true
  where e.organization_id = p_organization_id;
end;
$$;

revoke execute on function public.list_employee_setup_summary(uuid) from public, anon;
grant execute on function public.list_employee_setup_summary(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 10. Invitation linking applies prepared access and onboarding
-- ---------------------------------------------------------------------------

drop function if exists public.link_invited_employee_account(uuid, uuid);

create or replace function public.link_invited_employee_account(
  p_employee_id uuid,
  p_user_id uuid,
  p_invited_by uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  v_setup public.employee_access_setup;
  v_role public.app_role;
  v_custom_role_id uuid;
  v_run public.onboarding_runs;
begin
  select * into v_employee
  from public.employees
  where id = p_employee_id
  for update;

  if v_employee.id is null then
    raise exception using errcode = 'P0002', message = 'Employee not found';
  end if;
  if v_employee.user_id is not null and v_employee.user_id <> p_user_id then
    raise exception using errcode = '23505', message = 'Employee already has a different account';
  end if;

  update public.employees
  set user_id = p_user_id,
      status = case when status = 'prehire' then 'active' else status end,
      hire_date = case when status = 'prehire' and hire_date is null then current_date else hire_date end
  where id = p_employee_id;

  select * into v_setup from public.employee_access_setup where employee_id = p_employee_id for update;

  -- The prepared role, falling back to baseline Employee access if HR
  -- never prepared one or the prepared custom role has since been retired.
  v_custom_role_id := case
    when v_setup.pending_custom_role_id is not null and exists (
      select 1 from public.organization_roles r
      where r.id = v_setup.pending_custom_role_id and r.organization_id = v_employee.organization_id and r.is_active
    ) then v_setup.pending_custom_role_id
  end;
  v_role := case when v_custom_role_id is null then coalesce(v_setup.pending_role, 'employee') end;

  if not exists (
    select 1 from public.role_assignments
    where organization_id = v_employee.organization_id
      and user_id = p_user_id
      and scope_type = 'organization'
      and valid_from <= now()
      and (valid_until is null or valid_until > now())
  ) then
    insert into public.role_assignments (organization_id, user_id, role, custom_role_id, granted_by)
    values (v_employee.organization_id, p_user_id, v_role, v_custom_role_id, coalesce(v_setup.configured_by, p_invited_by));
  end if;

  if v_setup.employee_id is not null then
    update public.employee_access_setup set applied_at = now() where employee_id = p_employee_id;
  end if;

  -- Start the prepared onboarding now that employee tasks can be assigned
  -- to a real account. A run HR already started during preboarding is kept
  -- and simply has its employee tasks assigned (by the user_id trigger).
  if v_setup.onboarding_template_id is not null and not exists (
    select 1 from public.onboarding_runs where employee_id = p_employee_id and status = 'in_progress'
  ) then
    v_run := private.instantiate_onboarding_run(
      p_employee_id, v_setup.onboarding_template_id, coalesce(p_invited_by, v_setup.onboarding_selected_by)
    );
  end if;

  perform private.resolve_onboarding_assignees(p_employee_id);
  perform private.recompute_onboarding_due_dates(p_employee_id);

  perform private.log_audit_event(
    v_employee.organization_id, 'EMPLOYEE_INVITED', 'employee', v_employee.id,
    null, jsonb_build_object(
      'user_id', p_user_id, 'work_email', v_employee.work_email, 'invited_by', p_invited_by,
      'role', v_role, 'custom_role_id', v_custom_role_id, 'onboarding_run_id', v_run.id
    )
  );
end;
$$;

revoke execute on function public.link_invited_employee_account(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.link_invited_employee_account(uuid, uuid, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 11. HaloManage Standard Onboarding
-- ---------------------------------------------------------------------------

create or replace function private.seed_standard_onboarding_template(
  p_organization_id uuid,
  p_actor uuid,
  p_make_default boolean
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_template_id uuid;
  v_version_id uuid;
  v_actor uuid := case when exists (select 1 from auth.users where id = p_actor) then p_actor end;
begin
  select id into v_template_id
  from public.onboarding_templates
  where organization_id = p_organization_id and name = 'HaloManage Standard Onboarding';
  if v_template_id is not null then
    return v_template_id;
  end if;

  if p_make_default then
    update public.onboarding_templates set is_default = false
    where organization_id = p_organization_id and is_default;
  end if;

  insert into public.onboarding_templates (organization_id, name, description, is_default, created_by)
  values (
    p_organization_id, 'HaloManage Standard Onboarding',
    'A complete, editable framework: HR preparation before day one, first-day and first-week essentials, a 30-day checkpoint, and a probation review. Delete any step you don''t use.',
    p_make_default, v_actor
  )
  returning id into v_template_id;

  insert into public.onboarding_template_versions (template_id, version_number, is_current, created_by)
  values (v_template_id, 1, true, v_actor)
  returning id into v_version_id;

  insert into public.onboarding_template_steps (
    template_version_id, sequence, phase, title, description, step_type, assignee_type,
    due_anchor, due_offset_days, required
  )
  select v_version_id, s.sequence, s.phase, s.title, s.description, s.step_type, s.assignee_type,
         s.due_anchor, s.due_offset_days, s.required
  from (values
    -- Phase A — preboarding (HR preparation before day one)
    (1,  'preboarding',   'Verify identification documents', 'Check government ID and TRN documents against the employee record, then mark the identifiers verified.', 'document_review', 'hr', 'hire_date', -5, true),
    (2,  'preboarding',   'Upload signed employment contract', 'Attach the signed contract to the employee''s documents.', 'document_upload', 'hr', 'hire_date', -3, true),
    (3,  'preboarding',   'Upload job description', 'Attach the job description the employee will review on day one.', 'document_upload', 'hr', 'hire_date', -3, true),
    (4,  'preboarding',   'Record compensation details', 'Enter the agreed pay rate, pay group, and effective date.', 'task', 'hr', 'hire_date', -3, false),
    (5,  'preboarding',   'Prepare equipment and system access', 'Laptop, phone, badge, email and any system accounts the role needs.', 'task', 'it', 'hire_date', -2, true),
    (6,  'preboarding',   'Assign required training', 'Assign mandatory courses from Learning & assets.', 'task', 'hr', 'hire_date', -1, false),
    -- Phase B — first day
    (7,  'first_day',     'Review and confirm your profile', 'Check that your personal details, contact information, and emergency contacts are correct.', 'form', 'employee', 'hire_date', 0, true),
    (8,  'first_day',     'Review your job description', 'Read your job description and raise any questions with your supervisor.', 'document_review', 'employee', 'hire_date', 0, true),
    (9,  'first_day',     'Workplace orientation', 'Tour of the workplace, safety procedures, and introductions.', 'meeting', 'supervisor', 'hire_date', 0, true),
    (10, 'first_day',     'Read the employee handbook', 'Read the handbook in your Documents.', 'document_review', 'employee', 'hire_date', 1, true),
    (11, 'first_day',     'Acknowledge company policies', 'Confirm you have read and understood the workplace policies.', 'acknowledgement', 'employee', 'hire_date', 1, true),
    (12, 'first_day',     'Review attendance and leave expectations', 'How to clock in, request leave, and who approves it.', 'acknowledgement', 'employee', 'hire_date', 1, true),
    (13, 'first_day',     'Meet your supervisor', 'Discuss priorities, working agreements, and what success looks like.', 'meeting', 'supervisor', 'hire_date', 1, true),
    (14, 'first_day',     'Complete security and privacy training', 'Data protection, passwords, and acceptable use.', 'training', 'employee', 'hire_date', 2, true),
    -- Phase C — first week
    (15, 'first_week',    'Department orientation', 'How the department works, key processes, and who to ask.', 'meeting', 'manager', 'hire_date', 3, true),
    (16, 'first_week',    'Meet key team members', 'Introductions to the people you''ll work with most.', 'task', 'employee', 'hire_date', 5, false),
    (17, 'first_week',    'Confirm tools, equipment and access received', 'Let HR know if anything you need is missing.', 'checkpoint', 'employee', 'hire_date', 5, true),
    (18, 'first_week',    'Role-specific training', 'Training specific to this position.', 'training', 'supervisor', 'hire_date', 7, false),
    (19, 'first_week',    'Review performance expectations', 'Agree on goals and how progress will be measured.', 'meeting', 'supervisor', 'hire_date', 7, true),
    (20, 'first_week',    'Week-one check-in', 'How is the first week going? Anything blocking?', 'meeting', 'manager', 'hire_date', 7, true),
    -- Phase D — 30-day checkpoint
    (21, 'first_30_days', '30-day employee check-in', 'Reflect on your first month: what''s going well and what support would help.', 'form', 'employee', 'hire_date', 30, true),
    (22, 'first_30_days', '30-day manager feedback', 'Record feedback on the first month and any development needs.', 'form', 'supervisor', 'hire_date', 30, true),
    (23, 'first_30_days', 'Outstanding training, equipment and access review', 'Confirm required training is done and nothing is outstanding.', 'checkpoint', 'hr', 'hire_date', 30, true),
    -- Phase E — probation (only dated when a probation end date is set)
    (24, 'probation',     'Probation review meeting', 'Employee feedback, manager assessment, and development needs.', 'meeting', 'manager', 'probation_end_date', -7, false),
    (25, 'probation',     'Probation decision', 'Confirm, extend, or escalate — record the outcome and reason.', 'approval', 'hr', 'probation_end_date', 0, false)
  ) as s(sequence, phase, title, description, step_type, assignee_type, due_anchor, due_offset_days, required);

  return v_template_id;
end;
$$;

-- New organizations get the framework as their default before the starter
-- workspace seeding runs; that seeding only adds its own small template
-- when an organization has none, so it now steps aside.
create or replace function private.seed_standard_onboarding_on_org_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.seed_standard_onboarding_template(new.id, auth.uid(), true);
  insert into public.organization_employee_number_settings (organization_id)
  values (new.id) on conflict (organization_id) do nothing;
  insert into public.employee_setup_preferences (organization_id)
  values (new.id) on conflict (organization_id) do nothing;
  return null;
end;
$$;

create trigger organizations_seed_employee_setup
  after insert on public.organizations
  for each row execute function private.seed_standard_onboarding_on_org_insert();

-- Existing organizations: make the framework available without changing
-- their chosen default.
do $$
declare
  v_org record;
begin
  for v_org in select id from public.organizations loop
    perform private.seed_standard_onboarding_template(
      v_org.id, null,
      not exists (select 1 from public.onboarding_templates t where t.organization_id = v_org.id and t.is_default)
    );
  end loop;
end $$;

insert into public.employee_setup_preferences (organization_id)
select id from public.organizations
on conflict (organization_id) do nothing;

-- ---------------------------------------------------------------------------
-- 12. Assignment corrections during setup
-- ---------------------------------------------------------------------------

-- While HR is still building a pre-hire's record, fixing a wrong department
-- is a correction, not an employment change — creating a history row per
-- typo would make the "Assignment History" meaningless, and the previous
-- "start_date must be after the current row" rule made a same-day fix
-- impossible altogether. A pre-hire's current row, or any row being
-- re-saved with its own start date, is corrected in place (and audited as
-- a correction); every other change still closes the current row and opens
-- a new one exactly as before.
create or replace function public.change_employee_assignment(
  p_employee_id uuid,
  p_org_unit_id uuid,
  p_position_id uuid,
  p_location_id uuid,
  p_supervisor_employee_id uuid,
  p_manager_employee_id uuid,
  p_employment_type text,
  p_start_date date default current_date,
  p_change_reason text default null
)
returns public.employee_assignments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  v_current public.employee_assignments;
  v_new public.employee_assignments;
begin
  select * into v_employee from public.employees where id = p_employee_id;
  if v_employee.id is null then
    raise exception 'Employee not found';
  end if;
  if not private.has_permission(v_employee.organization_id, 'employee.manage') then
    raise exception 'Not authorized to change this employee''s assignment';
  end if;
  if p_supervisor_employee_id = p_employee_id or p_manager_employee_id = p_employee_id then
    raise exception using errcode = '22023', message = 'An employee cannot report to themself';
  end if;

  select * into v_current from public.employee_assignments
  where employee_id = p_employee_id and end_date is null
  for update;

  if v_current.id is not null
     and (v_employee.status = 'prehire' or p_start_date = v_current.start_date)
     and not exists (
       select 1 from public.employee_assignments h
       where h.employee_id = p_employee_id and h.end_date is not null and h.end_date >= p_start_date
     )
  then
    update public.employee_assignments
    set org_unit_id = p_org_unit_id,
        position_id = p_position_id,
        location_id = p_location_id,
        supervisor_employee_id = p_supervisor_employee_id,
        manager_employee_id = p_manager_employee_id,
        employment_type = p_employment_type,
        start_date = p_start_date,
        change_reason = coalesce(p_change_reason, change_reason)
    where id = v_current.id
    returning * into v_new;

    perform private.log_audit_event(
      v_employee.organization_id, 'EMPLOYEE_ASSIGNMENT_CORRECTED', 'employee_assignment', v_new.id,
      to_jsonb(v_current), to_jsonb(v_new)
    );
    return v_new;
  end if;

  if v_current.id is not null then
    if p_start_date <= v_current.start_date then
      raise exception 'New assignment start_date must be after the current assignment''s start_date (%)', v_current.start_date;
    end if;
    update public.employee_assignments set end_date = p_start_date - 1 where id = v_current.id;
  end if;

  insert into public.employee_assignments (
    organization_id, employee_id, org_unit_id, position_id, location_id,
    supervisor_employee_id, manager_employee_id, employment_type,
    start_date, change_reason, created_by
  )
  values (
    v_employee.organization_id, p_employee_id, p_org_unit_id, p_position_id, p_location_id,
    p_supervisor_employee_id, p_manager_employee_id, p_employment_type,
    p_start_date, p_change_reason, auth.uid()
  )
  returning * into v_new;

  perform private.log_audit_event(
    v_employee.organization_id, 'EMPLOYEE_ASSIGNMENT_CHANGED', 'employee_assignment', v_new.id,
    to_jsonb(v_current), to_jsonb(v_new)
  );

  return v_new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. Employee-editable vs HR-controlled personal fields
-- ---------------------------------------------------------------------------

-- employee_private RLS lets an employee write their own row. Contact
-- details and address are theirs to keep current; date of birth, legacy
-- national_id, bank digits and HR notes are HR controlled (blueprint §16).
create or replace function private.enforce_employee_private_protected_columns()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or private.has_permission(new.organization_id, 'employee.manage') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.date_of_birth is not null or new.national_id is not null
       or new.bank_account_last4 is not null or new.notes is not null then
      raise exception using errcode = '42501', message = 'Only HR can record date of birth, identification, bank or HR notes';
    end if;
    return new;
  end if;

  if new.organization_id is distinct from old.organization_id
     or new.date_of_birth is distinct from old.date_of_birth
     or new.national_id is distinct from old.national_id
     or new.bank_account_last4 is distinct from old.bank_account_last4
     or new.notes is distinct from old.notes then
    raise exception using errcode = '42501', message = 'Only HR can change date of birth, identification, bank or HR notes';
  end if;
  return new;
end;
$$;

create trigger employee_private_protect_columns
  before insert or update on public.employee_private
  for each row execute function private.enforce_employee_private_protected_columns();

-- ---------------------------------------------------------------------------
-- 14. Employee HR timeline
-- ---------------------------------------------------------------------------

-- audit_events is readable only with audit.read. HR (employee.manage) still
-- needs a person's lifecycle timeline, so this returns a curated view of
-- the events about one employee — actions, times, who did it, and only
-- non-sensitive detail keys. Compensation events are included only for
-- callers who can read compensation.
create or replace function public.list_employee_history(p_employee_id uuid)
returns table (
  id uuid,
  action text,
  entity_type text,
  created_at timestamptz,
  actor_name text,
  details jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_can_comp boolean;
begin
  select e.organization_id into v_org from public.employees e where e.id = p_employee_id;
  if v_org is null or not private.has_permission(v_org, 'employee.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to view this employee''s history';
  end if;
  v_can_comp := private.has_permission(v_org, 'compensation.read_org');

  return query
  select
    a.id,
    a.action,
    a.entity_type,
    a.created_at,
    coalesce(nullif(btrim(coalesce(actor.preferred_name, actor.first_name) || ' ' || actor.last_name), ''), 'System'),
    coalesce((
      select jsonb_object_agg(kv.key, kv.value)
      from jsonb_each(coalesce(a.new_data, '{}'::jsonb)) kv
      where kv.key in (
        'employee_number', 'source', 'status', 'hire_date', 'role', 'identifier_type', 'label', 'value', 'verified',
        'fields', 'relationship', 'is_primary', 'reason', 'title', 'template_id', 'recommended', 'version_number',
        'change_reason', 'start_date', 'employment_type', 'work_email', 'termination_date', 'effective_date'
      )
    ), '{}'::jsonb)
  from public.audit_events a
  left join public.employees actor
    on actor.user_id = a.actor_user_id and actor.organization_id = a.organization_id
  where a.organization_id = v_org
    and (
      (a.entity_type = 'employee' and a.entity_id = p_employee_id)
      or (a.entity_type = 'employee_assignment' and a.entity_id in (
        select ea.id from public.employee_assignments ea where ea.employee_id = p_employee_id))
      or (a.entity_type = 'onboarding_run' and a.entity_id in (
        select r.id from public.onboarding_runs r where r.employee_id = p_employee_id))
      or (a.entity_type = 'onboarding_task' and a.entity_id in (
        select t.id from public.onboarding_tasks t where t.employee_id = p_employee_id))
      or (v_can_comp and a.entity_type = 'employee_compensation' and a.entity_id in (
        select c.id from public.employee_compensation c where c.employee_id = p_employee_id))
    )
    and (v_can_comp or a.action not like 'COMPENSATION%')
  order by a.created_at desc
  limit 300;
end;
$$;

revoke execute on function public.list_employee_history(uuid) from public, anon;
grant execute on function public.list_employee_history(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 15. Progress counts skipped steps as closed
-- ---------------------------------------------------------------------------

create or replace view public.onboarding_progress_v
  with (security_invoker = true)
as
select
  r.id as run_id,
  r.organization_id,
  r.employee_id,
  r.status,
  count(t.id) as total_tasks,
  count(t.id) filter (where t.status in ('completed', 'skipped')) as completed_tasks,
  count(t.id) filter (where t.status not in ('completed', 'skipped') and t.due_date < current_date and r.status = 'in_progress') as overdue_tasks,
  round(
    (count(t.id) filter (where t.status in ('completed', 'skipped')))::numeric
    / nullif(count(t.id), 0) * 100, 1
  ) as percent_complete
from public.onboarding_runs r
left join public.onboarding_tasks t on t.run_id = r.id
group by r.id, r.organization_id, r.employee_id, r.status;
