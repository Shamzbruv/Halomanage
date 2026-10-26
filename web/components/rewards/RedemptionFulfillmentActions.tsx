"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { RewardDialog } from "./RewardDialog";
export function RedemptionFulfillmentActions({
  redemptionId,
  self = false,
}: {
  redemptionId: string;
  self?: boolean;
}) {
  const router = useRouter(),
    submitting = useRef(false);
  const [open, setOpen] = useState(false),
    [action, setAction] = useState("fulfilled"),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const name = self
        ? "cancel_my_reward"
        : action === "fulfilled"
          ? "fulfill_redemption"
          : action === "failed"
            ? "fail_redemption"
            : "cancel_redemption";
      const args =
        self || action === "cancelled"
          ? { p_redemption_id: redemptionId, p_reason: note }
          : action === "failed"
            ? { p_redemption_id: redemptionId, p_error_message: note }
            : { p_redemption_id: redemptionId, p_note: note };
      const { error } = await createClient().rpc(name, args);
      if (error) throw error;
      setOpen(false);
      setNote("");
      router.refresh();
    } catch (error) {
      setError(
        (error as { message?: string })?.message ??
          "Could not update this request. Retry safely or refresh its history.",
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
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {self ? "Cancel request" : "Resolve request"}
      </button>
      <RewardDialog
        open={open}
        onClose={() => setOpen(false)}
        title={self ? "Cancel pending reward" : "Resolve reward request"}
        busy={busy}
      >
        <form onSubmit={submit} className="space-y-3">
          {!self && (
            <label className="label">
              Outcome
              <select
                className="input"
                value={action}
                onChange={(e) => setAction(e.target.value)}
                disabled={busy}
              >
                <option value="fulfilled">
                  Fulfilled — reward delivered or ready to collect
                </option>
                <option value="cancelled">Cancelled — refund points</option>
                <option value="failed">
                  Unable to fulfill — refund points
                </option>
              </select>
            </label>
          )}
          <p>
            {self || action !== "fulfilled"
              ? "This returns the original points and restores reserved stock once."
              : "Confirm only after the reward is delivered or collection is arranged. This closes the request."}
          </p>
          <label className="label">
            {self
              ? "Reason for cancelling"
              : "Explanation or collection instructions (visible to the employee)"}
            <textarea
              required
              minLength={3}
              maxLength={1000}
              rows={4}
              className="input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={busy}
            />
          </label>
          <p className="text-sm">
            Do not include voucher codes, passwords or confidential HR notes.
          </p>
          {error && (
            <p role="alert" className="alert-error">
              {error}
            </p>
          )}
          <button className="btn-primary" disabled={busy}>
            {busy
              ? "Saving…"
              : self
                ? "Cancel and refund points"
                : "Confirm outcome"}
          </button>
        </form>
      </RewardDialog>
    </>
  );
}
