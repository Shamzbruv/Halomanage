-- Halomanage — rewards & recognition marketplace: permission vocabulary
--
-- Its own migration file, containing nothing but ALTER TYPE ... ADD VALUE —
-- Postgres cannot use a newly added enum value in the same transaction that
-- added it, and this project's migrations apply as one transaction per file.
-- Everything that references these permissions lives in the next migration.

alter type public.app_permission add value if not exists 'rewards.read_self';
alter type public.app_permission add value if not exists 'rewards.redeem_self';
alter type public.app_permission add value if not exists 'rewards.award_points';
alter type public.app_permission add value if not exists 'rewards.manage_catalog';
alter type public.app_permission add value if not exists 'rewards.fulfill';
