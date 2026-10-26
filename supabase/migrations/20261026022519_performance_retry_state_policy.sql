-- Explicit defense in depth for private review retry bodies. No client table grants exist;
-- guarded SECURITY DEFINER review writers access this table as its owner.
create policy "deny client access to performance retry bodies"
  on performance_internal.review_retry_state for all to authenticated
  using (false) with check (false);
