-- Halomanage — default new organizations to Jamaica, not UTC
--
-- The real customer base today is Jamaica-based; UTC as a silent default
-- was never a deliberate choice anyone made; it just fell out of picking
-- the one truly timezone-agnostic value. The org-creation client forms
-- (CreateOrganizationForm) already auto-detect the signing-up user's own
-- browser timezone via Intl and only fall back to a literal default in
-- the rare case that fails — this migration is the database-level
-- backstop for any path that ever inserts an organization without
-- explicitly setting one (this table's own column default), independent
-- of the client-side fallback literals fixed alongside this migration.

alter table public.organizations alter column timezone set default 'America/Jamaica';
