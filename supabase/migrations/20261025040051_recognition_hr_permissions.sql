-- Separate reading, policy administration and private-content moderation.
alter type public.app_permission add value if not exists 'recognition.read';
alter type public.app_permission add value if not exists 'recognition.manage';
alter type public.app_permission add value if not exists 'recognition.moderate';
