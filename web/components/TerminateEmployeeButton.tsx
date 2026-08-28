"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/client";
import { resolveFunctionErrorMessage } from "@/lib/supabase/functions";

function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

// Ref: supabase/migrations/20260828110000_lifecycle_rbac_hardening.sql —
// terminate_employee() does the whole exit in one transaction (status,
// closing the open assignment, expiring roles, cancelling in-progress
// onboarding/appraisals) and the employees_auto_offboarding trigger picks
// up from there to launch the org's offboarding checklist. This component
// is only the confirmation UI in front of it; every real invariant (can't
// terminate yourself, can't remove the last active admin, date can't
// precede the hire date) is enforced server-side regardless of what this
// form sends.
export function TerminateEmployeeButton({ employeeId, employeeName, isSelf }: { employeeId: string; employeeName: string; isSelf: boolean }) {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [terminationDate, setTerminationDate] = useState(todayIso());
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isSelf) return null;

  async function handleConfirm() {
    setLoading(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("terminate_employee", {
      p_employee_id: employeeId,
      p_termination_date: terminationDate,
      p_reason: reason.trim() || null,
    });

    if (rpcError) {
      setError(await resolveFunctionErrorMessage(rpcError, "Could not terminate this employee."));
      setLoading(false);
      return;
    }

    setLoading(false);
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <button type="button" className="btn-danger px-3 py-1 text-xs" onClick={() => setOpen(true)}>
        <Icon name="x" size={14} /> Terminate
      </button>

      {open && (
        <div className="modal-layer" role="dialog" aria-modal="true" aria-labelledby="terminate-title">
          <button type="button" className="modal-backdrop" aria-label="Cancel" onClick={() => !loading && setOpen(false)} />
          <div className="modal-card">
            <h2 id="terminate-title" className="text-base font-semibold text-stone-900">Terminate {employeeName}?</h2>
            <p className="mt-1 text-xs leading-5 text-stone-500">
              This ends their access, closes their current assignment, expires any active roles, cancels in-progress
              onboarding and performance reviews, and starts your organization&apos;s offboarding checklist. This
              cannot be undone from here.
            </p>
            <div className="mt-4 space-y-3">
              <div>
                <label className="label" htmlFor="termination-date">Final work date</label>
                <input
                  id="termination-date"
                  type="date"
                  required
                  max={todayIso()}
                  className="input"
                  value={terminationDate}
                  onChange={(event) => setTerminationDate(event.target.value)}
                />
              </div>
              <div>
                <label className="label" htmlFor="termination-reason">Reason <span className="font-normal text-stone-500">(optional, internal only)</span></label>
                <textarea
                  id="termination-reason"
                  className="input"
                  rows={2}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </div>
            </div>
            {error && <p className="alert-error mt-3" role="alert">{error}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="btn-secondary" disabled={loading} onClick={() => setOpen(false)}>Cancel</button>
              <button type="button" className="btn-danger" disabled={loading} onClick={() => void handleConfirm()}>
                {loading ? "Terminating…" : "Confirm termination"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
