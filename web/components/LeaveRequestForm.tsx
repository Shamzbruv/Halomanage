"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { LeaveType } from "@/lib/supabase/types";

export function LeaveRequestForm({ leaveTypes }: { leaveTypes: LeaveType[] }) {
  const supabase = createClient();
  const router = useRouter();
  const [leaveTypeId, setLeaveTypeId] = useState(leaveTypes[0]?.id ?? "");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [halfDay, setHalfDay] = useState(false);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedType = leaveTypes.find((t) => t.id === leaveTypeId);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error } = await supabase.rpc("submit_leave", {
      p_leave_type_id: leaveTypeId,
      p_start_date: startDate,
      p_end_date: halfDay ? startDate : endDate,
      p_half_day: halfDay,
      p_reason: reason || null,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    setStartDate("");
    setEndDate("");
    setReason("");
    setHalfDay(false);
    setLoading(false);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="card space-y-4">
      <h2 className="text-sm font-semibold text-slate-900">Request leave</h2>

      <div>
        <label className="label" htmlFor="leave-type">Leave type</label>
        <select
          id="leave-type"
          className="input"
          value={leaveTypeId}
          onChange={(e) => setLeaveTypeId(e.target.value)}
        >
          {leaveTypes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} {t.is_paid ? "" : "(unpaid)"}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="start-date">Start date</label>
          <input
            id="start-date"
            type="date"
            required
            className="input"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="end-date">End date</label>
          <input
            id="end-date"
            type="date"
            required
            disabled={halfDay}
            className="input"
            value={halfDay ? startDate : endDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </div>
      </div>

      {selectedType?.allow_half_day && (
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={halfDay}
            onChange={(e) => setHalfDay(e.target.checked)}
          />
          Half day (single date only)
        </label>
      )}

      <div>
        <label className="label" htmlFor="reason">Reason (optional)</label>
        <textarea
          id="reason"
          className="input"
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>

      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <button type="submit" disabled={loading} className="btn-primary w-full">
        {loading ? "Submitting…" : "Submit request"}
      </button>
    </form>
  );
}
