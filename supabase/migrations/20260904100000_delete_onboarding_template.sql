-- Halomanage — delete an onboarding template
--
-- RLS already permits this directly (the existing "admins manage
-- onboarding templates" policy is FOR ALL, not just SELECT/UPDATE/INSERT)
-- and the schema itself already protects real history: onboarding_runs
-- references onboarding_template_versions with ON DELETE RESTRICT, and
-- versions cascade from templates — so deleting a template that has ever
-- actually onboarded someone fails at the database level regardless of
-- this RPC. This exists only to turn that raw foreign-key-violation into
-- a message someone can act on, and to record the deletion in the audit
-- trail the way every other destructive action in this schema does.

create or replace function public.delete_onboarding_template(p_template_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_template public.onboarding_templates;
begin
  select * into v_template from public.onboarding_templates where id = p_template_id;
  if v_template.id is null then
    raise exception 'Template not found';
  end if;
  if not private.has_permission(v_template.organization_id, 'onboarding.manage_templates') then
    raise exception using errcode = '42501', message = 'Not authorized to manage onboarding templates for this organization';
  end if;

  perform private.log_audit_event(
    v_template.organization_id, 'ONBOARDING_TEMPLATE_DELETED', 'onboarding_template', p_template_id,
    to_jsonb(v_template), null
  );

  begin
    delete from public.onboarding_templates where id = p_template_id;
  exception when foreign_key_violation then
    raise exception using errcode = '23514',
      message = 'This template has already been used to onboard at least one employee and can''t be deleted.';
  end;
end;
$$;

revoke execute on function public.delete_onboarding_template(uuid) from public, anon;
grant execute on function public.delete_onboarding_template(uuid) to authenticated;
