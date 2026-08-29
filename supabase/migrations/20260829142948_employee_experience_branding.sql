-- Organization profile and tenant-owned employee portal branding.
--
-- Profile data is stored in typed columns instead of the catch-all settings
-- JSON. Branding has one row per organization and is only mutated through
-- validated, audited RPCs. The anonymous portal lookup remains deliberately
-- narrow: it returns only values intended to appear on a public sign-in page.

alter table public.organizations
  add column if not exists legal_name text,
  add column if not exists contact_email public.citext,
  add column if not exists phone_number text,
  add column if not exists website_url text,
  add column if not exists address_line1 text,
  add column if not exists address_line2 text,
  add column if not exists city text,
  add column if not exists region text,
  add column if not exists postal_code text;

alter table public.organizations
  add constraint organizations_legal_name_length
    check (legal_name is null or char_length(legal_name) between 2 and 200),
  add constraint organizations_contact_email_format
    check (
      contact_email is null
      or (
        char_length(contact_email::text) <= 254
        and contact_email::text ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      )
    ),
  add constraint organizations_phone_number_format
    check (
      phone_number is null
      or (
        char_length(phone_number) between 7 and 32
        and phone_number ~ '^\+?[0-9() .-]+$'
      )
    ),
  add constraint organizations_website_url_format
    check (
      website_url is null
      or (char_length(website_url) <= 2048 and website_url ~* '^https://[^[:space:]]+$')
    ),
  add constraint organizations_profile_address_lengths
    check (
      (address_line1 is null or char_length(address_line1) <= 180)
      and (address_line2 is null or char_length(address_line2) <= 180)
      and (city is null or char_length(city) <= 100)
      and (region is null or char_length(region) <= 100)
      and (postal_code is null or char_length(postal_code) <= 24)
    );

create table public.organization_branding (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  portal_enabled boolean not null default true,
  portal_title text not null,
  portal_message text not null,
  logo_path text,
  primary_color text not null default '#101B3D',
  accent_color text not null default '#F2B84B',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_branding_title_length
    check (char_length(btrim(portal_title)) between 1 and 100),
  constraint organization_branding_message_length
    check (char_length(btrim(portal_message)) between 1 and 240),
  constraint organization_branding_logo_path_format
    check (
      logo_path is null
      or (
        char_length(logo_path) <= 512
        and logo_path ~* '^[0-9a-f-]{36}/[a-z0-9][a-z0-9._-]*\.(png|jpe?g|webp)$'
      )
    ),
  constraint organization_branding_primary_color_format
    check (primary_color ~ '^#[0-9A-F]{6}$'),
  constraint organization_branding_accent_color_format
    check (accent_color ~ '^#[0-9A-F]{6}$')
);

alter table public.organization_branding enable row level security;

create trigger organization_branding_set_updated_at
  before update on public.organization_branding
  for each row execute function private.set_updated_at();

insert into public.organization_branding (
  organization_id,
  portal_enabled,
  portal_title,
  portal_message,
  logo_path,
  primary_color,
  accent_color
)
select
  o.id,
  coalesce((o.settings->>'portal_enabled')::boolean, true),
  coalesce(nullif(btrim(o.settings->>'portal_title'), ''), 'Welcome to ' || o.name),
  coalesce(
    nullif(btrim(o.settings->>'portal_message'), ''),
    'Sign in to manage your workday, time away, documents, and development.'
  ),
  nullif(btrim(o.settings->>'portal_logo_path'), ''),
  case
    when upper(coalesce(o.settings->>'portal_primary_color', '')) ~ '^#[0-9A-F]{6}$'
      then upper(o.settings->>'portal_primary_color')
    else '#101B3D'
  end,
  case
    when upper(coalesce(o.settings->>'portal_accent_color', '')) ~ '^#[0-9A-F]{6}$'
      then upper(o.settings->>'portal_accent_color')
    else '#F2B84B'
  end
from public.organizations o
on conflict (organization_id) do nothing;

create or replace function private.create_default_organization_branding()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.organization_branding (
    organization_id, portal_title, portal_message
  ) values (
    new.id,
    'Welcome to ' || new.name,
    'Sign in to manage your workday, time away, documents, and development.'
  )
  on conflict (organization_id) do nothing;
  return new;
end;
$$;

create trigger organizations_create_default_branding
  after insert on public.organizations
  for each row execute function private.create_default_organization_branding();

create policy "organization members read branding"
  on public.organization_branding for select to authenticated
  using (private.is_org_member(organization_id));

comment on table public.organization_branding is
  'One tenant-owned public sign-in identity per organization. Anonymous callers can only read its safe projection through get_organization_portal().';

-- Public logo assets intentionally live in a public bucket because they are
-- rendered before authentication. Upload, replacement, and deletion still
-- require organization.manage and a tenant-prefixed object path.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'organization-branding',
  'organization-branding',
  true,
  2097152,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "organization admins inspect branding objects"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'organization-branding'
    and exists (
      select 1
      from public.organizations o
      where o.id::text = (storage.foldername(name))[1]
        and private.has_permission(o.id, 'organization.manage')
    )
  );

create policy "organization admins upload branding objects"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'organization-branding'
    and exists (
      select 1
      from public.organizations o
      where o.id::text = (storage.foldername(name))[1]
        and private.has_permission(o.id, 'organization.manage')
    )
  );

create policy "organization admins replace branding objects"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'organization-branding'
    and exists (
      select 1
      from public.organizations o
      where o.id::text = (storage.foldername(name))[1]
        and private.has_permission(o.id, 'organization.manage')
    )
  )
  with check (
    bucket_id = 'organization-branding'
    and exists (
      select 1
      from public.organizations o
      where o.id::text = (storage.foldername(name))[1]
        and private.has_permission(o.id, 'organization.manage')
    )
  );

create policy "organization admins delete branding objects"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'organization-branding'
    and exists (
      select 1
      from public.organizations o
      where o.id::text = (storage.foldername(name))[1]
        and private.has_permission(o.id, 'organization.manage')
    )
  );

create or replace function public.update_organization_profile(
  p_organization_id uuid,
  p_name text,
  p_legal_name text default null,
  p_contact_email text default null,
  p_phone_number text default null,
  p_website_url text default null,
  p_address_line1 text default null,
  p_address_line2 text default null,
  p_city text default null,
  p_region text default null,
  p_postal_code text default null,
  p_country_code text default null,
  p_timezone text default 'UTC',
  p_default_locale text default 'en'
)
returns table (
  organization_id uuid,
  name text,
  legal_name text,
  contact_email text,
  phone_number text,
  website_url text,
  address_line1 text,
  address_line2 text,
  city text,
  region text,
  postal_code text,
  country_code text,
  timezone text,
  default_locale text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_legal_name text := nullif(btrim(p_legal_name), '');
  v_contact_email text := lower(nullif(btrim(p_contact_email), ''));
  v_phone_number text := nullif(btrim(p_phone_number), '');
  v_website_url text := nullif(btrim(p_website_url), '');
  v_address_line1 text := nullif(btrim(p_address_line1), '');
  v_address_line2 text := nullif(btrim(p_address_line2), '');
  v_city text := nullif(btrim(p_city), '');
  v_region text := nullif(btrim(p_region), '');
  v_postal_code text := nullif(btrim(p_postal_code), '');
  v_country_code text := upper(nullif(btrim(p_country_code), ''));
  v_timezone text := nullif(btrim(p_timezone), '');
  v_default_locale text := lower(nullif(btrim(p_default_locale), ''));
  v_old jsonb;
  v_new jsonb;
begin
  if (select auth.uid()) is null
     or not private.has_permission(p_organization_id, 'organization.manage') then
    raise exception using errcode = '42501', message = 'Only an organization administrator can update the company profile';
  end if;

  if char_length(v_name) < 2 or char_length(v_name) > 160 then
    raise exception using errcode = '22023', message = 'Company name must contain 2 to 160 characters';
  end if;
  if v_legal_name is not null and char_length(v_legal_name) > 200 then
    raise exception using errcode = '22023', message = 'Legal name must be 200 characters or fewer';
  end if;
  if v_contact_email is not null
     and (char_length(v_contact_email) > 254 or v_contact_email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then
    raise exception using errcode = '22023', message = 'Enter a valid company contact email';
  end if;
  if v_phone_number is not null
     and (char_length(v_phone_number) < 7 or char_length(v_phone_number) > 32 or v_phone_number !~ '^\+?[0-9() .-]+$') then
    raise exception using errcode = '22023', message = 'Enter a valid company phone number';
  end if;
  if v_website_url is not null
     and (char_length(v_website_url) > 2048 or v_website_url !~* '^https://[^[:space:]]+$') then
    raise exception using errcode = '22023', message = 'Company website must be a valid HTTPS address';
  end if;
  if v_address_line1 is not null and char_length(v_address_line1) > 180
     or v_address_line2 is not null and char_length(v_address_line2) > 180
     or v_city is not null and char_length(v_city) > 100
     or v_region is not null and char_length(v_region) > 100
     or v_postal_code is not null and char_length(v_postal_code) > 24 then
    raise exception using errcode = '22023', message = 'One or more address fields are too long';
  end if;
  if v_country_code is not null and v_country_code !~ '^[A-Z]{2}$' then
    raise exception using errcode = '22023', message = 'Country must be a two-letter ISO code';
  end if;
  if v_timezone is null
     or not exists (select 1 from pg_catalog.pg_timezone_names tz where tz.name = v_timezone) then
    raise exception using errcode = '22023', message = 'Select a valid IANA timezone';
  end if;
  if v_default_locale not in ('en', 'es', 'fr') then
    raise exception using errcode = '22023', message = 'Select a supported default language';
  end if;

  select jsonb_build_object(
    'name', o.name,
    'legal_name', o.legal_name,
    'contact_email', o.contact_email,
    'phone_number', o.phone_number,
    'website_url', o.website_url,
    'address_line1', o.address_line1,
    'address_line2', o.address_line2,
    'city', o.city,
    'region', o.region,
    'postal_code', o.postal_code,
    'country_code', o.country_code,
    'timezone', o.timezone,
    'default_locale', o.default_locale
  ) into v_old
  from public.organizations o
  where o.id = p_organization_id
  for update;

  if v_old is null then
    raise exception using errcode = 'P0002', message = 'Organization not found';
  end if;

  update public.organizations o
  set name = v_name,
      legal_name = v_legal_name,
      contact_email = v_contact_email::public.citext,
      phone_number = v_phone_number,
      website_url = v_website_url,
      address_line1 = v_address_line1,
      address_line2 = v_address_line2,
      city = v_city,
      region = v_region,
      postal_code = v_postal_code,
      country_code = v_country_code,
      timezone = v_timezone,
      default_locale = v_default_locale
  where o.id = p_organization_id;

  select jsonb_build_object(
    'name', o.name,
    'legal_name', o.legal_name,
    'contact_email', o.contact_email,
    'phone_number', o.phone_number,
    'website_url', o.website_url,
    'address_line1', o.address_line1,
    'address_line2', o.address_line2,
    'city', o.city,
    'region', o.region,
    'postal_code', o.postal_code,
    'country_code', o.country_code,
    'timezone', o.timezone,
    'default_locale', o.default_locale
  ) into v_new
  from public.organizations o
  where o.id = p_organization_id;

  perform private.log_audit_event(
    p_organization_id,
    'ORGANIZATION_PROFILE_UPDATED',
    'organization',
    p_organization_id,
    v_old,
    v_new
  );

  return query
  select
    o.id,
    o.name,
    o.legal_name,
    o.contact_email::text,
    o.phone_number,
    o.website_url,
    o.address_line1,
    o.address_line2,
    o.city,
    o.region,
    o.postal_code,
    o.country_code,
    o.timezone,
    o.default_locale
  from public.organizations o
  where o.id = p_organization_id;
end;
$$;

create or replace function public.update_organization_branding(
  p_organization_id uuid,
  p_slug text,
  p_portal_enabled boolean,
  p_portal_title text,
  p_portal_message text,
  p_logo_path text default null,
  p_primary_color text default '#101B3D',
  p_accent_color text default '#F2B84B'
)
returns table (
  slug text,
  portal_enabled boolean,
  portal_title text,
  portal_message text,
  logo_path text,
  primary_color text,
  accent_color text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slug text := trim(both '-' from regexp_replace(lower(coalesce(p_slug, '')), '[^a-z0-9]+', '-', 'g'));
  v_portal_title text := btrim(coalesce(p_portal_title, ''));
  v_portal_message text := btrim(coalesce(p_portal_message, ''));
  v_logo_path text := nullif(btrim(p_logo_path), '');
  v_primary_color text := upper(btrim(coalesce(p_primary_color, '')));
  v_accent_color text := upper(btrim(coalesce(p_accent_color, '')));
  v_old jsonb;
  v_new jsonb;
begin
  if (select auth.uid()) is null
     or not private.has_permission(p_organization_id, 'organization.manage') then
    raise exception using errcode = '42501', message = 'Only an organization administrator can update employee portal branding';
  end if;

  if char_length(v_slug) < 3 or char_length(v_slug) > 50 then
    raise exception using errcode = '22023', message = 'Portal address must contain 3 to 50 letters, numbers, or hyphens';
  end if;
  if v_slug in ('admin', 'api', 'auth', 'dashboard', 'login', 'portal', 'signup', 'support', 'www') then
    raise exception using errcode = '22023', message = 'That portal address is reserved';
  end if;
  if char_length(v_portal_title) < 1 or char_length(v_portal_title) > 100 then
    raise exception using errcode = '22023', message = 'Portal heading must contain 1 to 100 characters';
  end if;
  if char_length(v_portal_message) < 1 or char_length(v_portal_message) > 240 then
    raise exception using errcode = '22023', message = 'Portal message must contain 1 to 240 characters';
  end if;
  if v_primary_color !~ '^#[0-9A-F]{6}$' or v_accent_color !~ '^#[0-9A-F]{6}$' then
    raise exception using errcode = '22023', message = 'Brand colors must use six-digit hexadecimal values';
  end if;
  if v_logo_path is not null and (
    char_length(v_logo_path) > 512
    or split_part(v_logo_path, '/', 1) <> p_organization_id::text
    or v_logo_path !~* '^[0-9a-f-]{36}/[a-z0-9][a-z0-9._-]*\.(png|jpe?g|webp)$'
  ) then
    raise exception using errcode = '22023', message = 'Logo must be an approved image in this organization branding folder';
  end if;

  select jsonb_build_object(
    'slug', o.slug,
    'portal_enabled', b.portal_enabled,
    'portal_title', b.portal_title,
    'portal_message', b.portal_message,
    'logo_path', b.logo_path,
    'primary_color', b.primary_color,
    'accent_color', b.accent_color
  ) into v_old
  from public.organizations o
  left join public.organization_branding b on b.organization_id = o.id
  where o.id = p_organization_id
  for update of o;

  if v_old is null then
    raise exception using errcode = 'P0002', message = 'Organization not found';
  end if;

  update public.organizations o
  set slug = v_slug,
      settings = o.settings || jsonb_build_object('portal_enabled', p_portal_enabled)
  where o.id = p_organization_id;

  insert into public.organization_branding (
    organization_id,
    portal_enabled,
    portal_title,
    portal_message,
    logo_path,
    primary_color,
    accent_color
  ) values (
    p_organization_id,
    p_portal_enabled,
    v_portal_title,
    v_portal_message,
    v_logo_path,
    v_primary_color,
    v_accent_color
  )
  on conflict (organization_id) do update
    set portal_enabled = excluded.portal_enabled,
        portal_title = excluded.portal_title,
        portal_message = excluded.portal_message,
        logo_path = excluded.logo_path,
        primary_color = excluded.primary_color,
        accent_color = excluded.accent_color;

  select jsonb_build_object(
    'slug', o.slug,
    'portal_enabled', b.portal_enabled,
    'portal_title', b.portal_title,
    'portal_message', b.portal_message,
    'logo_path', b.logo_path,
    'primary_color', b.primary_color,
    'accent_color', b.accent_color
  ) into v_new
  from public.organizations o
  join public.organization_branding b on b.organization_id = o.id
  where o.id = p_organization_id;

  perform private.log_audit_event(
    p_organization_id,
    'ORGANIZATION_BRANDING_UPDATED',
    'organization_branding',
    p_organization_id,
    v_old,
    v_new
  );

  return query
  select
    o.slug::text,
    b.portal_enabled,
    b.portal_title,
    b.portal_message,
    b.logo_path,
    b.primary_color,
    b.accent_color
  from public.organizations o
  join public.organization_branding b on b.organization_id = o.id
  where o.id = p_organization_id;
exception
  when unique_violation then
    raise exception using errcode = '23505', message = 'That employee portal address is already in use';
end;
$$;

-- Keep the original four-argument RPC working for older clients while moving
-- its welcome copy out of settings JSON and into organization_branding.
create or replace function public.update_organization_portal(
  p_organization_id uuid,
  p_slug text,
  p_portal_title text default null,
  p_portal_message text default null
)
returns public.organizations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branding public.organization_branding;
  v_organization public.organizations;
begin
  select * into v_branding
  from public.organization_branding b
  where b.organization_id = p_organization_id;

  perform 1
  from public.update_organization_branding(
    p_organization_id,
    p_slug,
    coalesce(v_branding.portal_enabled, true),
    coalesce(nullif(btrim(p_portal_title), ''), 'Welcome to ' || (select o.name from public.organizations o where o.id = p_organization_id)),
    coalesce(nullif(btrim(p_portal_message), ''), 'Sign in to manage your workday, time away, documents, and development.'),
    v_branding.logo_path,
    coalesce(v_branding.primary_color, '#101B3D'),
    coalesce(v_branding.accent_color, '#F2B84B')
  );

  select * into v_organization
  from public.organizations o
  where o.id = p_organization_id;
  return v_organization;
end;
$$;

-- Anonymous and authenticated sign-in pages receive the same intentionally
-- public projection. No organization IDs, settings JSON, contacts, addresses,
-- employee data, or storage metadata are exposed.
drop function if exists public.get_organization_portal(text);
create function public.get_organization_portal(p_slug text)
returns table (
  name text,
  slug text,
  portal_title text,
  portal_message text,
  logo_path text,
  primary_color text,
  accent_color text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    o.name,
    o.slug::text,
    b.portal_title,
    b.portal_message,
    b.logo_path,
    b.primary_color,
    b.accent_color
  from public.organizations o
  join public.organization_branding b on b.organization_id = o.id
  where o.slug = lower(btrim(p_slug))::public.citext
    and o.is_active
    and b.portal_enabled
  limit 1;
$$;

-- Data API privileges are explicit. RLS still determines readable rows, and
-- all profile/branding writes flow through the validated RPCs above.
revoke all on public.organization_branding from anon;
revoke insert, update, delete on public.organization_branding from authenticated;
grant select on public.organization_branding to authenticated;

revoke insert, update, delete on public.organizations from authenticated;
grant select on public.organizations to authenticated;

revoke execute on function public.update_organization_profile(
  uuid, text, text, text, text, text, text, text, text, text, text, text, text, text
) from public, anon;
grant execute on function public.update_organization_profile(
  uuid, text, text, text, text, text, text, text, text, text, text, text, text, text
) to authenticated;

revoke execute on function public.update_organization_branding(
  uuid, text, boolean, text, text, text, text, text
) from public, anon;
grant execute on function public.update_organization_branding(
  uuid, text, boolean, text, text, text, text, text
) to authenticated;

revoke execute on function public.update_organization_portal(uuid, text, text, text)
  from public, anon;
grant execute on function public.update_organization_portal(uuid, text, text, text)
  to authenticated;

revoke execute on function public.get_organization_portal(text) from public;
grant execute on function public.get_organization_portal(text) to anon, authenticated;

revoke execute on function private.create_default_organization_branding() from public, anon, authenticated;
