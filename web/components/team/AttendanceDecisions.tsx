"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Approve or decline an attendance correction (decide_attendance_adjustment)
// or a session's overtime (decide_overtime). The database checks the
// decider's scope, refuses self-approval, revalidates the corrected times
// and notifies the employee; a decline must say why.
function DecisionControls({ onDecide, declineLabel = "Decline" }: { onDecide: (approve: boolean, note: string) => Promise<string | null>; declineLabel?: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState<"approve" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(approve: boolean) {
    if (!approve && note.trim().length < 3) {
      setError("Add a short note explaining the decision.");
      return;
    }
    setLoading(approve ? "approve" : "decline");
    setError(null);
    const message = await onDecide(approve, note.trim());
    setLoading(null);
    if (message) {
      setError(message);
      return;
    }
    setNote("");
    router.refresh();
  }

  return (
    <div className="decision-inline">
      <input className="input" aria-label="Decision note" placeholder="Note (required to decline)" value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} />
      <button type="button" className="btn-primary px-3 py-1 text-xs" disabled={loading !== null} onClick={() => decide(true)}>{loading === "approve" ? "Approving…" : "Approve"}</button>
      <button type="button" className="btn-secondary px-3 py-1 text-xs" disabled={loading !== null} onClick={() => decide(false)}>{loading === "decline" ? "Saving…" : declineLabel}</button>
      {error && <p className="w-full text-right text-xs text-ruby-600" role="alert">{error}</p>}
    </div>
  );
}

export function CorrectionDecision({ adjustmentId }: { adjustmentId: string }) {
  return (
    <DecisionControls onDecide={async (approve, note) => {
      const { error } = await createClient().rpc("decide_attendance_adjustment", { p_adjustment_id: adjustmentId, p_approve: approve, p_note: note || null });
      return error?.message ?? null;
    }} />
  );
}

export function OvertimeDecision({ sessionId }: { sessionId: string }) {
  return (
    <DecisionControls declineLabel="Don't approve" onDecide={async (approve, note) => {
      const { error } = await createClient().rpc("decide_overtime", { p_session_id: sessionId, p_approve: approve, p_note: note || null });
      return error?.message ?? null;
    }} />
  );
}
