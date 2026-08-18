-- Halomanage — application audit trail
-- Ref: ARCHITECTURE.md "Audit architecture" — this is the *business* audit
-- log (leave approved, payroll imported, role changed...), distinct from
-- Supabase's automatic Auth audit logs (login/password events) and from
-- optional PGAudit/platform logs. All three exist; none replaces another.

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_user_id uuid references auth.users(id),
  employee_id uuid references public.employees(id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  old_data jsonb,
  new_data jsonb,
  request_id text,
  ip_address inet,
  user_agent text,
  created_at timestamptz not null default now()
);
alter table public.audit_events enable row level security;
create index audit_events_org_idx on public.audit_events(organization_id, created_at desc);
create index audit_events_entity_idx on public.audit_events(entity_type, entity_id);
create index audit_events_actor_idx on public.audit_events(actor_user_id);

comment on table public.audit_events is
  'Append-only business audit trail. Never store credentials, raw secrets, or full sensitive document contents in old_data/new_data.';

-- Insert-only from the client is *not* granted directly — audit rows are
-- written by SECURITY DEFINER RPCs/triggers via private.log_audit_event(),
-- so a compromised or buggy client can log actions but can never forge,
-- edit or delete someone else's audit history.
create or replace function private.log_audit_event(
  p_organization_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_old_data jsonb default null,
  p_new_data jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.audit_events (
    organization_id, actor_user_id, employee_id, action, entity_type, entity_id, old_data, new_data
  )
  values (
    p_organization_id,
    auth.uid(),
    private.current_employee_id(),
    p_action,
    p_entity_type,
    p_entity_id,
    p_old_data,
    p_new_data
  )
  returning id into v_id;

  return v_id;
end;
$$;

create policy "read own audit history" on public.audit_events for select to authenticated
  using (actor_user_id = (select auth.uid()));
create policy "auditors read organization audit history" on public.audit_events for select to authenticated
  using (private.has_permission(organization_id, 'audit.read'));
-- No insert/update/delete policy for authenticated: audit_events is only
-- ever written through private.log_audit_event() (SECURITY DEFINER) and is
-- otherwise immutable — not even an Admin can edit or delete an entry.
