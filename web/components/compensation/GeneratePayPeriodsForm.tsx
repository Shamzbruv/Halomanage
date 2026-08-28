"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { resolveFunctionErrorMessage } from "@/lib/supabase/functions";

function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

// Ref: generate_pay_periods() — pure date arithmetic scheduling, never a
// payroll calculation. HR can still hand-edit any generated period
// afterward (e.g. to shift a pay date around a holiday).
export function GeneratePayPeriodsForm({ calendarId }: { calendarId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [firstStart, setFirstStart] = useState(todayIso());
  const [count, setCount] = useState("12");
  const [payDateOffset, setPayDateOffset] = useState("5");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGenerate() {
    setLoading(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("generate_pay_periods", {
      p_pay_calendar_id: calendarId,
      p_first_period_start: firstStart,
      p_number_of_periods: Number(count),
      p_pay_date_offset_days: Number(payDateOffset),
    });
    if (rpcError) {
      setError(await resolveFunctionErrorMessage(rpcError, "Could not generate pay periods."));
      setLoading(false);
      return;
    }
    setLoading(false);
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => setOpen(true)}>Generate periods</button>;
  }

  return (
    <div className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border border-stone-200 p-3">
      <div><label className="label">First period starts</label><input type="date" className="input" value={firstStart} onChange={(e) => setFirstStart(e.target.value)} /></div>
      <div><label className="label">How many periods</label><input type="number" min="1" max="366" className="input" style={{ width: 90 }} value={count} onChange={(e) => setCount(e.target.value)} /></div>
      <div><label className="label">Pay date, days after period end</label><input type="number" min="0" max="30" className="input" style={{ width: 90 }} value={payDateOffset} onChange={(e) => setPayDateOffset(e.target.value)} /></div>
      <button type="button" disabled={loading} className="btn-primary px-3 py-1.5 text-xs" onClick={() => void handleGenerate()}>{loading ? "Generating…" : "Generate"}</button>
      <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={() => setOpen(false)}>Cancel</button>
      {error && <p className="alert-error w-full">{error}</p>}
    </div>
  );
}
