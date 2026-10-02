-- Halomanage — My Profile as the employee's official record
--
-- From the HR review of /profile (docs/ARCHITECTURE.md "My Profile: the
-- employee's official record"). Database half:
--
--  1. Tenant integrity: an employee-scoped child row can never claim an
--     organization other than its employee's (composite foreign keys), and
--     employee_private's self-service RLS now checks it too (§5).
--  2. HR notes move out of employee_private — which employees can read —
--     into employee_hr_notes, readable only with employee.manage (§6).
--  3. employee.update_self actually governs self-service edits (§19);
--     work phone becomes HR/IT-managed unless the organization allows
--     employees to edit it (§8).
--  4. Organization settings for which demographic fields are collected,
--     plus a privacy-notice link (§9, §17).
--  5. Phone numbers are normalized to E.164 in the database (§12).
--  6. Emergency contacts need a way to reach them, primary selection is
--     atomic, and an employee can't delete their last contact when the
--     organization requires one (§13).
--  7. Correction and data-access requests with HR decisions, auditing and
--     notifications (§4, §17).
--  8. Profile confirmation ("last reviewed") and HR-launched verification
--     rounds (§23); profile completeness after activation (§14).
--  9. Self-service directory/photo changes are audited by field name (§18).
-- 10. Required notifications can't be switched off (§22).
-- 11. get_my_employee_record() / get_my_personal_data() for the employee's
--     own read-only record and a self-service copy of their data.

-- ---------------------------------------------------------------------------
-- 1. Tenant integrity for employee-scoped tables
-- ---------------------------------------------------------------------------

alter table public.employees
  add constraint employees_id_organization_key unique (id, organization_id);

-- Repair any row that already disagrees with its employee (none expected —
-- the UI always sent the right organization — but the constraints below
-- must be able to validate).
update public.employee_private p set organization_id = e.organization_id
from public.employees e where e.id = p.employee_id and p.organization_id <> e.organization_id;
update public.employee_identifiers p set organization_id = e.organization_id
from public.employees e where e.id = p.employee_id and p.organization_id <> e.organization_id;
update public.employee_emergency_contacts p set organization_id = e.organization_id
from public.employees e where e.id = p.employee_id and p.organization_id <> e.organization_id;
update public.employee_access_setup p set organization_id = e.organization_id
from public.employees e where e.id = p.employee_id and p.organization_id <> e.organization_id;

alter table public.employee_private
  add constraint employee_private_employee_org_fkey
  foreign key (employee_id, organization_id) references public.employees(id, organization_id) on delete cascade;
alter table public.employee_identifiers
  add constraint employee_identifiers_employee_org_fkey
  foreign key (employee_id, organization_id) references public.employees(id, organization_id) on delete cascade;
alter table public.employee_emergency_contacts
  add constraint employee_emergency_contacts_employee_org_fkey
  foreign key (employee_id, organization_id) references public.employees(id, organization_id) on delete cascade;
alter table public.employee_access_setup
  add constraint employee_access_setup_employee_org_fkey
  foreign key (employee_id, organization_id) references public.employees(id, organization_id) on delete cascade;

-- Self-service writes to employee_private: own row, own organization, and
-- only while the caller's role includes employee.update_self.
drop policy if exists "write own private info" on public.employee_private;
drop policy if exists "update own private info" on public.employee_private;
create policy "write own private info" on public.employee_private for insert to authenticated
  with check (
    employee_id = private.current_employee_id()
    and organization_id = (select e.organization_id from public.employees e where e.id = employee_id)
    and private.has_permission(organization_id, 'employee.update_self')
  );
create policy "update own private info" on public.employee_private for update to authenticated
  using (employee_id = private.current_employee_id())
  with check (
    employee_id = private.current_employee_id()
    and organization_id = (select e.organization_id from public.employees e where e.id = employee_id)
    and private.has_permission(organization_id, 'employee.update_self')
  );

drop policy if exists "manage own emergency contacts" on public.employee_emergency_contacts;
create policy "manage own emergency contacts" on public.employee_emergency_contacts for all to authenticated
  using (employee_id = private.current_employee_id() and private.has_permission(organization_id, 'employee.update_self'))
  with check (
    employee_id = private.current_employee_id()
    and organization_id = (select e.organization_id from public.employees e where e.id = employee_id)
    and private.has_permission(organization_id, 'employee.update_self')
  );

-- ---------------------------------------------------------------------------
-- 2. HR notes leave the employee-readable table
-- ---------------------------------------------------------------------------

create table public.employee_hr_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  category text not null default 'general' check (category in (
    'general', 'employee_relations', 'compliance', 'manager_note', 'confidential'
  )),
  body text not null check (char_length(btrim(body)) between 1 and 10000),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  foreign key (employee_id, organization_id) references public.employees(id, organization_id) on delete cascade
);
alter table public.employee_hr_notes enable row level security;
create index employee_hr_notes_employee_idx on public.employee_hr_notes(employee_id, created_at desc);
create trigger employee_hr_notes_set_updated_at
  before update on public.employee_hr_notes
  for each row execute function private.set_updated_at();

comment on table public.employee_hr_notes is
  'HR-only notes about an employee. Never readable by the employee or their managers — employee.manage only.';

create policy "hr read hr notes" on public.employee_hr_notes for select to authenticated
  using (private.has_permission(organization_id, 'employee.manage'));
create policy "hr write hr notes" on public.employee_hr_notes for insert to authenticated
  with check (private.has_permission(organization_id, 'employee.manage'));
create policy "hr update hr notes" on public.employee_hr_notes for update to authenticated
  using (private.has_permission(organization_id, 'employee.manage'))
  with check (private.has_permission(organization_id, 'employee.manage'));
create policy "hr delete hr notes" on public.employee_hr_notes for delete to authenticated
  using (private.has_permission(organization_id, 'employee.manage'));
grant select, insert, update, delete on public.employee_hr_notes to authenticated;

create or replace function private.employee_hr_notes_stamp()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  new.updated_by := auth.uid();
  return new;
end;
$$;

create trigger employee_hr_notes_stamp
  before insert or update on public.employee_hr_notes
  for each row execute function private.employee_hr_notes_stamp();

create or replace function private.employee_hr_notes_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.employee_hr_notes := coalesce(new, old);
begin
  -- The note body is confidential; the audit trail records only that a
  -- note of this category was added, changed or removed.
  perform private.log_audit_event(
    v_row.organization_id,
    case tg_op when 'INSERT' then 'HR_NOTE_ADDED' when 'DELETE' then 'HR_NOTE_DELETED' else 'HR_NOTE_UPDATED' end,
    'employee', v_row.employee_id, null,
    jsonb_build_object('note_id', v_row.id, 'category', v_row.category)
  );
  return null;
end;
$$;

create trigger employee_hr_notes_audit
  after insert or update or delete on public.employee_hr_notes
  for each row execute function private.employee_hr_notes_audit();

insert into public.employee_hr_notes (organization_id, employee_id, category, body, created_at)
select p.organization_id, p.employee_id, 'general', btrim(p.notes), p.updated_at
from public.employee_private p
where nullif(btrim(p.notes), '') is not null;

-- The trigger guarding employee_private referenced notes; redefine it
-- before the column goes.
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
    if new.date_of_birth is not null or new.national_id is not null or new.bank_account_last4 is not null then
      raise exception using errcode = '42501', message = 'Only HR can record date of birth, identification or bank details';
    end if;
    return new;
  end if;

  if new.organization_id is distinct from old.organization_id
     or new.date_of_birth is distinct from old.date_of_birth
     or new.national_id is distinct from old.national_id
     or new.bank_account_last4 is distinct from old.bank_account_last4 then
    raise exception using errcode = '42501', message = 'Only HR can change date of birth, identification or bank details';
  end if;
  return new;
end;
$$;

alter table public.employee_private drop column notes;

-- ---------------------------------------------------------------------------
-- 4. What the organization collects (and its privacy notice)
-- ---------------------------------------------------------------------------

alter table public.employee_setup_preferences
  add column if not exists collect_gender text not null default 'off' check (collect_gender in ('off', 'optional')),
  add column if not exists collect_marital_status text not null default 'off' check (collect_marital_status in ('off', 'optional')),
  add column if not exists work_phone_editable_by_employee boolean not null default false,
  add column if not exists privacy_notice_url text check (privacy_notice_url is null or privacy_notice_url ~* '^https?://');

-- Data minimization by default: new organizations don't collect gender or
-- marital status unless they choose to. Organizations that already hold
-- such data keep the field visible so it can be reviewed or cleared.
update public.employee_setup_preferences s
set collect_gender = 'optional'
where exists (select 1 from public.employee_private p where p.organization_id = s.organization_id and nullif(btrim(p.gender), '') is not null);
update public.employee_setup_preferences s
set collect_marital_status = 'optional'
where exists (select 1 from public.employee_private p where p.organization_id = s.organization_id and nullif(btrim(p.marital_status), '') is not null);

drop function if exists public.update_employee_record_settings(uuid, jsonb, jsonb);

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
    if p_requirements ? 'collect_gender' and p_requirements->>'collect_gender' not in ('off', 'optional') then
      raise exception using errcode = '22023', message = 'Gender collection must be off or optional';
    end if;
    if p_requirements ? 'collect_marital_status' and p_requirements->>'collect_marital_status' not in ('off', 'optional') then
      raise exception using errcode = '22023', message = 'Marital status collection must be off or optional';
    end if;
    if nullif(btrim(coalesce(p_requirements->>'privacy_notice_url', '')), '') is not null
       and p_requirements->>'privacy_notice_url' !~* '^https?://' then
      raise exception using errcode = '22023', message = 'The privacy notice link must start with http:// or https://';
    end if;

    update public.employee_setup_preferences
    set require_reporting_line = coalesce((p_requirements->>'require_reporting_line')::boolean, require_reporting_line),
        require_onboarding_plan = coalesce((p_requirements->>'require_onboarding_plan')::boolean, require_onboarding_plan),
        require_date_of_birth = coalesce((p_requirements->>'require_date_of_birth')::boolean, require_date_of_birth),
        require_trn = coalesce((p_requirements->>'require_trn')::boolean, require_trn),
        require_personal_email = coalesce((p_requirements->>'require_personal_email')::boolean, require_personal_email),
        require_personal_phone = coalesce((p_requirements->>'require_personal_phone')::boolean, require_personal_phone),
        require_home_address = coalesce((p_requirements->>'require_home_address')::boolean, require_home_address),
        require_emergency_contact = coalesce((p_requirements->>'require_emergency_contact')::boolean, require_emergency_contact),
        collect_gender = coalesce(p_requirements->>'collect_gender', collect_gender),
        collect_marital_status = coalesce(p_requirements->>'collect_marital_status', collect_marital_status),
        work_phone_editable_by_employee = coalesce((p_requirements->>'work_phone_editable_by_employee')::boolean, work_phone_editable_by_employee),
        privacy_notice_url = case when p_requirements ? 'privacy_notice_url'
          then nullif(btrim(coalesce(p_requirements->>'privacy_notice_url', '')), '') else privacy_notice_url end
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
-- 3 + 9. Self-service gate, work-phone policy, profile confirmation, audit
-- ---------------------------------------------------------------------------

alter table public.employees add column if not exists profile_last_confirmed_at timestamptz;

drop policy if exists "update employee records" on public.employees;
create policy "update employee records" on public.employees for update to authenticated
  using (
    (user_id = (select auth.uid()) and private.has_permission(organization_id, 'employee.update_self'))
    or private.has_permission(organization_id, 'employee.manage')
  )
  with check (
    (user_id = (select auth.uid()) and private.has_permission(organization_id, 'employee.update_self'))
    or private.has_permission(organization_id, 'employee.manage')
  );

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

  -- Work phone is directory data other people rely on; employees may edit
  -- it only if their organization allows it.
  if new.work_phone is distinct from old.work_phone and not coalesce((
    select s.work_phone_editable_by_employee from public.employee_setup_preferences s
    where s.organization_id = new.organization_id
  ), false) then
    raise exception using errcode = '42501', message = 'Your work phone is managed by HR — request a correction if it is wrong';
  end if;

  return new;
end;
$$;

create or replace function private.employees_profile_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fields text[];
  v_self boolean := new.user_id is not null and new.user_id = auth.uid();
begin
  select coalesce(array_agg(f order by f), '{}') into v_fields
  from unnest(array[
    case when new.first_name is distinct from old.first_name then 'first_name' end,
    case when new.middle_name is distinct from old.middle_name then 'middle_name' end,
    case when new.last_name is distinct from old.last_name then 'last_name' end,
    case when new.preferred_name is distinct from old.preferred_name then 'preferred_name' end,
    case when new.work_email is distinct from old.work_email then 'work_email' end,
    case when new.work_phone is distinct from old.work_phone then 'work_phone' end,
    case when new.external_payroll_id is distinct from old.external_payroll_id then 'external_payroll_id' end,
    case when new.hire_date is distinct from old.hire_date then 'hire_date' end,
    case when new.probation_end_date is distinct from old.probation_end_date then 'probation_end_date' end
  ]) as f
  where f is not null;

  if cardinality(v_fields) > 0 then
    perform private.log_audit_event(
      new.organization_id,
      case when v_self then 'EMPLOYEE_SELF_PROFILE_UPDATED' else 'EMPLOYEE_PROFILE_UPDATED' end,
      'employee', new.id, null, jsonb_build_object('fields', to_jsonb(v_fields))
    );
  end if;

  if new.avatar_url is distinct from old.avatar_url then
    perform private.log_audit_event(
      new.organization_id,
      case when new.avatar_url is null then 'EMPLOYEE_PROFILE_PHOTO_REMOVED' else 'EMPLOYEE_PROFILE_PHOTO_UPDATED' end,
      'employee', new.id, null, jsonb_build_object('self', v_self)
    );
  end if;
  return null;
end;
$$;

create trigger employees_profile_audit
  after update on public.employees
  for each row execute function private.employees_profile_audit();

-- ---------------------------------------------------------------------------
-- 5. Phone numbers in E.164
-- ---------------------------------------------------------------------------

-- Best-effort normalization for the formats people actually type. North
-- American Numbering Plan numbers (Jamaica is +1 876) become +1XXXXXXXXXX;
-- a 7-digit local number in a Jamaican organization gets +1876; anything
-- written with a leading + keeps its country code. Formats that can't be
-- interpreted safely are stored as typed rather than guessed at.
create or replace function private.normalize_phone(p_phone text, p_country text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := nullif(btrim(coalesce(p_phone, '')), '');
  v_digits text;
begin
  if v is null then
    return null;
  end if;
  v_digits := regexp_replace(v, '\D', '', 'g');
  if left(v, 1) = '+' and char_length(v_digits) between 8 and 15 then
    return '+' || v_digits;
  end if;
  if left(v_digits, 3) = '011' and char_length(v_digits) between 11 and 18 then
    return '+' || substr(v_digits, 4);
  end if;
  if char_length(v_digits) = 11 and left(v_digits, 1) = '1' then
    return '+' || v_digits;
  end if;
  if char_length(v_digits) = 10 and coalesce(upper(p_country), 'JM') in ('JM', 'US', 'CA', 'BS', 'BB', 'TT', 'KY', 'AG', 'DM', 'GD', 'KN', 'LC', 'VC', 'BM', 'TC', 'VG', 'AI', 'MS', 'PR', 'DO') then
    return '+1' || v_digits;
  end if;
  if char_length(v_digits) = 7 and coalesce(upper(p_country), 'JM') = 'JM' then
    return '+1876' || v_digits;
  end if;
  return v;
end;
$$;

create or replace function private.org_country(p_organization_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(nullif(upper(btrim(o.country_code)), ''), 'JM') from public.organizations o where o.id = p_organization_id;
$$;

create or replace function private.normalize_employee_phones()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'employees' then
    new.work_phone := private.normalize_phone(new.work_phone, private.org_country(new.organization_id));
  elsif tg_table_name = 'employee_private' then
    new.personal_phone := private.normalize_phone(new.personal_phone, coalesce(nullif(new.country_code, ''), private.org_country(new.organization_id)));
  elsif tg_table_name = 'employee_emergency_contacts' then
    new.phone := private.normalize_phone(new.phone, private.org_country(new.organization_id));
    new.alternate_phone := private.normalize_phone(new.alternate_phone, private.org_country(new.organization_id));
  end if;
  return new;
end;
$$;

create trigger employees_normalize_phones
  before insert or update of work_phone on public.employees
  for each row execute function private.normalize_employee_phones();
create trigger employee_private_normalize_phones
  before insert or update of personal_phone, country_code on public.employee_private
  for each row execute function private.normalize_employee_phones();
create trigger employee_emergency_contacts_normalize_phones
  before insert or update of phone, alternate_phone on public.employee_emergency_contacts
  for each row execute function private.normalize_employee_phones();

-- Backfill. These run as the migration owner (auth.uid() null), so the
-- protected-column and audit triggers treat them as system maintenance.
update public.employees set work_phone = work_phone where work_phone is not null;
update public.employee_private set personal_phone = personal_phone where personal_phone is not null;
update public.employee_emergency_contacts set phone = phone where phone is not null or alternate_phone is not null;

-- ---------------------------------------------------------------------------
-- 6. Emergency contacts
-- ---------------------------------------------------------------------------

-- NOT VALID: enforced for every new or edited contact; existing rows that
-- predate the rule are left for the employee or HR to complete.
alter table public.employee_emergency_contacts
  add constraint employee_emergency_contacts_reachable
  check (nullif(btrim(coalesce(phone, '')), '') is not null
      or nullif(btrim(coalesce(alternate_phone, '')), '') is not null
      or nullif(btrim(coalesce(email::text, '')), '') is not null)
  not valid;

create or replace function public.set_primary_emergency_contact(p_contact_id uuid)
returns public.employee_emergency_contacts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact public.employee_emergency_contacts;
begin
  select * into v_contact from public.employee_emergency_contacts where id = p_contact_id;
  if v_contact.id is null then
    raise exception 'Emergency contact not found';
  end if;
  if not private.has_permission(v_contact.organization_id, 'employee.manage')
     and not (v_contact.employee_id = private.current_employee_id()
              and private.has_permission(v_contact.organization_id, 'employee.update_self')) then
    raise exception using errcode = '42501', message = 'Not authorized to change these emergency contacts';
  end if;

  -- One transaction: there is never a moment with no primary contact.
  update public.employee_emergency_contacts set is_primary = false
  where employee_id = v_contact.employee_id and is_primary and id <> p_contact_id;
  update public.employee_emergency_contacts set is_primary = true
  where id = p_contact_id
  returning * into v_contact;
  return v_contact;
end;
$$;

revoke execute on function public.set_primary_emergency_contact(uuid) from public, anon;
grant execute on function public.set_primary_emergency_contact(uuid) to authenticated;

create or replace function private.guard_last_emergency_contact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or private.has_permission(old.organization_id, 'employee.manage') then
    return old;
  end if;
  if coalesce((select s.require_emergency_contact from public.employee_setup_preferences s where s.organization_id = old.organization_id), false)
     and not exists (
       select 1 from public.employee_emergency_contacts c
       where c.employee_id = old.employee_id and c.id <> old.id
         and (nullif(btrim(coalesce(c.phone, '')), '') is not null
              or nullif(btrim(coalesce(c.alternate_phone, '')), '') is not null
              or nullif(btrim(coalesce(c.email::text, '')), '') is not null)
     ) then
    raise exception using errcode = '23514', message = 'Your organization requires an emergency contact — add another one before removing this one';
  end if;
  return old;
end;
$$;

create trigger employee_emergency_contacts_guard_last
  before delete on public.employee_emergency_contacts
  for each row execute function private.guard_last_emergency_contact();

-- When a primary contact is removed, promote the next one.
create or replace function private.promote_next_emergency_contact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.is_primary and not exists (
    select 1 from public.employee_emergency_contacts where employee_id = old.employee_id and is_primary
  ) then
    update public.employee_emergency_contacts set is_primary = true
    where id = (select c.id from public.employee_emergency_contacts c where c.employee_id = old.employee_id order by c.created_at limit 1);
  end if;
  return null;
end;
$$;

create trigger employee_emergency_contacts_promote_next
  after delete on public.employee_emergency_contacts
  for each row execute function private.promote_next_emergency_contact();

-- ---------------------------------------------------------------------------
-- 10. Required notifications
-- ---------------------------------------------------------------------------

create or replace function private.required_notification_types()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'onboarding.task_assigned',
    'profile.confirmation_requested',
    'record_request.decided',
    'record_request.submitted'
  ];
$$;

create or replace function private.create_notification(
  p_organization_id uuid,
  p_recipient_user_id uuid,
  p_employee_id uuid,
  p_type text,
  p_title text,
  p_body text default null,
  p_link_url text default null,
  p_data jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_enabled boolean;
begin
  -- Required operational notifications ignore preferences: the
  -- organization must be able to rely on them having been delivered.
  if p_type = any(private.required_notification_types()) then
    v_enabled := true;
  else
    select coalesce(np.enabled, true) into v_enabled
    from public.notification_preferences np
    where np.user_id = p_recipient_user_id and np.organization_id = p_organization_id
      and np.notification_type = p_type and np.channel = 'in_app';
  end if;

  if v_enabled is distinct from false then
    insert into public.notifications (
      organization_id, recipient_user_id, employee_id, type, title, body, link_url, data
    )
    values (p_organization_id, p_recipient_user_id, p_employee_id, p_type, p_title, p_body, p_link_url, p_data)
    returning id into v_id;
  end if;

  return v_id;
end;
$$;

create or replace function private.guard_required_notification_preference()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.notification_type = any(private.required_notification_types()) and not new.enabled then
    raise exception using errcode = '23514', message = 'This notification is required by your organization and can''t be turned off';
  end if;
  return new;
end;
$$;

create trigger notification_preferences_guard_required
  before insert or update on public.notification_preferences
  for each row execute function private.guard_required_notification_preference();

-- Any already-saved opt-out of what is now a required type is removed.
delete from public.notification_preferences
where notification_type = any(private.required_notification_types()) and not enabled;

-- ---------------------------------------------------------------------------
-- 7. Correction and data-access requests
-- ---------------------------------------------------------------------------

create table public.employee_record_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  kind text not null check (kind in ('correction', 'data_access')),
  field_key text,
  field_label text,
  current_value text,
  requested_value text,
  reason text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  applied boolean not null default false,
  requested_by uuid references auth.users(id),
  requested_at timestamptz not null default now(),
  decided_by uuid references auth.users(id),
  decided_at timestamptz,
  decision_note text,
  foreign key (employee_id, organization_id) references public.employees(id, organization_id) on delete cascade,
  check (kind <> 'correction' or (field_key is not null and nullif(btrim(coalesce(requested_value, '')), '') is not null))
);
alter table public.employee_record_requests enable row level security;
create index employee_record_requests_employee_idx on public.employee_record_requests(employee_id, requested_at desc);
create index employee_record_requests_org_status_idx on public.employee_record_requests(organization_id, status);
create unique index employee_record_requests_one_pending_per_field
  on public.employee_record_requests(employee_id, kind, coalesce(field_key, ''))
  where status = 'pending';

create policy "read own record requests" on public.employee_record_requests for select to authenticated
  using (employee_id = private.current_employee_id());
create policy "hr read record requests" on public.employee_record_requests for select to authenticated
  using (private.has_permission(organization_id, 'employee.manage'));
-- Writes only through the RPCs below.
grant select on public.employee_record_requests to authenticated;

-- Fields an employee can ask HR to correct. auto_apply fields are written
-- straight to the record when HR approves; the rest are changed by HR in
-- the employee's record (assignments are effective-dated and need HR's
-- judgment about the effective date) and the approval confirms it.
create or replace function private.correctable_fields()
returns table (field_key text, label text, auto_apply boolean)
language sql
immutable
set search_path = ''
as $$
  values
    ('first_name', 'Legal first name', true),
    ('middle_name', 'Legal middle name', true),
    ('last_name', 'Legal last name', true),
    ('date_of_birth', 'Date of birth', true),
    ('employee_number', 'Employee number', false),
    ('work_email', 'Work email', false),
    ('work_phone', 'Work phone', false),
    ('position', 'Position', false),
    ('department', 'Department', false),
    ('location', 'Work location', false),
    ('employment_type', 'Employment type', false),
    ('supervisor', 'Supervisor', false),
    ('manager', 'Manager', false),
    ('hire_date', 'Hire date', false),
    ('probation_end_date', 'Probation end date', false),
    ('government_id', 'Government ID', false),
    ('other', 'Something else', false)
$$;

create or replace function private.notify_employee_managers(
  p_organization_id uuid,
  p_employee_id uuid,
  p_type text,
  p_title text,
  p_body text,
  p_link text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user record;
  v_count integer := 0;
begin
  for v_user in
    select distinct e.user_id
    from public.employees e
    where e.organization_id = p_organization_id
      and e.user_id is not null
      and e.status <> 'terminated'
      and private.user_has_permission(p_organization_id, e.user_id, 'employee.manage')
  loop
    perform private.create_notification(p_organization_id, v_user.user_id, p_employee_id, p_type, p_title, p_body, p_link, '{}'::jsonb);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function public.submit_employee_record_request(
  p_kind text,
  p_field_key text default null,
  p_requested_value text default null,
  p_reason text default null
)
returns public.employee_record_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  v_field_key text;
  v_field_label text;
  v_request public.employee_record_requests;
  v_current text;
  v_name text;
begin
  select * into v_employee from public.employees where id = private.current_employee_id();
  if v_employee.id is null then
    raise exception using errcode = '42501', message = 'Only an employee can submit a request about their own record';
  end if;
  if p_kind not in ('correction', 'data_access') then
    raise exception using errcode = '22023', message = 'Unknown request type';
  end if;

  if p_kind = 'correction' then
    select f.field_key, f.label into v_field_key, v_field_label from private.correctable_fields() f where f.field_key = p_field_key;
    if v_field_key is null then
      raise exception using errcode = '22023', message = 'That field can''t be corrected through a request';
    end if;
    if nullif(btrim(coalesce(p_requested_value, '')), '') is null then
      raise exception using errcode = '22023', message = 'Say what the correct information should be';
    end if;
    if p_field_key = 'date_of_birth' then
      begin
        perform btrim(p_requested_value)::date;
      exception when others then
        raise exception using errcode = '22023', message = 'Enter the date of birth as YYYY-MM-DD';
      end;
    end if;

    -- A snapshot of what the record said when the employee asked.
    v_current := case p_field_key
      when 'first_name' then v_employee.first_name
      when 'middle_name' then v_employee.middle_name
      when 'last_name' then v_employee.last_name
      when 'employee_number' then v_employee.employee_number
      when 'work_email' then v_employee.work_email
      when 'work_phone' then v_employee.work_phone
      when 'hire_date' then v_employee.hire_date::text
      when 'probation_end_date' then v_employee.probation_end_date::text
      when 'date_of_birth' then (select p.date_of_birth::text from public.employee_private p where p.employee_id = v_employee.id)
      else null
    end;
  end if;

  if exists (
    select 1 from public.employee_record_requests r
    where r.employee_id = v_employee.id and r.kind = p_kind and r.status = 'pending'
      and coalesce(r.field_key, '') = coalesce(case when p_kind = 'correction' then p_field_key end, '')
  ) then
    raise exception using errcode = '23505', message = 'You already have a pending request for this — HR will respond to that one first';
  end if;

  insert into public.employee_record_requests (
    organization_id, employee_id, kind, field_key, field_label, current_value, requested_value, reason, requested_by
  ) values (
    v_employee.organization_id, v_employee.id, p_kind,
    case when p_kind = 'correction' then p_field_key end,
    case when p_kind = 'correction' then v_field_label else 'Copy of my personal information' end,
    v_current,
    nullif(btrim(coalesce(p_requested_value, '')), ''),
    nullif(btrim(coalesce(p_reason, '')), ''),
    auth.uid()
  )
  returning * into v_request;

  v_name := coalesce(nullif(btrim(v_employee.preferred_name), ''), v_employee.first_name) || ' ' || v_employee.last_name;
  perform private.notify_employee_managers(
    v_employee.organization_id, v_employee.id, 'record_request.submitted',
    case when p_kind = 'correction' then v_name || ' asked HR to correct their ' || lower(v_request.field_label)
         else v_name || ' requested a copy of their personal information' end,
    null, '/admin/employees/requests'
  );

  -- Field name only — the requested value may be sensitive (e.g. DOB).
  perform private.log_audit_event(
    v_employee.organization_id,
    case when p_kind = 'correction' then 'RECORD_CORRECTION_REQUESTED' else 'DATA_ACCESS_REQUESTED' end,
    'employee', v_employee.id, null,
    jsonb_build_object('request_id', v_request.id, 'field', v_request.field_key)
  );
  return v_request;
end;
$$;

revoke execute on function public.submit_employee_record_request(text, text, text, text) from public, anon;
grant execute on function public.submit_employee_record_request(text, text, text, text) to authenticated;

create or replace function public.cancel_employee_record_request(p_request_id uuid)
returns public.employee_record_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.employee_record_requests;
begin
  select * into v_request from public.employee_record_requests where id = p_request_id for update;
  if v_request.id is null or v_request.employee_id is distinct from private.current_employee_id() then
    raise exception using errcode = '42501', message = 'Not your request';
  end if;
  if v_request.status <> 'pending' then
    raise exception using errcode = '23514', message = 'Only a pending request can be withdrawn';
  end if;
  update public.employee_record_requests set status = 'cancelled', decided_at = now(), decided_by = auth.uid()
  where id = p_request_id returning * into v_request;
  perform private.log_audit_event(
    v_request.organization_id, 'RECORD_REQUEST_WITHDRAWN', 'employee', v_request.employee_id, null,
    jsonb_build_object('request_id', v_request.id, 'field', v_request.field_key)
  );
  return v_request;
end;
$$;

revoke execute on function public.cancel_employee_record_request(uuid) from public, anon;
grant execute on function public.cancel_employee_record_request(uuid) to authenticated;

create or replace function public.decide_employee_record_request(
  p_request_id uuid,
  p_approve boolean,
  p_note text default null
)
returns public.employee_record_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.employee_record_requests;
  v_auto boolean;
  v_user uuid;
begin
  select * into v_request from public.employee_record_requests where id = p_request_id for update;
  if v_request.id is null then
    raise exception 'Request not found';
  end if;
  if not private.has_permission(v_request.organization_id, 'employee.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to decide employee record requests';
  end if;
  if v_request.status <> 'pending' then
    raise exception using errcode = '23514', message = 'This request has already been handled';
  end if;
  if not p_approve and nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception using errcode = '22023', message = 'Explain to the employee why the request was declined';
  end if;

  v_auto := v_request.kind = 'correction'
    and coalesce((select f.auto_apply from private.correctable_fields() f where f.field_key = v_request.field_key), false);

  if p_approve and v_auto then
    -- The authoritative record changes here, under HR's identity, so the
    -- normal audit triggers record it too.
    if v_request.field_key in ('first_name', 'middle_name', 'last_name') then
      execute format('update public.employees set %I = $1 where id = $2', v_request.field_key)
      using btrim(v_request.requested_value), v_request.employee_id;
    elsif v_request.field_key = 'date_of_birth' then
      insert into public.employee_private (employee_id, organization_id, date_of_birth)
      values (v_request.employee_id, v_request.organization_id, btrim(v_request.requested_value)::date)
      on conflict (employee_id) do update set date_of_birth = excluded.date_of_birth;
    end if;
  end if;

  update public.employee_record_requests
  set status = case when p_approve then 'approved' else 'rejected' end,
      applied = p_approve and v_auto,
      decided_by = auth.uid(),
      decided_at = now(),
      decision_note = nullif(btrim(coalesce(p_note, '')), '')
  where id = p_request_id
  returning * into v_request;

  select user_id into v_user from public.employees where id = v_request.employee_id;
  if v_user is not null then
    perform private.create_notification(
      v_request.organization_id, v_user, v_request.employee_id, 'record_request.decided',
      case
        when v_request.kind = 'data_access' and p_approve then 'Your personal information request has been completed'
        when v_request.kind = 'data_access' then 'Your personal information request was declined'
        when p_approve then 'HR corrected your ' || lower(coalesce(v_request.field_label, 'record'))
        else 'HR declined your correction to your ' || lower(coalesce(v_request.field_label, 'record'))
      end,
      v_request.decision_note, '/profile#my-requests', jsonb_build_object('request_id', v_request.id)
    );
  end if;

  perform private.log_audit_event(
    v_request.organization_id,
    case
      when v_request.kind = 'data_access' then case when p_approve then 'DATA_ACCESS_COMPLETED' else 'DATA_ACCESS_DECLINED' end
      else case when p_approve then 'RECORD_CORRECTION_APPROVED' else 'RECORD_CORRECTION_REJECTED' end
    end,
    'employee', v_request.employee_id, null,
    jsonb_build_object('request_id', v_request.id, 'field', v_request.field_key, 'applied', v_request.applied)
  );
  return v_request;
end;
$$;

revoke execute on function public.decide_employee_record_request(uuid, boolean, text) from public, anon;
grant execute on function public.decide_employee_record_request(uuid, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Profile confirmation and completeness
-- ---------------------------------------------------------------------------

create or replace function public.confirm_my_profile()
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
begin
  select * into v_employee from public.employees where id = private.current_employee_id();
  if v_employee.id is null then
    raise exception using errcode = '42501', message = 'No employee record for the current user';
  end if;
  update public.employees set profile_last_confirmed_at = now() where id = v_employee.id;
  perform private.log_audit_event(v_employee.organization_id, 'EMPLOYEE_PROFILE_CONFIRMED', 'employee', v_employee.id, null, '{}'::jsonb);
  return now();
end;
$$;

revoke execute on function public.confirm_my_profile() from public, anon;
grant execute on function public.confirm_my_profile() to authenticated;

-- HR launches a verification round: every active employee with an account
-- gets a required notification asking them to review and confirm.
create or replace function public.request_profile_confirmation(p_organization_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee record;
  v_count integer := 0;
begin
  if not private.has_permission(p_organization_id, 'employee.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to request profile confirmation';
  end if;
  for v_employee in
    select id, user_id from public.employees
    where organization_id = p_organization_id and user_id is not null and status in ('active', 'leave')
  loop
    perform private.create_notification(
      p_organization_id, v_employee.user_id, v_employee.id, 'profile.confirmation_requested',
      'Please review and confirm your details',
      'HR has asked everyone to check that the information on file is still correct.',
      '/profile', '{}'::jsonb
    );
    v_count := v_count + 1;
  end loop;
  perform private.log_audit_event(p_organization_id, 'PROFILE_CONFIRMATION_REQUESTED', 'organization', p_organization_id, null,
    jsonb_build_object('employees_notified', v_count));
  return v_count;
end;
$$;

revoke execute on function public.request_profile_confirmation(uuid) from public, anon;
grant execute on function public.request_profile_confirmation(uuid) to authenticated;

-- People directory summary gains profile completeness (required personal
-- items — the same checks readiness uses — that are missing now, i.e.
-- also after activation) and the last confirmation date.
drop function if exists public.list_employee_setup_summary(uuid);

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
  onboarding_total integer,
  profile_missing text[],
  profile_last_confirmed_at timestamptz
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
    coalesce(latest.total, 0)::integer,
    coalesce((
      select array_agg(b->>'label' order by b->>'label')
      from jsonb_array_elements(r.readiness->'blockers') b
      where b->>'section' in ('personal', 'identifiers', 'emergency')
    ), '{}'),
    e.profile_last_confirmed_at
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
-- 11. The employee's own record, read-only, and a copy of their data
-- ---------------------------------------------------------------------------

-- An ordinary employee can't read their supervisor's employee row, so the
-- names of the people they report to (and other lookups) come from here.
create or replace function public.get_my_employee_record()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  v_assignment record;
  v_schedule text;
  v_prefs public.employee_setup_preferences;
  v_readiness jsonb;
begin
  select * into v_employee from public.employees where id = private.current_employee_id();
  if v_employee.id is null then
    return null;
  end if;

  select a.employment_type, a.start_date,
    ou.name as department, p.title as position, l.name as location,
    coalesce(nullif(btrim(sup.preferred_name), ''), sup.first_name) || ' ' || sup.last_name as supervisor,
    coalesce(nullif(btrim(mgr.preferred_name), ''), mgr.first_name) || ' ' || mgr.last_name as manager
  into v_assignment
  from public.employee_assignments a
  left join public.org_units ou on ou.id = a.org_unit_id
  left join public.positions p on p.id = a.position_id
  left join public.locations l on l.id = a.location_id
  left join public.employees sup on sup.id = a.supervisor_employee_id
  left join public.employees mgr on mgr.id = a.manager_employee_id
  where a.employee_id = v_employee.id and a.end_date is null;

  select ws.name into v_schedule
  from public.schedule_assignments sa
  join public.work_schedules ws on ws.id = sa.schedule_id
  where sa.employee_id = v_employee.id and sa.end_date is null
  limit 1;

  select * into v_prefs from public.employee_setup_preferences where organization_id = v_employee.organization_id;
  v_readiness := private.employee_setup_readiness(v_employee.id);

  return jsonb_build_object(
    'legal_name', concat_ws(' ', v_employee.first_name, nullif(btrim(v_employee.middle_name), ''), v_employee.last_name),
    'first_name', v_employee.first_name,
    'middle_name', v_employee.middle_name,
    'last_name', v_employee.last_name,
    'preferred_name', v_employee.preferred_name,
    'employee_number', v_employee.employee_number,
    'status', v_employee.status,
    'hire_date', v_employee.hire_date,
    'probation_end_date', v_employee.probation_end_date,
    'work_email', v_employee.work_email,
    'work_phone', v_employee.work_phone,
    'profile_last_confirmed_at', v_employee.profile_last_confirmed_at,
    'employment_type', v_assignment.employment_type,
    'position', v_assignment.position,
    'department', v_assignment.department,
    'location', v_assignment.location,
    'supervisor', v_assignment.supervisor,
    'manager', v_assignment.manager,
    'assignment_since', v_assignment.start_date,
    'schedule', v_schedule,
    'settings', jsonb_build_object(
      'collect_gender', coalesce(v_prefs.collect_gender, 'off'),
      'collect_marital_status', coalesce(v_prefs.collect_marital_status, 'off'),
      'work_phone_editable', coalesce(v_prefs.work_phone_editable_by_employee, false),
      'privacy_notice_url', v_prefs.privacy_notice_url,
      'can_update_self', private.has_permission(v_employee.organization_id, 'employee.update_self')
    ),
    -- Profile completeness: the organization's required personal items,
    -- evaluated now (not only before invitation).
    'profile_items', coalesce((
      select jsonb_agg(i) from jsonb_array_elements(v_readiness->'items') i
      where i->>'section' in ('personal', 'identifiers', 'emergency') and (i->>'required')::boolean
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.get_my_employee_record() from public, anon;
grant execute on function public.get_my_employee_record() to authenticated;

-- A self-service copy of the personal information HaloManage holds about
-- the caller (data-subject access). HR-only material — HR notes, and
-- compensation unless the employee can already see their own — is not in
-- the self-service copy; a formal request through HR covers the rest.
create or replace function public.get_my_personal_data()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
begin
  select * into v_employee from public.employees where id = private.current_employee_id();
  if v_employee.id is null then
    raise exception using errcode = '42501', message = 'No employee record for the current user';
  end if;

  perform private.log_audit_event(v_employee.organization_id, 'PERSONAL_DATA_EXPORTED', 'employee', v_employee.id, null, '{}'::jsonb);

  return jsonb_build_object(
    'generated_at', now(),
    'organization', (select o.name from public.organizations o where o.id = v_employee.organization_id),
    'employee_record', jsonb_build_object(
      'employee_number', v_employee.employee_number, 'first_name', v_employee.first_name,
      'middle_name', v_employee.middle_name, 'last_name', v_employee.last_name,
      'preferred_name', v_employee.preferred_name, 'work_email', v_employee.work_email,
      'work_phone', v_employee.work_phone, 'status', v_employee.status, 'hire_date', v_employee.hire_date,
      'probation_end_date', v_employee.probation_end_date, 'created_at', v_employee.created_at,
      'profile_last_confirmed_at', v_employee.profile_last_confirmed_at
    ),
    'personal_information', (
      select to_jsonb(p) - 'organization_id' - 'employee_id' from public.employee_private p where p.employee_id = v_employee.id
    ),
    'government_identifiers', coalesce((
      select jsonb_agg(jsonb_build_object('type', i.identifier_type, 'label', i.label, 'value', i.identifier_value,
        'country', i.country_code, 'issued_on', i.issued_on, 'expires_on', i.expires_on, 'verified', i.verified_at is not null))
      from public.employee_identifiers i where i.employee_id = v_employee.id
    ), '[]'::jsonb),
    'emergency_contacts', coalesce((
      select jsonb_agg(jsonb_build_object('name', c.full_name, 'relationship', c.relationship, 'phone', c.phone,
        'alternate_phone', c.alternate_phone, 'email', c.email, 'primary', c.is_primary))
      from public.employee_emergency_contacts c where c.employee_id = v_employee.id
    ), '[]'::jsonb),
    'employment_history', coalesce((
      select jsonb_agg(jsonb_build_object('from', a.start_date, 'to', a.end_date, 'department', ou.name,
        'position', p.title, 'location', l.name, 'employment_type', a.employment_type, 'reason', a.change_reason)
        order by a.start_date)
      from public.employee_assignments a
      left join public.org_units ou on ou.id = a.org_unit_id
      left join public.positions p on p.id = a.position_id
      left join public.locations l on l.id = a.location_id
      where a.employee_id = v_employee.id
    ), '[]'::jsonb),
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object('title', d.title, 'category', d.category, 'added', d.created_at))
      from public.documents d where d.employee_id = v_employee.id and d.visibility <> 'hr_only'
    ), '[]'::jsonb),
    'record_requests', coalesce((
      select jsonb_agg(jsonb_build_object('type', r.kind, 'field', r.field_label, 'status', r.status,
        'requested_at', r.requested_at, 'decided_at', r.decided_at, 'note', r.decision_note))
      from public.employee_record_requests r where r.employee_id = v_employee.id
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.get_my_personal_data() from public, anon;
grant execute on function public.get_my_personal_data() to authenticated;
