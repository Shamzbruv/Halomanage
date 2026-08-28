"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Icon } from "@/components/Icon";

const FREQUENCIES = ["weekly", "biweekly", "semimonthly", "monthly", "quarterly", "annual", "custom"];

export function NewPayCalendarForm({ organizationId, payGroups }: { organizationId: string; payGroups: { id: string; name: string }[] }) {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [payFrequency, setPayFrequency] = useState("monthly");
  const [payGroupId, setPayGroupId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const { error: insertError } = await supabase.from("pay_calendars").insert({
      organization_id: organizationId,
      name,
      pay_frequency: payFrequency,
      pay_group_id: payGroupId || null,
    });
    if (insertError) {
      setError(insertError.message);
      setLoading(false);
      return;
    }
    setOpen(false);
    setLoading(false);
    router.refresh();
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
            <select className="input" value={payFrequency} onChange={(e) => setPayFrequency(e.target.value)}>
              {FREQUENCIES.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div className="col-span-2">
            <label className="label">Pay group (optional)</label>
            <select className="input" value={payGroupId} onChange={(e) => setPayGroupId(e.target.value)}>
              <option value="">Not tied to a specific group</option>
              {payGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
        </div>
        {error && <p className="alert-error">{error}</p>}
        <div className="flex gap-2"><button type="submit" disabled={loading} className="btn-primary">{loading ? "Saving…" : "Create"}</button><button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button></div>
      </form>
    </div>
  );
}
