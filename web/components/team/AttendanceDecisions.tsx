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

// A lunch/break overrun: excuse it, deduct the minutes from pay, or have the
// employee make the time up by a date (decide_attendance_violation()).
export function ViolationDecision({ violationId, defaultDueDate, minDueDate, maxDueDate }: { violationId: string; defaultDueDate: string; minDueDate: string; maxDueDate: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [dueDate, setDueDate] = useState(defaultDueDate);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(resolution: "excused" | "deduct_pay" | "make_up") {
    setLoading(resolution);
    setError(null);
    const { error: rpcError } = await createClient().rpc("decide_attendance_violation", {
      p_violation_id: violationId, p_resolution: resolution, p_note: note.trim() || null, p_makeup_due_date: resolution === "make_up" ? dueDate : null,
    });
    setLoading(null);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setNote("");
    router.refresh();
  }

  return (
    <div className="violation-decision">
      <input className="input" aria-label="Note to the employee" placeholder="Note to the employee (optional)" value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} />
      <div className="decision-inline">
        <button type="button" className="btn-secondary px-3 py-1 text-xs" disabled={loading !== null} onClick={() => decide("excused")}>{loading === "excused" ? "Saving…" : "Excuse"}</button>
        <button type="button" className="btn-secondary px-3 py-1 text-xs" disabled={loading !== null} onClick={() => decide("deduct_pay")}>{loading === "deduct_pay" ? "Saving…" : "Deduct from pay"}</button>
      </div>
      <div className="decision-inline">
        <label className="text-xs text-stone-500" htmlFor={`makeup-${violationId}`}>Make up by</label>
        <input id={`makeup-${violationId}`} className="input" type="date" value={dueDate} min={minDueDate} max={maxDueDate} onChange={(event) => setDueDate(event.target.value)} />
        <button type="button" className="btn-primary px-3 py-1 text-xs" disabled={loading !== null || !dueDate} onClick={() => decide("make_up")}>{loading === "make_up" ? "Saving…" : "Make up time"}</button>
      </div>
      {error && <p className="w-full text-right text-xs text-ruby-600" role="alert">{error}</p>}
    </div>
  );
}
