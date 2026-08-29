-- Halomanage — rewards: notifications + the automatic-fulfillment failure path
--
-- Two gaps closed, both explicitly called for and neither built in the
-- first pass:
--   1. fail_redemption() — the state-machine transition an automatic_api
--      fulfillment attempt needs when the vendor's API call errors: refund
--      the points, restore inventory, record why. Building this now (ahead
--      of any real vendor integration) means the failure path is tested
--      before it's ever load-bearing, not bolted on afterward.
--   2. Every status-changing action in this module now raises a real
--      notification through the existing private.create_notification()
--      helper (in-app now; email/SMS delivery is the pre-existing
--      send-notifications Edge Function's job, unchanged by this file).

create or replace function public.fail_redemption(
  p_redemption_id uuid,
  p_error_message text default null
)
returns public.reward_redemptions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_redemption public.reward_redemptions;
  v_employee_user uuid;
begin
  select * into v_redemption from public.reward_redemptions where id = p_redemption_id for update;
  if v_redemption.id is null then
    raise exception 'Redemption not found';
  end if;
  if not private.has_permission(v_redemption.organization_id, 'rewards.fulfill') then
    raise exception using errcode = '42501', message = 'Not authorized to update redemptions for this organization';
  end if;
  if v_redemption.status <> 'pending_fulfillment' then
    raise exception using errcode = '23514', message = 'Only a redemption awaiting fulfillment can be marked failed';
  end if;

  update public.reward_redemptions
  set status = 'failed', fulfillment_note = nullif(trim(p_error_message), '')
  where id = p_redemption_id
  returning * into v_redemption;

  insert into public.employee_points_ledger (organization_id, employee_id, entry_type, amount, reason, related_redemption_id, created_by)
  values (v_redemption.organization_id, v_redemption.employee_id, 'refund', v_redemption.points_spent,
    'Refund: fulfillment failed', v_redemption.id, (select auth.uid()));

  update public.reward_products
  set inventory_quantity = inventory_quantity + 1
  where id = v_redemption.product_id and inventory_quantity is not null;

  select user_id into v_employee_user from public.employees where id = v_redemption.employee_id;
  if v_employee_user is not null then
    perform private.create_notification(
      v_redemption.organization_id, v_employee_user, v_redemption.employee_id,
      'rewards.redemption_failed', 'A reward redemption couldn''t be completed',
      'Your points have been refunded. ' || coalesce(p_error_message, ''),
      '/rewards', jsonb_build_object('redemption_id', v_redemption.id)
    );
  end if;

  perform private.log_audit_event(
    v_redemption.organization_id, 'REWARD_REDEMPTION_FAILED', 'reward_redemption', v_redemption.id, null,
    jsonb_build_object('error_message', p_error_message)
  );
  return v_redemption;
end;
$$;

revoke all on function public.fail_redemption(uuid, text) from public, anon;
grant execute on function public.fail_redemption(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Notify the employee at every status-changing step. Awarding/redeeming/
-- fulfilling/cancelling logic is unchanged from the previous migration —
-- create or replace only adds the notification call at the end of each.
-- ---------------------------------------------------------------------------

create or replace function public.award_employee_points(
  p_employee_id uuid,
  p_amount integer,
  p_reason text default null
)
returns public.employee_points_ledger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  v_entry public.employee_points_ledger;
begin
  select * into v_employee from public.employees where id = p_employee_id;
  if v_employee.id is null then
    raise exception 'Employee not found';
  end if;
  if not private.has_permission(v_employee.organization_id, 'rewards.award_points') then
    raise exception using errcode = '42501', message = 'Not authorized to award points in this organization';
  end if;
  if v_employee.status = 'terminated' then
    raise exception using errcode = '23514', message = 'Cannot award points to a terminated employee';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception using errcode = '22023', message = 'Award amount must be a positive number of points';
  end if;

  insert into public.employee_points_ledger (organization_id, employee_id, entry_type, amount, reason, created_by)
  values (v_employee.organization_id, p_employee_id, 'award', p_amount, nullif(trim(p_reason), ''), (select auth.uid()))
  returning * into v_entry;

  if v_employee.user_id is not null then
    perform private.create_notification(
      v_employee.organization_id, v_employee.user_id, p_employee_id,
      'rewards.points_awarded', 'You received ' || p_amount || ' points!',
      p_reason, '/rewards', jsonb_build_object('amount', p_amount)
    );
  end if;

  perform private.log_audit_event(
    v_employee.organization_id, 'REWARD_POINTS_AWARDED', 'employee', p_employee_id, null,
    jsonb_build_object('amount', p_amount, 'reason', p_reason)
  );
  return v_entry;
end;
$$;

create or replace function public.fulfill_redemption(
  p_redemption_id uuid,
  p_note text default null
)
returns public.reward_redemptions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_redemption public.reward_redemptions;
  v_product_name text;
  v_employee_user uuid;
begin
  select * into v_redemption from public.reward_redemptions where id = p_redemption_id for update;
  if v_redemption.id is null then
    raise exception 'Redemption not found';
  end if;
  if not private.has_permission(v_redemption.organization_id, 'rewards.fulfill') then
    raise exception using errcode = '42501', message = 'Not authorized to fulfill redemptions for this organization';
  end if;
  if v_redemption.status <> 'pending_fulfillment' then
    raise exception using errcode = '23514', message = 'This redemption is not awaiting fulfillment';
  end if;

  update public.reward_redemptions
  set status = 'fulfilled', fulfillment_note = nullif(trim(p_note), ''), fulfilled_by = (select auth.uid()), fulfilled_at = now()
  where id = p_redemption_id
  returning * into v_redemption;

  select name into v_product_name from public.reward_products where id = v_redemption.product_id;
  select user_id into v_employee_user from public.employees where id = v_redemption.employee_id;
  if v_employee_user is not null then
    perform private.create_notification(
      v_redemption.organization_id, v_employee_user, v_redemption.employee_id,
      'rewards.redemption_fulfilled', 'Your reward is ready: ' || coalesce(v_product_name, ''),
      p_note, '/rewards', jsonb_build_object('redemption_id', v_redemption.id)
    );
  end if;

  perform private.log_audit_event(
    v_redemption.organization_id, 'REWARD_REDEMPTION_FULFILLED', 'reward_redemption', v_redemption.id, null, to_jsonb(v_redemption)
  );
  return v_redemption;
end;
$$;

create or replace function public.cancel_redemption(
  p_redemption_id uuid,
  p_reason text default null
)
returns public.reward_redemptions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_redemption public.reward_redemptions;
  v_employee_user uuid;
begin
  select * into v_redemption from public.reward_redemptions where id = p_redemption_id for update;
  if v_redemption.id is null then
    raise exception 'Redemption not found';
  end if;
  if not private.has_permission(v_redemption.organization_id, 'rewards.fulfill') then
    raise exception using errcode = '42501', message = 'Not authorized to cancel redemptions for this organization';
  end if;
  if v_redemption.status <> 'pending_fulfillment' then
    raise exception using errcode = '23514', message = 'Only a redemption awaiting fulfillment can be cancelled';
  end if;

  update public.reward_redemptions
  set status = 'cancelled', cancelled_reason = nullif(trim(p_reason), '')
  where id = p_redemption_id
  returning * into v_redemption;

  insert into public.employee_points_ledger (organization_id, employee_id, entry_type, amount, reason, related_redemption_id, created_by)
  values (v_redemption.organization_id, v_redemption.employee_id, 'refund', v_redemption.points_spent,
    'Refund: cancelled redemption', v_redemption.id, (select auth.uid()));

  update public.reward_products
  set inventory_quantity = inventory_quantity + 1
  where id = v_redemption.product_id and inventory_quantity is not null;

  select user_id into v_employee_user from public.employees where id = v_redemption.employee_id;
  if v_employee_user is not null then
    perform private.create_notification(
      v_redemption.organization_id, v_employee_user, v_redemption.employee_id,
      'rewards.redemption_cancelled', 'A reward redemption was cancelled',
      coalesce('Your points were refunded. ' || p_reason, 'Your points were refunded.'),
      '/rewards', jsonb_build_object('redemption_id', v_redemption.id)
    );
  end if;

  perform private.log_audit_event(
    v_redemption.organization_id, 'REWARD_REDEMPTION_CANCELLED', 'reward_redemption', v_redemption.id, null,
    jsonb_build_object('reason', p_reason)
  );
  return v_redemption;
end;
$$;
