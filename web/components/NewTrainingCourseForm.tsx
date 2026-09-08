"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Icon } from "@/components/Icon";

// Ref: PRODUCT_BLUEPRINT.md "Training/Certifications" module,
// 20260818001400_training_assets.sql. Org-wide course catalog; assigning a
// course to a specific employee happens from that employee's own detail
// page (AssignTrainingForm), the same split compensation_components /
// employee_compensation_components already uses (shared structure vs.
// per-person assignment).
export function NewTrainingCourseForm({ organizationId }: { organizationId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isRequired, setIsRequired] = useState(false);
  const [validityMonths, setValidityMonths] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.from("training_courses").insert({
      organization_id: organizationId,
      name,
      description: description || null,
      is_required: isRequired,
      validity_months: validityMonths ? Number(validityMonths) : null,
    });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    setName("");
    setDescription("");
    setIsRequired(false);
    setValidityMonths("");
    setOpen(false);
    setLoading(false);
    router.refresh();
  }

  if (!open) {
    return <button type="button" className="btn-primary" onClick={() => setOpen(true)}><Icon name="spark" size={16} /> New course</button>;
  }

  return (
    <div className="modal-layer" role="presentation">
      <button type="button" className="modal-backdrop" aria-label="Close dialog" onClick={() => setOpen(false)} />
      <form onSubmit={handleSubmit} className="modal-card space-y-3" role="dialog" aria-modal="true" aria-labelledby="new-course-title">
        <div className="modal-head">
          <div><span className="eyebrow">Learning catalog</span><h3 id="new-course-title">New training course</h3><p>Appears as an assignable option on every employee&apos;s record.</p></div>
          <button type="button" className="icon-button" aria-label="Close dialog" onClick={() => setOpen(false)}><Icon name="x" size={18} /></button>
        </div>
        <div>
          <label className="label" htmlFor="course-name">Name</label>
          <input id="course-name" required className="input" placeholder="Workplace safety" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="course-description">Description</label>
          <textarea id="course-description" className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex items-center gap-2 text-sm text-stone-600">
            <input type="checkbox" checked={isRequired} onChange={(e) => setIsRequired(e.target.checked)} /> Required for everyone assigned
          </label>
          <div>
            <label className="label" htmlFor="course-validity">Renews every (months)</label>
            <input id="course-validity" type="number" min={0} placeholder="No expiry" className="input" value={validityMonths} onChange={(e) => setValidityMonths(e.target.value)} />
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
