"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { RewardDialog as WorkflowDialog } from "./rewards/RewardDialog";
export function CancelOnboardingRunButton({ runId }: { runId: string }) {
  const router = useRouter(),
    submitting = useRef(false);
  const [open, setOpen] = useState(false),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  async function cancel(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const { error } = await createClient().rpc("cancel_onboarding_run", {
        p_run_id: runId,
        p_reason: reason,
      });
      if (error) throw error;
      setOpen(false);
      router.refresh();
    } catch (error) {
      setError((error as { message?: string }).message ?? "Unable to cancel.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <button className="btn-secondary" onClick={() => setOpen(true)}>
        Cancel plan
      </button>
      <WorkflowDialog
        open={open}
        onClose={() => setOpen(false)}
        busy={busy}
        title="Cancel onboarding plan"
      >
        <form onSubmit={cancel} className="space-y-3">
          <p>
            The record and evidence remain. Outstanding steps stop accepting
            updates. This does not terminate employment or revoke system access.
          </p>
          <label className="label">
            Reason
            <textarea
              className="input"
              required
              minLength={3}
              maxLength={1000}
              disabled={busy}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {error && (
            <p role="alert" className="alert-error">
              {error}
            </p>
          )}
          <button className="btn-primary" disabled={busy}>
            {busy ? "Cancelling…" : "Confirm cancellation"}
          </button>
        </form>
      </WorkflowDialog>
    </>
  );
}
