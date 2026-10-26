"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { RewardDialog } from "./RewardDialog";
export function ReverseAwardButton({
  awardId,
  amount,
}: {
  awardId: string;
  amount: number;
}) {
  const router = useRouter(),
    submitting = useRef(false);
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [reason, setReason] = useState(""),
    [error, setError] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const { error } = await createClient().rpc("reverse_reward_award", {
        p_award_id: awardId,
        p_reason: reason,
      });
      if (error) throw error;
      setOpen(false);
      router.refresh();
    } catch (error) {
      setError(
        (error as { message?: string }).message ??
          "Correction failed. Retry safely or refresh to check its outcome.",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className="btn-secondary"
        onClick={() => setOpen(true)}
      >
        Correct award
      </button>
      <RewardDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Reverse incorrect points award"
        busy={busy}
      >
        <form onSubmit={submit} className="space-y-3">
          <p>
            This appends −{amount.toLocaleString()} points once and preserves
            the original award. A spent award can leave a negative Rewards
            balance. Review pending requests with the employee; salary and
            fulfilled rewards are unchanged.
          </p>
          <label className="label">
            Employee-visible reason
            <textarea
              required
              minLength={3}
              maxLength={1000}
              className="input"
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
            {busy ? "Saving…" : "Confirm full reversal"}
          </button>
        </form>
      </RewardDialog>
    </>
  );
}
