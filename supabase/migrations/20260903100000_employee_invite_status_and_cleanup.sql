-- Halomanage — invite acceptance visibility, wrong-address correction, and
-- safe deletion of never-active employee records
--
-- Direct user finding on the People directory: "Invited" only ever meant
-- "an auth account was created for this address" (employees.user_id is
-- set) — it said nothing about whether the person had actually accepted
-- and signed in, so there was no way to tell "should I resend this" from
-- "this one's fine, leave it." Two more gaps came with it: no way to fix
-- an invite sent to the wrong address short of editing the database
-- directly, and no way to remove a record created by mistake — the
-- schema deliberately has no DELETE policy on employees at all (see
-- 20260818000400_authorization.sql's comment: history/audit/payroll-
-- import references must stay valid), which is correct for anyone with
-- real activity but left no path for a placeholder that was never right.

-- ---------------------------------------------------------------------------
-- 1. Invite acceptance status — auth.users isn't reachable from the client
--    at all (no RLS, not exposed by PostgREST), so this has to be a
--    SECURITY DEFINER RPC. last_sign_in_at is the same signal
--    invite-employee's own resend guard already uses server-side
--    ("This employee has already signed in at least once — there's
--    nothing to resend.") — this just surfaces it to the UI instead of
--    only ever enforcing it after the fact.
-- ---------------------------------------------------------------------------

create or replace function public.list_employee_invite_status(p_organization_id uuid)
returns table (
  employee_id uuid,
  accepted boolean,
  invited_at timestamptz,
  last_sign_in_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_permission(p_organization_id, 'employee.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to view account status for this organization';
  end if;

  return query
    select e.id, (u.last_sign_in_at is not null), u.invited_at, u.last_sign_in_at
    from public.employees e
    join auth.users u on u.id = e.user_id
    where e.organization_id = p_organization_id;
end;
$$;

revoke execute on function public.list_employee_invite_status(uuid) from public, anon;
grant execute on function public.list_employee_invite_status(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Audit logging for the invite-employee Edge Function's new
--    "correct_email" mode. The email/user_id write itself happens through
--    that function's service-role admin client (deleting the stale,
--    never-signed-in auth user and clearing employees.user_id so a fresh
--    Invite can go out to the corrected address) — this RPC exists only
--    so the audit trail attributes the action to the real calling admin
--    instead of a null/service-role actor, called via the *caller-scoped*
--    client the Edge Function already holds for its permission check.
-- ---------------------------------------------------------------------------

create or replace function public.record_employee_email_correction(p_employee_id uuid, p_old_email text, p_new_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
begin
  select organization_id into v_org_id from public.employees where id = p_employee_id;
  if v_org_id is null then
    raise exception 'Employee not found';
  end if;
  if not private.has_permission(v_org_id, 'employee.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to manage this employee';
  end if;

  perform private.log_audit_event(
    v_org_id, 'EMPLOYEE_INVITE_EMAIL_CORRECTED', 'employee', p_employee_id,
    jsonb_build_object('work_email', p_old_email),
    jsonb_build_object('work_email', p_new_email)
  );
end;
$$;

revoke execute on function public.record_employee_email_correction(uuid, text, text) from public, anon;
grant execute on function public.record_employee_email_correction(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Safe deletion — deliberately narrow. Only a pre-hire record that has
--    never had an account linked can be hard-deleted; anyone who has ever
--    been active, or who has a linked account (accepted or still
--    pending), must go through terminate_employee() instead, which
--    preserves history the way this schema's design requires. A pending
--    (never-signed-in) invite is unlinked first via the Edge Function's
--    "correct_email" cleanup path or a future dedicated unlink action —
--    this RPC does not itself touch auth.users.
--
--    Catching foreign_key_violation on the DELETE itself is NOT enough:
--    most employee_id references in this schema are ON DELETE CASCADE
--    (employee_assignments, leave_requests, documents, and many more) —
--    exactly so terminate_employee() can remove an assignment history row
--    without a hard error, which is correct for a real termination. For a
--    RECORD BEING ERASED OUTRIGHT, that same CASCADE would silently wipe
--    real history with no error and nothing to catch (caught by this
--    migration's own pglite test, not by inspection). So this walks
--    pg_catalog for every foreign key in the public schema that points at
--    employees.id and checks each one for an existing row itself, before
--    ever attempting the delete — schema-driven rather than a
--    hand-maintained table list, so a future migration that adds a new
--    employee_id reference is covered automatically without anyone
--    needing to remember to update this function too.
-- ---------------------------------------------------------------------------

create or replace function public.delete_employee_record(p_employee_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  v_fk record;
  v_has_rows boolean;
begin
  select * into v_employee from public.employees where id = p_employee_id for update;
  if v_employee.id is null then
    raise exception 'Employee not found';
  end if;
  if not private.has_permission(v_employee.organization_id, 'employee.manage') then
    raise exception using errcode = '42501', message = 'Not authorized to manage this employee';
  end if;
  if v_employee.status <> 'prehire' then
    raise exception using errcode = '23514', message = 'Only a pre-hire record can be deleted. Use Terminate for anyone who has been active.';
  end if;
  if v_employee.user_id is not null then
    raise exception using errcode = '23514', message = 'This employee has a linked account. Correct or remove the invitation first.';
  end if;

  for v_fk in
    select distinct tc.table_name, kcu.column_name
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on kcu.constraint_name = tc.constraint_name and kcu.constraint_schema = tc.constraint_schema
    join information_schema.constraint_column_usage ccu
      on ccu.constraint_name = tc.constraint_name and ccu.constraint_schema = tc.constraint_schema
    where tc.constraint_type = 'FOREIGN KEY'
      and tc.table_schema = 'public'
      and ccu.table_schema = 'public'
      and ccu.table_name = 'employees'
      and ccu.column_name = 'id'
      and tc.table_name <> 'employees'
  loop
    execute format('select exists (select 1 from public.%I where %I = $1)', v_fk.table_name, v_fk.column_name)
      into v_has_rows using p_employee_id;
    if v_has_rows then
      raise exception using errcode = '23514',
        message = format('This record has related history (%s) and cannot be deleted. Use Terminate instead.', v_fk.table_name);
    end if;
  end loop;

  perform private.log_audit_event(
    v_employee.organization_id, 'EMPLOYEE_RECORD_DELETED', 'employee', p_employee_id,
    to_jsonb(v_employee), null
  );

  delete from public.employees where id = p_employee_id;
end;
$$;

revoke execute on function public.delete_employee_record(uuid) from public, anon;
grant execute on function public.delete_employee_record(uuid) to authenticated;
