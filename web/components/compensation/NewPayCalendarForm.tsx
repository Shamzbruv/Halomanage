"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { resolveFunctionErrorMessage } from "@/lib/supabase/functions";
import { Icon } from "@/components/Icon";

const FREQUENCIES = ["weekly", "biweekly", "semimonthly", "monthly", "quarterly", "annual", "custom"];

type PayGroupOption = { id: string; name: string; pay_frequency: string };

function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

// A calendar with zero periods is a dead end that looks broken, not empty
// — nothing on the Pay calendars page ever had anything to show until
// someone separately found and clicked the easy-to-miss "Generate
// periods" link. Folded that second step into this same form (still the
// same two RPCs, create_pay_calendar then generate_pay_periods, just one
// submit instead of two) so a new calendar always starts with a real
// schedule instead of an empty shell.
export function NewPayCalendarForm({ organizationId, payGroups }: { organizationId: string; payGroups: PayGroupOption[] }) {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [payFrequency, setPayFrequency] = useState("monthly");
  const [payGroupId, setPayGroupId] = useState("");
  const [firstStart, setFirstStart] = useState(todayIso());
  const [count, setCount] = useState("12");
  const [payDateOffset, setPayDateOffset] = useState("5");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const { data: calendar, error: insertError } = await supabase.rpc("create_pay_calendar", {
      p_organization_id: organizationId,
      p_name: name,
      p_pay_frequency: payFrequency,
      p_pay_group_id: payGroupId || null,
    });
    if (insertError) {
      setError(await resolveFunctionErrorMessage(insertError, "Could not create this pay calendar."));
      setLoading(false);
      return;
    }

    const calendarId = Array.isArray(calendar) ? calendar[0]?.id : calendar?.id;
    const { error: periodsError } = await supabase.rpc("generate_pay_periods", {
      p_pay_calendar_id: calendarId,
      p_first_period_start: firstStart,
      p_number_of_periods: Number(count),
      p_pay_date_offset_days: Number(payDateOffset),
    });
    if (periodsError) {
      // The calendar itself was created successfully — only the schedule
      // failed. Leaving it in that partial state is exactly the confusing
      // dead end this form exists to prevent, so say so plainly rather
      // than a generic error.
      setError(`The calendar "${name}" was created, but its first periods could not be generated: ${await resolveFunctionErrorMessage(periodsError, "unknown error")}. Use "Generate periods" on the calendar below to try again.`);
      setLoading(false);
      setOpen(false);
      router.refresh();
      return;
    }

    setOpen(false);
    setLoading(false);
    router.refresh();
  }

  function handlePayGroupChange(nextPayGroupId: string) {
    setPayGroupId(nextPayGroupId);
    const selectedGroup = payGroups.find((group) => group.id === nextPayGroupId);
    if (selectedGroup) setPayFrequency(selectedGroup.pay_frequency);
  }

  if (!open) {
    return <button type="button" className="btn-primary" onClick={() => setOpen(true)}><Icon name="calendar" size={16} /> New pay calendar</button>;
  }

  return (
    <div className="modal-layer" role="presentation">
      <button type="button" className="modal-backdrop" aria-label="Close dialog" onClick={() => setOpen(false)} />
      <form onSubmit={handleSubmit} className="modal-card space-y-3" role="dialog" aria-modal="true" aria-labelledby="new-pay-calendar-title">
        <div className="modal-head"><div><span className="eyebrow">Scheduling</span><h3 id="new-pay-calendar-title">New pay calendar</h3><p>Scheduling only — generating periods is date arithmetic, never a payroll calculation.</p></div><button type="button" className="icon-button" aria-label="Close dialog" onClick={() => setOpen(false)}><Icon name="x" size={18} /></button></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">Name</label><input required className="input" placeholder="Monthly Calendar" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div>
            <label className="label">Frequency</label>
            <select className="input" value={payFrequency} disabled={Boolean(payGroupId)} onChange={(e) => setPayFrequency(e.target.value)}>
              {FREQUENCIES.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div className="col-span-2">
            <label className="label">Pay group (optional)</label>
            <select className="input" value={payGroupId} onChange={(e) => handlePayGroupChange(e.target.value)}>
              <option value="">Not tied to a specific group</option>
              {payGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
        </div>

        <div className="rounded-xl border border-stone-200 p-3">
          <p className="label mb-2">First periods</p>
          <div className="grid grid-cols-3 gap-3">
            <div><label className="label" htmlFor="new-cal-first-start">Starts</label><input id="new-cal-first-start" type="date" className="input" value={firstStart} onChange={(e) => setFirstStart(e.target.value)} /></div>
            <div><label className="label" htmlFor="new-cal-count">How many</label><input id="new-cal-count" type="number" min="1" max="366" className="input" value={count} onChange={(e) => setCount(e.target.value)} /></div>
            <div><label className="label" htmlFor="new-cal-offset">Pay date, days after</label><input id="new-cal-offset" type="number" min="0" max="30" className="input" value={payDateOffset} onChange={(e) => setPayDateOffset(e.target.value)} /></div>
          </div>
          <p className="field-help mt-1">Generated immediately, so this calendar has a real schedule from the start. Any period can be hand-edited afterward.</p>
        </div>

        {error && <p className="alert-error">{error}</p>}
        <div className="flex gap-2"><button type="submit" disabled={loading} className="btn-primary">{loading ? "Creating…" : "Create calendar & periods"}</button><button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button></div>
      </form>
    </div>
  );
}
