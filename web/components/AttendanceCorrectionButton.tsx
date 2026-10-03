"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/client";
import { utcToZonedInput, zonedInputToUtc } from "@/lib/timezone";

// Requests a correction (request_attendance_adjustment()). Times are
// entered and shown in the organization's timezone — not the device's — so
// a request means the same thing from anywhere. The database validates the
// result (clock-out after clock-in, not in the future, within the policy's
// correction window, one pending request per time) and routes it to the
// employee's supervisor/manager. A record with no clock-out (forgotten)
// can only have its clock-out supplied.
export function AttendanceCorrectionButton({
  sessionId,
  clockInAt,
  clockOutAt,
  timezone,
  label = "Request correction",
}: {
  sessionId: string;
  clockInAt: string;
  clockOutAt: string | null;
  timezone: string | undefined;
  label?: string;
}) {
  const router = useRouter();
  const missingOut = !clockOutAt;
  const [open, setOpen] = useState(false);
  const [field, setField] = useState<"clock_in_at" | "clock_out_at">(missingOut ? "clock_out_at" : "clock_in_at");
  const [requestedValue, setRequestedValue] = useState(missingOut ? "" : utcToZonedInput(clockInAt, timezone));
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function changeField(value: "clock_in_at" | "clock_out_at") {
    setField(value);
    setRequestedValue(utcToZonedInput(value === "clock_in_at" ? clockInAt : clockOutAt, timezone));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!requestedValue) {
      setError("Choose the correct time.");
      return;
    }
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { error: requestError } = await supabase.rpc("request_attendance_adjustment", {
      p_session_id: sessionId,
      p_field: field,
      p_requested_value: zonedInputToUtc(requestedValue, timezone),
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
      <button className="table-action" type="button" onClick={() => setOpen(true)}>{label}</button>
      {open && (
        <div className="modal-layer" role="dialog" aria-modal="true" aria-labelledby={`correction-title-${sessionId}`}>
          <button className="modal-backdrop" type="button" aria-label="Close correction form" onClick={() => setOpen(false)} />
          <form className="modal-card correction-form" onSubmit={submit}>
            <div className="modal-head"><div><span className="eyebrow">Attendance correction</span><h3 id={`correction-title-${sessionId}`}>{missingOut ? "When did you actually finish?" : "Tell your manager what needs changing"}</h3><p>The original record is kept. Your manager reviews the request and you&apos;re notified of the decision.</p></div><button className="icon-button" type="button" aria-label="Close correction form" onClick={() => setOpen(false)}><Icon name="x" /></button></div>
            {!missingOut && (
              <div><label className="label" htmlFor={`correction-field-${sessionId}`}>Time to correct</label><select id={`correction-field-${sessionId}`} className="input" value={field} onChange={(event) => changeField(event.target.value as "clock_in_at" | "clock_out_at")}><option value="clock_in_at">Clock in</option><option value="clock_out_at">Clock out</option></select></div>
            )}
            <div><label className="label" htmlFor={`correction-time-${sessionId}`}>Correct {field === "clock_in_at" ? "clock-in" : "clock-out"} time</label><input id={`correction-time-${sessionId}`} className="input" type="datetime-local" required value={requestedValue} onChange={(event) => setRequestedValue(event.target.value)} /><p className="field-help">In your organization&apos;s time{timezone ? ` (${timezone})` : ""}.</p></div>
            <div><label className="label" htmlFor={`correction-reason-${sessionId}`}>Reason</label><textarea id={`correction-reason-${sessionId}`} className="input" required minLength={5} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Explain what happened so the reviewer has enough context." /></div>
            {error && <p className="alert-error" role="alert">{error}</p>}
            <div className="modal-actions"><button className="btn-secondary" type="button" onClick={() => setOpen(false)}>Cancel</button><button className="btn-primary" disabled={loading} type="submit">{loading ? "Submitting…" : "Submit request"}</button></div>
          </form>
        </div>
      )}
    </>
  );
}

export function WithdrawCorrectionButton({ adjustmentId }: { adjustmentId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex flex-col items-end gap-1">
      <button type="button" className="table-action" disabled={loading} onClick={async () => {
        setLoading(true);
        setError(null);
        const { error: rpcError } = await createClient().rpc("cancel_attendance_adjustment", { p_adjustment_id: adjustmentId });
        if (rpcError) setError(rpcError.message);
        setLoading(false);
        router.refresh();
      }}>{loading ? "Withdrawing…" : "Withdraw"}</button>
      {error && <span className="text-xs text-ruby-600">{error}</span>}
    </span>
  );
}
