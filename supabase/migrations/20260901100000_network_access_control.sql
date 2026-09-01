-- Halomanage — organization-configurable network access control
--
-- Lets a company restrict sign-in (and, in enforced mode, ongoing use) to
-- an approved set of IP ranges — "only sign in from our office network" —
-- with exemptions by role, custom role, or individual employee. Two
-- enforcement layers, deliberately different in strength:
--
-- 1. App layer (proxy.ts, see the Next.js repo): checked on every request,
--    for every page, and sees the *real* visitor IP correctly regardless
--    of whether the page is server-rendered or client-rendered. This is
--    the layer that actually delivers "only usable from an approved
--    network" — verified empirically against this project's own Railway
--    deployment that its `x-real-ip` header is set authoritatively by
--    Railway's edge and cannot be overridden by a client-supplied header
--    of the same name (tested directly: a spoofed X-Real-IP sent by the
--    client was silently replaced, not honored).
-- 2. Database layer (private.has_permission(), below): defense in depth
--    against someone who already has a valid session token bypassing the
--    app entirely and calling Supabase's REST API directly. This layer
--    can ONLY see the real visitor IP for requests that go straight from
--    a browser to Supabase (via Cloudflare's non-spoofable
--    cf-connecting-ip header, also verified empirically) — a
--    server-rendered page's query to Supabase originates from Railway's
--    own server, which the database cannot distinguish from a stray
--    request. Requests relayed through this app's own server carry an
--    internal marker header (see lib/supabase/server.ts) that this layer
--    trusts as "the app-layer check already ran for this exact request";
--    only a request WITHOUT that marker is checked against
--    cf-connecting-ip. This is not cryptographically signed — a
--    determined attacker who both stole a session token AND knew this
--    internal header name could still set it themselves. Closing that
--    fully would require signing the marker, a meaningfully bigger and
--    more fragile piece of infrastructure that was deliberately not
--    built here; this layer's job is raising the bar on casual
--    stolen-token reuse, not providing a cryptographic guarantee.

create table public.organization_network_policies (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  -- 'disabled': feature off. 'monitor': every request is evaluated and a
  -- would-have-been-blocked attempt is logged, but nothing is actually
  -- blocked — lets an admin validate their ranges before turning on real
  -- enforcement without locking anyone out by mistake. 'enforced': blocks.
  enforcement_mode text not null default 'disabled' check (enforcement_mode in ('disabled', 'monitor', 'enforced')),
  updated_at timestamptz not null default now()
);
alter table public.organization_network_policies enable row level security;

create trigger organization_network_policies_set_updated_at
  before update on public.organization_network_policies
  for each row execute function private.set_updated_at();

create policy "read organization network policy" on public.organization_network_policies for select to authenticated
  using (private.is_org_member(organization_id));
revoke insert, update, delete on table public.organization_network_policies from authenticated;
grant select on table public.organization_network_policies to authenticated;

create table public.organization_network_ranges (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  cidr cidr not null,
  label text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (organization_id, cidr)
);
alter table public.organization_network_ranges enable row level security;
create index organization_network_ranges_org_idx on public.organization_network_ranges(organization_id);

create policy "read organization network ranges" on public.organization_network_ranges for select to authenticated
  using (private.is_org_member(organization_id));
revoke insert, update, delete on table public.organization_network_ranges from authenticated;
grant select on table public.organization_network_ranges to authenticated;

create table public.organization_network_exemptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  role public.app_role,
  custom_role_id uuid references public.organization_roles(id) on delete cascade,
  employee_id uuid references public.employees(id) on delete cascade,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  check (
    (case when role is not null then 1 else 0 end)
    + (case when custom_role_id is not null then 1 else 0 end)
    + (case when employee_id is not null then 1 else 0 end) = 1
  )
);
alter table public.organization_network_exemptions enable row level security;
create index organization_network_exemptions_org_idx on public.organization_network_exemptions(organization_id);
create unique index organization_network_exemptions_role_key on public.organization_network_exemptions(organization_id, role) where role is not null;
create unique index organization_network_exemptions_custom_role_key on public.organization_network_exemptions(organization_id, custom_role_id) where custom_role_id is not null;
create unique index organization_network_exemptions_employee_key on public.organization_network_exemptions(organization_id, employee_id) where employee_id is not null;

create policy "read organization network exemptions" on public.organization_network_exemptions for select to authenticated
  using (private.is_org_member(organization_id));
revoke insert, update, delete on table public.organization_network_exemptions from authenticated;
grant select on table public.organization_network_exemptions to authenticated;

-- ---------------------------------------------------------------------------
-- Shared exemption resolution — is the CURRENT caller exempt for this org,
-- via their active built-in role, active custom role, or their own
-- employee record? Used by both enforcement layers so they never disagree.
-- ---------------------------------------------------------------------------

create or replace function private.is_network_exempt(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.role_assignments ra
    where ra.user_id = (select auth.uid())
      and ra.organization_id = p_organization_id
      and ra.valid_from <= now() and (ra.valid_until is null or ra.valid_until > now())
      and (
        (ra.role is not null and exists (
          select 1 from public.organization_network_exemptions ex
          where ex.organization_id = p_organization_id and ex.role = ra.role
        ))
        or (ra.custom_role_id is not null and exists (
          select 1 from public.organization_network_exemptions ex
          where ex.organization_id = p_organization_id and ex.custom_role_id = ra.custom_role_id
        ))
      )
  )
  or exists (
    select 1
    from public.employees e
    join public.organization_network_exemptions ex on ex.organization_id = p_organization_id and ex.employee_id = e.id
    where e.user_id = (select auth.uid()) and e.organization_id = p_organization_id
  );
$$;

-- ---------------------------------------------------------------------------
-- App-layer entry point — called once per request from proxy.ts with the
-- real visitor IP (Railway's x-real-ip, verified non-spoofable). Resolves
-- the caller's organization itself rather than accepting one as an
-- argument, so a client can never probe a different org's policy.
-- ---------------------------------------------------------------------------

create or replace function public.check_network_access(p_ip inet)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
  v_employee_id uuid;
  v_mode text;
  v_in_range boolean;
  v_exempt boolean;
begin
  select e.organization_id, e.id into v_organization_id, v_employee_id
  from public.employees e
  where e.user_id = auth.uid()
  limit 1;

  if v_organization_id is null then
    return jsonb_build_object('allowed', true, 'mode', 'disabled', 'reason', 'no_organization');
  end if;

  select enforcement_mode into v_mode
  from public.organization_network_policies
  where organization_id = v_organization_id;

  if v_mode is null or v_mode = 'disabled' then
    return jsonb_build_object('allowed', true, 'mode', coalesce(v_mode, 'disabled'));
  end if;

  -- Enforcement turned on but no ranges configured yet — never lock an
  -- entire org out because it flipped the switch before adding its first
  -- range. The admin UI will make this state hard to reach by requiring at
  -- least one range before enabling anything but 'disabled', but this is
  -- the safety net if it happens anyway.
  if not exists (select 1 from public.organization_network_ranges where organization_id = v_organization_id) then
    return jsonb_build_object('allowed', true, 'mode', v_mode, 'reason', 'no_ranges_configured');
  end if;

  v_exempt := private.is_network_exempt(v_organization_id);
  if v_exempt then
    return jsonb_build_object('allowed', true, 'mode', v_mode, 'reason', 'exempt');
  end if;

  select exists (
    select 1 from public.organization_network_ranges r
    where r.organization_id = v_organization_id and p_ip <<= r.cidr
  ) into v_in_range;

  if not v_in_range then
    insert into public.audit_events (organization_id, actor_user_id, employee_id, action, entity_type, ip_address, new_data)
    values (
      v_organization_id, auth.uid(), v_employee_id,
      case when v_mode = 'enforced' then 'NETWORK_ACCESS_BLOCKED' else 'NETWORK_ACCESS_FLAGGED' end,
      'network_policy', p_ip, jsonb_build_object('mode', v_mode)
    );
  end if;

  return jsonb_build_object(
    'allowed', v_in_range or v_mode = 'monitor',
    'mode', v_mode,
    'reason', case when v_in_range then 'in_range' when v_mode = 'monitor' then 'flagged_monitor_mode' else 'out_of_range' end
  );
end;
$$;

revoke execute on function public.check_network_access(inet) from public, anon;
grant execute on function public.check_network_access(inet) to authenticated;

-- ---------------------------------------------------------------------------
-- Database-layer partial check — folded into has_permission() so it
-- protects every RLS policy and RPC that already calls it, but is a no-op
-- for requests relayed through this app's own server (see the header this
-- checks for in lib/supabase/server.ts) and for any organization without
-- enforcement turned on. Every other line of has_permission() is
-- unchanged from 20260831100000_custom_organization_roles.sql.
-- ---------------------------------------------------------------------------

create or replace function private.network_policy_ok(p_organization_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_headers jsonb;
  v_mode text;
  v_client_ip inet;
begin
  begin
    v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    v_headers := null;
  end;

  -- A request this app's own server relayed already passed the app-layer
  -- check in proxy.ts for this exact request — see the comment at the top
  -- of this migration for what this header does and does not guarantee.
  if v_headers is not null and v_headers ? 'x-halomanage-server-relay' then
    return true;
  end if;

  select enforcement_mode into v_mode
  from public.organization_network_policies
  where organization_id = p_organization_id;

  if v_mode is null or v_mode = 'disabled' then
    return true;
  end if;
  if not exists (select 1 from public.organization_network_ranges where organization_id = p_organization_id) then
    return true;
  end if;
  if private.is_network_exempt(p_organization_id) then
    return true;
  end if;

  begin
    v_client_ip := nullif(v_headers ->> 'cf-connecting-ip', '')::inet;
  exception when others then
    v_client_ip := null;
  end;

  -- No forwarded-IP header at all (not a real HTTP request through
  -- PostgREST — e.g. a pglite/psql session, or Postgres calling this from
  -- a trigger) means there is nothing to check against; fail open rather
  -- than break every non-HTTP caller.
  if v_client_ip is null then
    return true;
  end if;

  if v_mode = 'monitor' then
    return true;
  end if;

  return exists (
    select 1 from public.organization_network_ranges r
    where r.organization_id = p_organization_id and v_client_ip <<= r.cidr
  );
end;
$$;

create or replace function private.has_permission(p_org_id uuid, p_permission public.app_permission)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.user_has_permission(p_org_id, (select auth.uid()), p_permission)
    and private.network_policy_ok(p_org_id);
$$;

-- ---------------------------------------------------------------------------
-- Admin CRUD — all narrow, gated on organization.manage (the same
-- permission the existing SSO/"Identity & access" settings use).
-- ---------------------------------------------------------------------------

create or replace function public.set_network_enforcement_mode(p_organization_id uuid, p_mode text)
returns public.organization_network_policies
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_policy public.organization_network_policies;
begin
  -- Deliberately private.user_has_permission() (the network-check-free
  -- variant), not private.has_permission() — an admin who steps off the
  -- allowed network under an 'enforced' policy must always be able to
  -- reach these five RPCs to fix or turn off the policy themselves.
  -- Gating configuration of the lock behind the lock itself would turn
  -- one off-network moment into a support ticket.
  if not private.user_has_permission(p_organization_id, auth.uid(), 'organization.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to manage network access for this organization';
  end if;
  if p_mode not in ('disabled', 'monitor', 'enforced') then
    raise exception using errcode = '22023', message = 'Mode must be disabled, monitor, or enforced';
  end if;
  if p_mode = 'enforced' and not exists (
    select 1 from public.organization_network_ranges where organization_id = p_organization_id
  ) then
    raise exception using errcode = '23514', message = 'Add at least one allowed network range before turning on enforcement';
  end if;

  insert into public.organization_network_policies (organization_id, enforcement_mode)
  values (p_organization_id, p_mode)
  on conflict (organization_id) do update set enforcement_mode = excluded.enforcement_mode
  returning * into v_policy;

  perform private.log_audit_event(
    p_organization_id, 'NETWORK_POLICY_MODE_CHANGED', 'network_policy', null,
    null, jsonb_build_object('mode', p_mode)
  );
  return v_policy;
end;
$$;

revoke execute on function public.set_network_enforcement_mode(uuid, text) from public, anon;
grant execute on function public.set_network_enforcement_mode(uuid, text) to authenticated;

create or replace function public.add_network_range(p_organization_id uuid, p_cidr text, p_label text default null)
returns public.organization_network_ranges
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cidr cidr;
  v_range public.organization_network_ranges;
begin
  -- See set_network_enforcement_mode() above for why this is
  -- user_has_permission(), not has_permission().
  if not private.user_has_permission(p_organization_id, auth.uid(), 'organization.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to manage network access for this organization';
  end if;

  begin
    v_cidr := p_cidr::cidr;
  exception when others then
    raise exception using errcode = '22023', message = format('"%s" is not a valid IP address or CIDR range (example: 203.0.113.0/24)', p_cidr);
  end;

  insert into public.organization_network_ranges (organization_id, cidr, label, created_by)
  values (p_organization_id, v_cidr, nullif(btrim(coalesce(p_label, '')), ''), auth.uid())
  returning * into v_range;

  perform private.log_audit_event(
    p_organization_id, 'NETWORK_RANGE_ADDED', 'network_policy', v_range.id,
    null, jsonb_build_object('cidr', v_cidr::text, 'label', v_range.label)
  );
  return v_range;
end;
$$;

revoke execute on function public.add_network_range(uuid, text, text) from public, anon;
grant execute on function public.add_network_range(uuid, text, text) to authenticated;

create or replace function public.remove_network_range(p_range_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_range public.organization_network_ranges;
begin
  select * into v_range from public.organization_network_ranges where id = p_range_id;
  if v_range.id is null then
    raise exception 'Network range not found';
  end if;
  -- See set_network_enforcement_mode() above for why this is
  -- user_has_permission(), not has_permission().
  if not private.user_has_permission(v_range.organization_id, auth.uid(), 'organization.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to manage network access for this organization';
  end if;

  delete from public.organization_network_ranges where id = p_range_id;

  perform private.log_audit_event(
    v_range.organization_id, 'NETWORK_RANGE_REMOVED', 'network_policy', p_range_id,
    jsonb_build_object('cidr', v_range.cidr::text, 'label', v_range.label), null
  );
end;
$$;

revoke execute on function public.remove_network_range(uuid) from public, anon;
grant execute on function public.remove_network_range(uuid) to authenticated;

create or replace function public.add_network_exemption(
  p_organization_id uuid,
  p_role public.app_role default null,
  p_custom_role_id uuid default null,
  p_employee_id uuid default null
)
returns public.organization_network_exemptions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target_count integer;
  v_exemption public.organization_network_exemptions;
begin
  -- See set_network_enforcement_mode() above for why this is
  -- user_has_permission(), not has_permission().
  if not private.user_has_permission(p_organization_id, auth.uid(), 'organization.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to manage network access for this organization';
  end if;

  v_target_count := (case when p_role is not null then 1 else 0 end)
    + (case when p_custom_role_id is not null then 1 else 0 end)
    + (case when p_employee_id is not null then 1 else 0 end);
  if v_target_count <> 1 then
    raise exception using errcode = '22023', message = 'Provide exactly one of a built-in role, a custom role, or an employee to exempt';
  end if;

  if p_custom_role_id is not null and not exists (
    select 1 from public.organization_roles orr where orr.id = p_custom_role_id and orr.organization_id = p_organization_id
  ) then
    raise exception using errcode = '23514', message = 'That role does not belong to this organization';
  end if;
  if p_employee_id is not null and not exists (
    select 1 from public.employees e where e.id = p_employee_id and e.organization_id = p_organization_id
  ) then
    raise exception using errcode = '23514', message = 'That employee does not belong to this organization';
  end if;

  insert into public.organization_network_exemptions (organization_id, role, custom_role_id, employee_id, created_by)
  values (p_organization_id, p_role, p_custom_role_id, p_employee_id, auth.uid())
  returning * into v_exemption;

  perform private.log_audit_event(
    p_organization_id, 'NETWORK_EXEMPTION_ADDED', 'network_policy', v_exemption.id,
    null, jsonb_build_object('role', p_role, 'custom_role_id', p_custom_role_id, 'employee_id', p_employee_id)
  );
  return v_exemption;
end;
$$;

revoke execute on function public.add_network_exemption(uuid, public.app_role, uuid, uuid) from public, anon;
grant execute on function public.add_network_exemption(uuid, public.app_role, uuid, uuid) to authenticated;

create or replace function public.remove_network_exemption(p_exemption_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_exemption public.organization_network_exemptions;
begin
  select * into v_exemption from public.organization_network_exemptions where id = p_exemption_id;
  if v_exemption.id is null then
    raise exception 'Exemption not found';
  end if;
  -- See set_network_enforcement_mode() above for why this is
  -- user_has_permission(), not has_permission().
  if not private.user_has_permission(v_exemption.organization_id, auth.uid(), 'organization.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to manage network access for this organization';
  end if;

  delete from public.organization_network_exemptions where id = p_exemption_id;

  perform private.log_audit_event(
    v_exemption.organization_id, 'NETWORK_EXEMPTION_REMOVED', 'network_policy', p_exemption_id,
    jsonb_build_object('role', v_exemption.role, 'custom_role_id', v_exemption.custom_role_id, 'employee_id', v_exemption.employee_id), null
  );
end;
$$;

revoke execute on function public.remove_network_exemption(uuid) from public, anon;
grant execute on function public.remove_network_exemption(uuid) to authenticated;

comment on table public.organization_network_policies is
  'Per-organization network access control. See check_network_access() (app-layer, called from proxy.ts) and private.network_policy_ok() (folded into has_permission() for direct-to-Supabase calls) for the two enforcement layers, and the migration header comment for why they differ in strength.';
