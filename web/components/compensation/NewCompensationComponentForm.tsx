"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Icon } from "@/components/Icon";

const TYPES = ["base_salary", "allowance", "premium", "bonus", "commission", "other"];

export function NewCompensationComponentForm({ organizationId }: { organizationId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [componentType, setComponentType] = useState("allowance");
  const [recurrence, setRecurrence] = useState<"recurring" | "one_time">("recurring");
  const [valueType, setValueType] = useState<"fixed_amount" | "percentage">("fixed_amount");
  const [defaultAmount, setDefaultAmount] = useState("");
  const [defaultPercentage, setDefaultPercentage] = useState("");
  const [payableTo, setPayableTo] = useState<"employee" | "employer_cost">("employee");
  const [externalCode, setExternalCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const { error: insertError } = await supabase.from("compensation_components").insert({
      organization_id: organizationId,
      name,
      code: code.toUpperCase(),
      component_type: componentType,
      recurrence,
      value_type: valueType,
      default_amount: valueType === "fixed_amount" ? (defaultAmount ? Number(defaultAmount) : null) : null,
      default_percentage: valueType === "percentage" ? (defaultPercentage ? Number(defaultPercentage) : null) : null,
      payable_to: payableTo,
      external_payroll_code: externalCode || null,
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
    return <button type="button" className="btn-primary" onClick={() => setOpen(true)}><Icon name="spark" size={16} /> New component</button>;
  }

  return (
    <div className="modal-layer" role="presentation">
      <button type="button" className="modal-backdrop" aria-label="Close dialog" onClick={() => setOpen(false)} />
      <form onSubmit={handleSubmit} className="modal-card space-y-3" role="dialog" aria-modal="true" aria-labelledby="new-component-title">
        <div className="modal-head"><div><span className="eyebrow">Compensation structure</span><h3 id="new-component-title">New compensation component</h3><p>Never calculates tax or net pay — describes the component only.</p></div><button type="button" className="icon-button" aria-label="Close dialog" onClick={() => setOpen(false)}><Icon name="x" size={18} /></button></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">Name</label><input required className="input" placeholder="Car Allowance" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div><label className="label">Code</label><input required className="input" placeholder="CAR" value={code} onChange={(e) => setCode(e.target.value)} /></div>
          <div>
            <label className="label">Type</label>
            <select className="input" value={componentType} onChange={(e) => setComponentType(e.target.value)}>
              {TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Recurrence</label>
            <select className="input" value={recurrence} onChange={(e) => setRecurrence(e.target.value as "recurring" | "one_time")}>
              <option value="recurring">Recurring</option>
              <option value="one_time">One-time</option>
            </select>
          </div>
          <div>
            <label className="label">Value type</label>
            <select className="input" value={valueType} onChange={(e) => setValueType(e.target.value as "fixed_amount" | "percentage")}>
              <option value="fixed_amount">Fixed amount</option>
              <option value="percentage">Percentage</option>
            </select>
          </div>
          {valueType === "fixed_amount" ? (
            <div><label className="label">Default amount</label><input type="number" min="0" step="0.01" className="input" value={defaultAmount} onChange={(e) => setDefaultAmount(e.target.value)} /></div>
          ) : (
            <div><label className="label">Default percentage</label><input type="number" min="0" step="0.01" className="input" value={defaultPercentage} onChange={(e) => setDefaultPercentage(e.target.value)} /></div>
          )}
          <div>
            <label className="label">Payable to</label>
            <select className="input" value={payableTo} onChange={(e) => setPayableTo(e.target.value as "employee" | "employer_cost")}>
              <option value="employee">Employee (part of pay)</option>
              <option value="employer_cost">Employer cost / reference only</option>
            </select>
          </div>
          <div><label className="label">External payroll code</label><input className="input" value={externalCode} onChange={(e) => setExternalCode(e.target.value)} /></div>
        </div>
        {error && <p className="alert-error">{error}</p>}
        <div className="flex gap-2"><button type="submit" disabled={loading} className="btn-primary">{loading ? "Saving…" : "Create"}</button><button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button></div>
      </form>
    </div>
  );
}
