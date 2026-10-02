"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Effective-dated schedule change for one employee
// (assign_employee_schedule(): the previous schedule ends the day before).
export function EmployeeScheduleForm({ employeeId, schedules, currentScheduleId, defaultDate }: { employeeId: string; schedules: { id: string; name: string }[]; currentScheduleId: string | null; defaultDate: string }) {
  const router = useRouter();
  const [scheduleId, setScheduleId] = useState(currentScheduleId ?? schedules[0]?.id ?? "");
  const [startDate, setStartDate] = useState(defaultDate);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);
    const { error: rpcError } = await createClient().rpc("assign_employee_schedule", { p_employee_id: employeeId, p_schedule_id: scheduleId, p_start_date: startDate || null });
    setLoading(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setMessage("Schedule saved.");
    router.refresh();
  }

  if (schedules.length === 0) return <p className="field-help">No active schedules yet — create one in Time &amp; attendance setup.</p>;
  return (
    <form onSubmit={save} className="attendance-toolbar">
      <div><label className="label" htmlFor={`schedule-${employeeId}`}>Schedule</label><select id={`schedule-${employeeId}`} className="input" value={scheduleId} onChange={(e) => setScheduleId(e.target.value)}>{schedules.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
      <div><label className="label" htmlFor={`schedule-date-${employeeId}`}>Effective from</label><input id={`schedule-date-${employeeId}`} className="input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></div>
      <button type="submit" className="btn-secondary" disabled={loading || !scheduleId}>{loading ? "Saving…" : "Save schedule"}</button>
      {error && <p role="alert" className="alert-error w-full">{error}</p>}
      {message && !error && <p role="status" className="w-full text-xs text-emerald-700">{message}</p>}
    </form>
  );
}
