"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Icon } from "@/components/Icon";

const FREQUENCIES = ["weekly", "biweekly", "semimonthly", "monthly", "quarterly", "annual", "custom"];

export function NewPayGroupForm({ organizationId }: { organizationId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [payFrequency, setPayFrequency] = useState("monthly");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const { error: insertError } = await supabase.from("pay_groups").insert({
      organization_id: organizationId,
      name,
      code: code.toUpperCase(),
      currency,
      pay_frequency: payFrequency,
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
    return <button type="button" className="btn-primary" onClick={() => setOpen(true)}><Icon name="payroll" size={16} /> New pay group</button>;
  }

  return (
    <div className="modal-layer" role="presentation">
      <button type="button" className="modal-backdrop" aria-label="Close dialog" onClick={() => setOpen(false)} />
      <form onSubmit={handleSubmit} className="modal-card space-y-3" role="dialog" aria-modal="true" aria-labelledby="new-pay-group-title">
        <div className="modal-head"><div><span className="eyebrow">Compensation structure</span><h3 id="new-pay-group-title">New pay group</h3></div><button type="button" className="icon-button" aria-label="Close dialog" onClick={() => setOpen(false)}><Icon name="x" size={18} /></button></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">Name</label><input required className="input" placeholder="Salaried Monthly" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div><label className="label">Code</label><input required className="input" placeholder="SAL-M" value={code} onChange={(e) => setCode(e.target.value)} /></div>
          <div><label className="label">Currency</label><input required className="input" maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} /></div>
          <div>
            <label className="label">Pay frequency</label>
            <select className="input" value={payFrequency} onChange={(e) => setPayFrequency(e.target.value)}>
              {FREQUENCIES.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
        </div>
        {error && <p className="alert-error">{error}</p>}
        <div className="flex gap-2"><button type="submit" disabled={loading} className="btn-primary">{loading ? "Saving…" : "Create"}</button><button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button></div>
      </form>
    </div>
  );
}
