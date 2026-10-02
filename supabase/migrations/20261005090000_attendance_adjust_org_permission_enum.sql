-- Halomanage — attendance.adjust_org permission (enum value only)
--
-- Split out from 20261005100000_time_and_attendance.sql: a new enum value
-- can't be used in the transaction that adds it.
--
-- Deciding attendance corrections organization-wide used to be implied by
-- attendance.read_org — a read permission silently granting a write. Now
-- attendance.read_org only reads; attendance.adjust_org changes records
-- for anyone, attendance.adjust_team for people in your management scope.

alter type public.app_permission add value if not exists 'attendance.adjust_org';
