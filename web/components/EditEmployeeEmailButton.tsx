"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { resolveFunctionErrorMessage } from "@/lib/supabase/functions";
import { Icon } from "@/components/Icon";

// Ref: supabase/functions/invite-employee (correct_email mode). A pending
// (never-signed-in) invite's auth account is keyed to whatever address it
// was sent to — a plain employees.work_email update alone would leave
// that account orphaned under the old address, so Resend would find
// nothing to send to. Routed through the privileged Edge Function only
// for that case; once accepted, or if never invited at all, this is a
// plain Data API update (RLS already permits it for employee.manage).
export function EditEmployeeEmailButton({
  employeeId,
  employeeName,
  currentEmail,
  hasPendingInvite,
}: {
  employeeId: string;
  employeeName: string;
  currentEmail: string | null;
  hasPendingInvite: boolean;
}) {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(currentEmail ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    if (hasPendingInvite) {
      const { error: invokeError } = await supabase.functions.invoke("invite-employee", {
        body: { employee_id: employeeId, correct_email: email },
      });
      if (invokeError) {
        setError(await resolveFunctionErrorMessage(invokeError, "Could not update this email."));
        setLoading(false);
        return;
      }
    } else {
      const { error: updateError } = await supabase.from("employees").update({ work_email: email || null }).eq("id", employeeId);
      if (updateError) {
        setError(updateError.message);
        setLoading(false);
        return;
      }
    }

    setLoading(false);
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <button type="button" className="icon-button" aria-label={`Edit ${employeeName}'s email`} onClick={() => setOpen(true)}>
        <Icon name="edit" size={15} />
      </button>
      {open && (
        <div className="modal-layer" role="dialog" aria-modal="true" aria-labelledby="edit-email-title">
          <button type="button" className="modal-backdrop" aria-label="Cancel" onClick={() => !loading && setOpen(false)} />
          <form onSubmit={handleSubmit} className="modal-card space-y-3">
            <h2 id="edit-email-title" className="text-base font-semibold text-stone-900">Edit {employeeName}&apos;s work email</h2>
            {hasPendingInvite && (
              <p className="text-xs leading-5 text-stone-500">
                They haven&apos;t signed in yet. Saving a new address removes the invitation sent to the old one — you&apos;ll
                need to click Invite again afterward.
              </p>
            )}
            <div>
              <label className="label" htmlFor="edit-email-input">Work email</label>
              <input id="edit-email-input" type="email" required className="input" value={email} onChange={(event) => setEmail(event.target.value)} />
            </div>
            {error && <p className="alert-error" role="alert">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary" disabled={loading} onClick={() => setOpen(false)}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={loading}>{loading ? "Saving…" : "Save"}</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
