"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Icon } from "@/components/Icon";

const CATEGORIES = [
  { value: "laptop", label: "Laptop" },
  { value: "phone", label: "Phone" },
  { value: "access_card", label: "Access card" },
  { value: "key", label: "Key" },
  { value: "uniform", label: "Uniform" },
  { value: "vehicle", label: "Vehicle" },
  { value: "other", label: "Other" },
];

// Ref: 20260818001400_training_assets.sql `assets` table. Adds an item to
// the organization's equipment pool; assigning it to a specific employee
// (and recording its return) happens from that employee's detail page
// (AssignAssetForm/ReturnAssetButton) — the same catalog/assignment split
// NewTrainingCourseForm uses.
export function NewAssetForm({ organizationId }: { organizationId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState(CATEGORIES[0].value);
  const [name, setName] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.from("assets").insert({
      organization_id: organizationId,
      category,
      name,
      serial_number: serialNumber || null,
    });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    setName("");
    setSerialNumber("");
    setOpen(false);
    setLoading(false);
    router.refresh();
  }

  if (!open) {
    return <button type="button" className="btn-primary" onClick={() => setOpen(true)}><Icon name="organization" size={16} /> New asset</button>;
  }

  return (
    <div className="modal-layer" role="presentation">
      <button type="button" className="modal-backdrop" aria-label="Close dialog" onClick={() => setOpen(false)} />
      <form onSubmit={handleSubmit} className="modal-card space-y-3" role="dialog" aria-modal="true" aria-labelledby="new-asset-title">
        <div className="modal-head">
          <div><span className="eyebrow">Asset inventory</span><h3 id="new-asset-title">New asset</h3><p>Add one item to the pool before assigning it to anyone.</p></div>
          <button type="button" className="icon-button" aria-label="Close dialog" onClick={() => setOpen(false)}><Icon name="x" size={18} /></button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="asset-category">Category</label>
            <select id="asset-category" className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="asset-serial">Serial / ID number</label>
            <input id="asset-serial" className="input" value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} />
          </div>
          <div className="col-span-2">
            <label className="label" htmlFor="asset-name">Name</label>
            <input id="asset-name" required className="input" placeholder="MacBook Pro 14&quot;" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>
        {error && <p className="alert-error">{error}</p>}
        <div className="flex gap-2">
          <button type="submit" disabled={loading} className="btn-primary">{loading ? "Saving…" : "Create"}</button>
          <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
