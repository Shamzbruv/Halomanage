-- Halomanage — peer-to-peer recognition: permission vocabulary
--
-- Its own migration file — ALTER TYPE ... ADD VALUE cannot be used in the
-- same transaction that added it, and this project's migrations apply as
-- one transaction per file. Everything that references this permission
-- lives in the next migration.
--
-- Reuses rewards.manage_catalog / rewards.award_points for the admin side
-- of recognition (configuring values/allowance policy, seeing every
-- recognition in the org) — recognition is a mode of the same rewards
-- program, not a separate permission domain, so it doesn't need its own
-- "manage" permission. It does need its own "give" permission: recognizing
-- a coworker is a distinct action from spending or awarding points.

alter type public.app_permission add value if not exists 'recognition.give';
