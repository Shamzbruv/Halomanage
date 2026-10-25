-- Match private source-file access to required MFA on financial record reads.
create policy "payroll files require MFA" on storage.objects as restrictive for all to authenticated
using (case when bucket_id='payroll-imports' then not private.user_requires_mfa((storage.foldername(name))[1]::uuid,auth.uid()) or coalesce(auth.jwt()->>'aal','aal1')='aal2' else true end)
with check (case when bucket_id='payroll-imports' then not private.user_requires_mfa((storage.foldername(name))[1]::uuid,auth.uid()) or coalesce(auth.jwt()->>'aal','aal1')='aal2' else true end);
