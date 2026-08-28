"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Icon } from "@/components/Icon";

export function NewPayGradeForm({ organizationId }: { organizationId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [minimum, setMinimum] = useState("");
  const [midpoint, setMidpoint] = useState("");
  const [maximum, setMaximum] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const { error: insertError } = await supabase.from("pay_grades").insert({
      organization_id: organizationId,
      name,
      code: code || null,
      currency,
      minimum_amount: minimum ? Number(minimum) : null,
      midpoint_amount: midpoint ? Number(midpoint) : null,
      maximum_amount: maximum ? Number(maximum) : null,
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
    return <button type="button" className="btn-primary" onClick={() => setOpen(true)}><Icon name="reports" size={16} /> New pay grade</button>;
  }

  return (
    <div className="modal-layer" role="presentation">
      <button type="button" className="modal-backdrop" aria-label="Close dialog" onClick={() => setOpen(false)} />
      <form onSubmit={handleSubmit} className="modal-card space-y-3" role="dialog" aria-modal="true" aria-labelledby="new-pay-grade-title">
        <div className="modal-head"><div><span className="eyebrow">Compensation structure</span><h3 id="new-pay-grade-title">New pay grade</h3></div><button type="button" className="icon-button" aria-label="Close dialog" onClick={() => setOpen(false)}><Icon name="x" size={18} /></button></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">Name</label><input required className="input" placeholder="Grade 5" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div><label className="label">Code</label><input className="input" placeholder="G5" value={code} onChange={(e) => setCode(e.target.value)} /></div>
          <div><label className="label">Currency</label><input required className="input" maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} /></div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div><label className="label">Minimum</label><input type="number" min="0" className="input" value={minimum} onChange={(e) => setMinimum(e.target.value)} /></div>
          <div><label className="label">Midpoint</label><input type="number" min="0" className="input" value={midpoint} onChange={(e) => setMidpoint(e.target.value)} /></div>
          <div><label className="label">Maximum</label><input type="number" min="0" className="input" value={maximum} onChange={(e) => setMaximum(e.target.value)} /></div>
        </div>
        {error && <p className="alert-error">{error}</p>}
        <div className="flex gap-2"><button type="submit" disabled={loading} className="btn-primary">{loading ? "Saving…" : "Create"}</button><button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button></div>
      </form>
    </div>
  );
}
