"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/client";

function localInputValue(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function AttendanceCorrectionButton({ sessionId, clockInAt, clockOutAt }: { sessionId: string; clockInAt: string; clockOutAt: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [field, setField] = useState<"clock_in_at" | "clock_out_at">("clock_in_at");
  const [requestedValue, setRequestedValue] = useState(localInputValue(clockInAt));
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function changeField(value: "clock_in_at" | "clock_out_at") {
    setField(value);
    setRequestedValue(localInputValue(value === "clock_in_at" ? clockInAt : clockOutAt));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const parsed = new Date(requestedValue);
    if (!requestedValue || Number.isNaN(parsed.getTime())) {
      setError("Choose a valid corrected time.");
      setLoading(false);
      return;
    }
    const supabase = createClient();
    const { error: requestError } = await supabase.rpc("request_attendance_adjustment", {
      p_session_id: sessionId,
      p_field: field,
      p_requested_value: parsed.toISOString(),
      p_reason: reason.trim(),
    });
    if (requestError) {
      setError(requestError.message);
      setLoading(false);
      return;
    }
    setOpen(false);
    setReason("");
    setLoading(false);
    router.refresh();
  }

  return (
    <>
      <button className="table-action" type="button" onClick={() => setOpen(true)}>Request correction</button>
      {open && (
        <div className="modal-layer" role="dialog" aria-modal="true" aria-labelledby={`correction-title-${sessionId}`}>
          <button className="modal-backdrop" type="button" aria-label="Close correction form" onClick={() => setOpen(false)} />
          <form className="modal-card correction-form" onSubmit={submit}>
            <div className="modal-head"><div><span className="eyebrow">Attendance correction</span><h3 id={`correction-title-${sessionId}`}>Tell your manager what needs changing</h3><p>The original time is preserved. Your request creates a reviewable audit record.</p></div><button className="icon-button" type="button" aria-label="Close correction form" onClick={() => setOpen(false)}><Icon name="x" /></button></div>
            <div><label className="label" htmlFor={`correction-field-${sessionId}`}>Time to correct</label><select id={`correction-field-${sessionId}`} className="input" value={field} onChange={(event) => changeField(event.target.value as "clock_in_at" | "clock_out_at")}><option value="clock_in_at">Clock in</option><option value="clock_out_at" disabled={!clockOutAt}>Clock out</option></select></div>
            <div><label className="label" htmlFor={`correction-time-${sessionId}`}>Correct time</label><input id={`correction-time-${sessionId}`} className="input" type="datetime-local" required value={requestedValue} onChange={(event) => setRequestedValue(event.target.value)} /></div>
            <div><label className="label" htmlFor={`correction-reason-${sessionId}`}>Reason</label><textarea id={`correction-reason-${sessionId}`} className="input" required minLength={5} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Explain what happened so the reviewer has enough context." /></div>
            {error && <p className="alert-error" role="alert">{error}</p>}
            <div className="modal-actions"><button className="btn-secondary" type="button" onClick={() => setOpen(false)}>Cancel</button><button className="btn-primary" disabled={loading} type="submit">{loading ? "Submitting…" : "Submit request"}</button></div>
          </form>
        </div>
      )}
    </>
  );
}
