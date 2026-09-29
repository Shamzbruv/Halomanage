-- Halomanage — onboarding.read_team permission (enum value only)
--
-- Split out from 20260910100000_employee_setup_and_invitation_readiness.sql
-- for the same reason as 20260829100000_compensation_permissions_enum.sql:
-- a new enum value cannot be used in the same transaction that adds it.
--
-- onboarding.read_team lets someone monitor onboarding for people in their
-- management scope without also being able to alter it
-- (onboarding.manage_team).

alter type public.app_permission add value if not exists 'onboarding.read_team';
