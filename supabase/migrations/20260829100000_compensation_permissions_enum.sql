-- Halomanage — compensation permission vocabulary
--
-- Deliberately its own migration file, containing nothing but
-- ALTER TYPE ... ADD VALUE. Postgres cannot use a newly added enum value in
-- the same transaction that added it (even with IF NOT EXISTS), and this
-- project's migrations apply as one transaction per file (via the CLI and
-- via the Management API `database/query` call this project also uses) —
-- so every statement that references these permissions (role_permissions
-- seed rows, RLS policies) has to live in a later migration file, never
-- appended here.
--
-- compensation.read_self/_team/_org and compensation.manage/.approve/
-- .manage_structure replace employee.manage as compensation's authority —
-- see 20260829110000_compensation_pay_administration.sql for why:
-- Supervisor/Manager must not automatically see salary just because they
-- can read team directory/attendance data. payroll.export and
-- pay_calendar.read/.manage are new; payroll.read_self/.read_org/.import
-- already existed and are unchanged.

alter type public.app_permission add value if not exists 'compensation.read_self';
alter type public.app_permission add value if not exists 'compensation.read_team';
alter type public.app_permission add value if not exists 'compensation.read_org';
alter type public.app_permission add value if not exists 'compensation.manage';
alter type public.app_permission add value if not exists 'compensation.approve';
alter type public.app_permission add value if not exists 'compensation.manage_structure';
alter type public.app_permission add value if not exists 'pay_calendar.read';
alter type public.app_permission add value if not exists 'pay_calendar.manage';
alter type public.app_permission add value if not exists 'payroll.export';
