-- Halomanage — extensions
-- pgcrypto: gen_random_uuid() for primary keys.
-- citext: case-insensitive email/username comparisons.
create extension if not exists pgcrypto;
create extension if not exists citext;

-- Non-exposed schema for security-definer helper functions used by RLS
-- policies. Never add this schema to the Data API's exposed schema list.
create schema if not exists private;
comment on schema private is
  'Security-definer helper functions for RLS. Not exposed via the Data API.';
