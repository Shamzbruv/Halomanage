"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Ref: PRODUCT_BLUEPRINT.md "Build a Leave Type Builder" — every field here
// maps directly to a leave_types column (20260818000700_leave.sql). No
// leave-type-specific code exists anywhere else in the app; submit_leave()
// reads these settings to decide notice/attachment/approval requirements.
export function LeaveTypeForm({ organizationId }: { organizationId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    code: "",
    is_paid: true,
    requires_approval: true,
    requires_attachment: false,
    attachment_after_days: "",
    requires_manager_approval_over_days: "",
    allow_half_day: true,
    allow_negative_balance: false,
    minimum_notice_days: "0",
    maximum_consecutive_days: "",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.from("leave_types").insert({
      organization_id: organizationId,
      name: form.name,
      code: form.code.toUpperCase(),
      is_paid: form.is_paid,
      requires_approval: form.requires_approval,
      requires_attachment: form.requires_attachment,
      attachment_after_days: form.attachment_after_days ? Number(form.attachment_after_days) : null,
      requires_manager_approval_over_days: form.requires_manager_approval_over_days
        ? Number(form.requires_manager_approval_over_days)
        : null,
      allow_half_day: form.allow_half_day,
      allow_negative_balance: form.allow_negative_balance,
      minimum_notice_days: Number(form.minimum_notice_days || 0),
      maximum_consecutive_days: form.maximum_consecutive_days ? Number(form.maximum_consecutive_days) : null,
    });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    setOpen(false);
    setLoading(false);
    router.refresh();
  }

  if (!open) {
    return (
      <button className="btn-primary" onClick={() => setOpen(true)}>
        New leave type
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="card max-w-xl space-y-3">
      <h3 className="text-sm font-semibold text-stone-900">New leave type</h3>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Name</label>
          <input required placeholder="Vacation" className="input" value={form.name} onChange={(e) => set("name", e.target.value)} />
        </div>
        <div>
          <label className="label">Code</label>
          <input required placeholder="VAC" className="input" value={form.code} onChange={(e) => set("code", e.target.value)} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <label className="flex items-center gap-2 text-sm text-stone-600">
          <input type="checkbox" checked={form.is_paid} onChange={(e) => set("is_paid", e.target.checked)} /> Paid
        </label>
        <label className="flex items-center gap-2 text-sm text-stone-600">
          <input type="checkbox" checked={form.requires_approval} onChange={(e) => set("requires_approval", e.target.checked)} /> Requires approval
        </label>
        <label className="flex items-center gap-2 text-sm text-stone-600">
          <input type="checkbox" checked={form.allow_half_day} onChange={(e) => set("allow_half_day", e.target.checked)} /> Half-day allowed
        </label>
        <label className="flex items-center gap-2 text-sm text-stone-600">
          <input type="checkbox" checked={form.requires_attachment} onChange={(e) => set("requires_attachment", e.target.checked)} /> Requires attachment
        </label>
        <label className="flex items-center gap-2 text-sm text-stone-600">
          <input type="checkbox" checked={form.allow_negative_balance} onChange={(e) => set("allow_negative_balance", e.target.checked)} /> Allow negative balance
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <label className="label">Min notice (days)</label>
          <input type="number" min={0} className="input" value={form.minimum_notice_days} onChange={(e) => set("minimum_notice_days", e.target.value)} />
        </div>
        <div>
          <label className="label">Max consecutive</label>
          <input type="number" min={0} placeholder="No limit" className="input" value={form.maximum_consecutive_days} onChange={(e) => set("maximum_consecutive_days", e.target.value)} />
        </div>
        <div>
          <label className="label">Attachment after (days)</label>
          <input type="number" min={0} placeholder="—" className="input" value={form.attachment_after_days} onChange={(e) => set("attachment_after_days", e.target.value)} />
        </div>
        <div>
          <label className="label">Manager approval over (days)</label>
          <input type="number" min={0} placeholder="—" className="input" value={form.requires_manager_approval_over_days} onChange={(e) => set("requires_manager_approval_over_days", e.target.value)} />
        </div>
      </div>

      {error && <p className="alert-error">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={loading} className="btn-primary">{loading ? "Saving…" : "Create"}</button>
        <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}
