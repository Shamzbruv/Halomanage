-- Halomanage — peer-to-peer recognition
--
-- Deliberately separate from an employee's redeemable points balance:
-- recognizing a coworker draws from an organization-configurable monthly
-- GIVING allowance, never from what the giver themselves has to spend.
-- Points on a recognition are optional — a company can run recognition as
-- pure kudos (monthly_point_allowance = 0), or attach real points, or both,
-- entirely by policy. The reward catalog/vendor model added earlier is
-- untouched by this migration.

-- ============================ ORG POLICY + VALUES ==============================

create table public.organization_recognition_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  -- 0 means points-based recognition is off org-wide — pure kudos only.
  -- Not a separate boolean: one number is the single source of truth for
  -- "how much can anyone give away," and 0 is a perfectly good answer.
  monthly_point_allowance integer not null default 0 check (monthly_point_allowance >= 0),
  max_points_per_recognition integer check (max_points_per_recognition is null or max_points_per_recognition > 0),
  max_recognitions_per_day_per_giver integer check (max_recognitions_per_day_per_giver is null or max_recognitions_per_day_per_giver > 0),
  default_visibility text not null default 'public' check (default_visibility in ('public', 'private')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.organization_recognition_settings enable row level security;
create trigger organization_recognition_settings_set_updated_at before update on public.organization_recognition_settings
  for each row execute function private.set_updated_at();

comment on table public.organization_recognition_settings is
  'One row per organization. A missing row is never treated as "unlimited" — give_recognition() requires one to exist.';

create policy "org members read recognition settings" on public.organization_recognition_settings for select to authenticated
  using (private.is_org_member(organization_id));
create policy "manage recognition settings" on public.organization_recognition_settings for all to authenticated
  using (private.has_permission(organization_id, 'rewards.manage_catalog'))
  with check (private.has_permission(organization_id, 'rewards.manage_catalog'));

-- Every organization gets a settings row (allowance 0 — an admin opts in,
-- never surprised by a feature that showed up already able to move points).
insert into public.organization_recognition_settings (organization_id)
select o.id from public.organizations o
on conflict (organization_id) do nothing;

create or replace function private.create_default_recognition_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.organization_recognition_settings (organization_id) values (new.id)
  on conflict (organization_id) do nothing;
  return new;
end;
$$;

create trigger organizations_create_default_recognition_settings
  after insert on public.organizations
  for each row execute function private.create_default_recognition_settings();

create table public.recognition_values (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, name)
);
alter table public.recognition_values enable row level security;
create index recognition_values_org_idx on public.recognition_values(organization_id);

create policy "org members read recognition values" on public.recognition_values for select to authenticated
  using (private.is_org_member(organization_id));
create policy "manage recognition values" on public.recognition_values for all to authenticated
  using (private.has_permission(organization_id, 'rewards.manage_catalog'))
  with check (private.has_permission(organization_id, 'rewards.manage_catalog'));

-- A starter set so the feature isn't an empty dropdown on day one — the
-- same reasoning as seeding starter leave types/schedules elsewhere.
insert into public.recognition_values (organization_id, name, description)
select o.id, v.name, v.description
from public.organizations o
cross join (values
  ('Teamwork', 'Went out of their way to help someone else succeed'),
  ('Innovation', 'Found a better way to do something'),
  ('Customer Focus', 'Made things better for the people we serve'),
  ('Above & Beyond', 'Did more than what was asked')
) as v(name, description)
on conflict (organization_id, name) do nothing;

-- ============================ RECOGNITION EVENTS ================================

create table public.recognitions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  giver_employee_id uuid not null references public.employees(id) on delete cascade,
  recipient_employee_id uuid not null references public.employees(id) on delete cascade,
  recognition_value_id uuid references public.recognition_values(id) on delete set null,
  message text not null check (char_length(btrim(message)) between 1 and 500),
  points_given integer not null default 0 check (points_given >= 0),
  visibility text not null check (visibility in ('public', 'private')),
  created_at timestamptz not null default now(),
  check (giver_employee_id <> recipient_employee_id)
);
alter table public.recognitions enable row level security;
create index recognitions_org_idx on public.recognitions(organization_id, created_at desc);
create index recognitions_giver_idx on public.recognitions(giver_employee_id, created_at desc);
create index recognitions_recipient_idx on public.recognitions(recipient_employee_id, created_at desc);

comment on table public.recognitions is
  'The recognition event itself. A points_given > 0 row also has a matching entry_type=recognition row in employee_points_ledger — this table is never the source of truth for balances, the ledger is.';

create policy "read public recognitions" on public.recognitions for select to authenticated
  using (visibility = 'public' and private.is_org_member(organization_id));
create policy "read own given or received recognitions" on public.recognitions for select to authenticated
  using (
    giver_employee_id = private.current_employee_id()
    or recipient_employee_id = private.current_employee_id()
  );
create policy "admins read all recognitions" on public.recognitions for select to authenticated
  using (private.has_permission(organization_id, 'rewards.award_points'));
-- No direct insert/update/delete — only give_recognition() writes, and a
-- recognition is never edited or deleted once given (it's a record of a
-- real moment, not catalog data).
revoke insert, update, delete on public.recognitions from authenticated;

alter table public.employee_points_ledger
  add column if not exists related_recognition_id uuid references public.recognitions(id) on delete set null;

alter table public.employee_points_ledger drop constraint if exists employee_points_ledger_entry_type_check;
alter table public.employee_points_ledger
  add constraint employee_points_ledger_entry_type_check
  check (entry_type in ('award', 'redemption', 'refund', 'adjustment', 'expiry', 'recognition'));

-- ---------------------------------------------------------------------------
-- RPC
-- ---------------------------------------------------------------------------

create or replace function public.give_recognition(
  p_recipient_employee_id uuid,
  p_message text,
  p_recognition_value_id uuid default null,
  p_points integer default 0,
  p_visibility text default null
)
returns public.recognitions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_giver_id uuid;
  v_giver public.employees;
  v_recipient public.employees;
  v_settings public.organization_recognition_settings;
  v_points integer := coalesce(p_points, 0);
  v_visibility text;
  v_given_this_month integer;
  v_recognitions_today integer;
  v_recognition public.recognitions;
begin
  v_giver_id := private.current_employee_id();
  if v_giver_id is null then
    raise exception using errcode = '42501', message = 'You must be an active employee to give recognition';
  end if;

  select * into v_giver from public.employees where id = v_giver_id;
  if not private.has_permission(v_giver.organization_id, 'recognition.give') then
    raise exception using errcode = '42501', message = 'Not authorized to give recognition in this organization';
  end if;

  select * into v_recipient from public.employees where id = p_recipient_employee_id;
  if v_recipient.id is null or v_recipient.organization_id <> v_giver.organization_id or v_recipient.status = 'terminated' then
    raise exception using errcode = '23514', message = 'Choose an active coworker in your organization';
  end if;
  if v_recipient.id = v_giver_id then
    raise exception using errcode = '23514', message = 'You cannot recognize yourself';
  end if;

  if nullif(btrim(p_message), '') is null then
    raise exception using errcode = '22023', message = 'Add a short message with your recognition';
  end if;
  if char_length(btrim(p_message)) > 500 then
    raise exception using errcode = '22023', message = 'Message must be 500 characters or fewer';
  end if;
  if v_points < 0 then
    raise exception using errcode = '22023', message = 'Points cannot be negative';
  end if;

  select * into v_settings from public.organization_recognition_settings where organization_id = v_giver.organization_id;
  if v_settings.organization_id is null then
    raise exception 'Recognition is not configured for this organization yet';
  end if;

  v_visibility := coalesce(nullif(p_visibility, ''), v_settings.default_visibility);
  if v_visibility not in ('public', 'private') then
    raise exception using errcode = '22023', message = 'Invalid visibility';
  end if;

  if v_points > 0 then
    if v_settings.monthly_point_allowance = 0 then
      raise exception using errcode = '23514', message = 'Points-based recognition is not enabled for your organization';
    end if;
    if v_settings.max_points_per_recognition is not null and v_points > v_settings.max_points_per_recognition then
      raise exception using errcode = '23514',
        message = format('A single recognition cannot exceed %s points', v_settings.max_points_per_recognition);
    end if;

    -- Serialize this giver's allowance check-and-spend so two concurrent
    -- recognitions can't both pass the check against the same starting total.
    perform pg_advisory_xact_lock(hashtextextended(v_giver_id::text, 92));

    select coalesce(sum(points_given), 0) into v_given_this_month
    from public.recognitions
    where giver_employee_id = v_giver_id
      and created_at >= date_trunc('month', now());

    if v_given_this_month + v_points > v_settings.monthly_point_allowance then
      raise exception using errcode = '23514',
        message = format('This would exceed your monthly recognition point allowance (%s remaining)', greatest(v_settings.monthly_point_allowance - v_given_this_month, 0));
    end if;
  end if;

  if v_settings.max_recognitions_per_day_per_giver is not null then
    select count(*) into v_recognitions_today
    from public.recognitions
    where giver_employee_id = v_giver_id
      and created_at >= date_trunc('day', now());
    if v_recognitions_today >= v_settings.max_recognitions_per_day_per_giver then
      raise exception using errcode = '23514',
        message = format('You can give up to %s recognitions per day', v_settings.max_recognitions_per_day_per_giver);
    end if;
  end if;

  insert into public.recognitions (
    organization_id, giver_employee_id, recipient_employee_id, recognition_value_id, message, points_given, visibility
  ) values (
    v_giver.organization_id, v_giver_id, p_recipient_employee_id, p_recognition_value_id, btrim(p_message), v_points, v_visibility
  )
  returning * into v_recognition;

  if v_points > 0 then
    insert into public.employee_points_ledger (
      organization_id, employee_id, entry_type, amount, reason, related_recognition_id, created_by
    ) values (
      v_giver.organization_id, p_recipient_employee_id, 'recognition', v_points,
      'Recognized by ' || v_giver.first_name || ' ' || v_giver.last_name, v_recognition.id, (select auth.uid())
    );
  end if;

  if v_recipient.user_id is not null then
    perform private.create_notification(
      v_giver.organization_id, v_recipient.user_id, p_recipient_employee_id,
      'recognition.received', v_giver.first_name || ' ' || v_giver.last_name || ' recognized you!',
      p_message, '/recognition', jsonb_build_object('recognition_id', v_recognition.id, 'points', v_points)
    );
  end if;

  perform private.log_audit_event(
    v_giver.organization_id, 'RECOGNITION_GIVEN', 'recognition', v_recognition.id, null, to_jsonb(v_recognition)
  );
  return v_recognition;
end;
$$;

revoke all on function public.give_recognition(uuid, text, uuid, integer, text) from public, anon;
grant execute on function public.give_recognition(uuid, text, uuid, integer, text) to authenticated;

-- ============================ PERMISSIONS =======================================

insert into public.role_permissions (organization_id, role, permission) values
  -- Peer recognition is "any employee," by design — re-declared per role
  -- for the same reason every other self-service permission is (roles
  -- don't inherit from one another in this schema).
  (null, 'employee', 'recognition.give'),
  (null, 'supervisor', 'recognition.give'),
  (null, 'manager', 'recognition.give'),
  (null, 'admin', 'recognition.give')
on conflict do nothing;
