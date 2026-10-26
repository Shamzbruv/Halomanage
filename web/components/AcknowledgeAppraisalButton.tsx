"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
export function AcknowledgeAppraisalButton({
  instanceId,
}: {
  instanceId: string;
}) {
  const router = useRouter(),
    submitting = useRef(false);
  const [disposition, setDisposition] = useState("received"),
    [note, setNote] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const { error } = await createClient().rpc("record_performance_receipt", {
        p_instance_id: instanceId,
        p_disposition: disposition,
        p_note: note || null,
      });
      if (error) throw error;
      router.refresh();
    } catch (error) {
      setError(
        (error as { message?: string }).message ?? "Unable to record receipt.",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <p>
        Acknowledgement records that you received and read this feedback. You
        can disagree and still acknowledge receipt. It does not waive your right
        to request a correction or HR review.
      </p>
      <label className="label">
        Your response
        <select
          className="input"
          value={disposition}
          disabled={busy}
          onChange={(e) => setDisposition(e.target.value)}
        >
          <option value="received">Received and read</option>
          <option value="received_with_comments">Received with comments</option>
          <option value="disagree">
            Received; I disagree / request HR review
          </option>
        </select>
      </label>
      <label className="label">
        Comments
        <textarea
          className="input"
          rows={4}
          maxLength={4000}
          minLength={disposition === "received" ? 0 : 3}
          required={disposition !== "received"}
          disabled={busy}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <label className="flex gap-2">
        <input
          type="checkbox"
          required
          checked={confirmed}
          disabled={busy}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        I have read the released feedback.
      </label>
      {error && (
        <p role="alert" className="alert-error">
          {error}
        </p>
      )}
      <button className="btn-primary" disabled={busy || !confirmed}>
        {busy ? "Saving…" : "Record receipt and response"}
      </button>
    </form>
  );
}
