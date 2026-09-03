"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { resolveFunctionErrorMessage } from "@/lib/supabase/functions";
import { Icon } from "@/components/Icon";

// Ref: delete_employee_record() in
// 20260903100000_employee_invite_status_and_cleanup.sql. Only ever shown
// for a pre-hire with no linked account — this schema deliberately has no
// general employees DELETE policy (history/audit/payroll-import
// references must stay valid; see authorization.sql's comment), so
// anyone who has ever been active or has an account is handled by
// Terminate instead, never this. The RPC re-checks both conditions
// server-side regardless of what this button's own gating shows.
export function DeleteEmployeeButton({ employeeId, employeeName }: { employeeId: string; employeeName: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setLoading(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("delete_employee_record", { p_employee_id: employeeId });
    if (rpcError) {
      setError(await resolveFunctionErrorMessage(rpcError, "Could not delete this record."));
      setLoading(false);
      return;
    }
    setLoading(false);
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <button type="button" className="icon-button" aria-label={`Delete ${employeeName}`} onClick={() => setOpen(true)}>
        <Icon name="trash" size={15} />
      </button>
      {open && (
        <div className="modal-layer" role="dialog" aria-modal="true" aria-labelledby="delete-employee-title">
          <button type="button" className="modal-backdrop" aria-label="Cancel" onClick={() => !loading && setOpen(false)} />
          <div className="modal-card">
            <h2 id="delete-employee-title" className="text-base font-semibold text-stone-900">Delete {employeeName}?</h2>
            <p className="mt-1 text-xs leading-5 text-stone-500">
              This permanently removes the record — only possible for a pre-hire with no linked account and no employment
              history. This cannot be undone.
            </p>
            {error && <p className="alert-error mt-3" role="alert">{error}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="btn-secondary" disabled={loading} onClick={() => setOpen(false)}>Cancel</button>
              <button type="button" className="btn-danger" disabled={loading} onClick={() => void handleConfirm()}>
                {loading ? "Deleting…" : "Delete permanently"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
