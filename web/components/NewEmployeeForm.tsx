"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/client";

const emptyForm = { first_name: "", middle_name: "", last_name: "", preferred_name: "", work_email: "", existing_number: "" };

// Goes through create_employee_record() rather than a direct insert: the
// employee number is allocated transactionally in PostgreSQL (never
// "employees.length + 1" in the browser, which duplicates under two
// concurrent admins), the setup record is created alongside it, and the
// creation is audited. See 20260910100000_employee_setup_and_invitation_readiness.sql.
export function NewEmployeeForm({ organizationId }: { organizationId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [useExistingNumber, setUseExistingNumber] = useState(false);
  // null = organization numbers employees manually (no preview available)
  const [previewNumber, setPreviewNumber] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const manualMode = previewNumber === null;

  async function openDialog() {
    setOpen(true);
    setError(null);
    const { data } = await supabase.rpc("preview_next_employee_number", { p_organization_id: organizationId });
    setPreviewNumber((data as string | null) ?? null);
  }

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const { data, error: createError } = await supabase.rpc("create_employee_record", {
      p_organization_id: organizationId,
      p_first_name: form.first_name,
      p_last_name: form.last_name,
      p_work_email: form.work_email || null,
      p_existing_employee_number: useExistingNumber || manualMode ? form.existing_number || null : null,
      p_middle_name: form.middle_name || null,
      p_preferred_name: form.preferred_name || null,
    });
    if (createError || !data) {
      setError(createError?.message ?? "Could not create the employee record.");
      setLoading(false);
      return;
    }
    const created = data as { id: string };
    setForm(emptyForm);
    setUseExistingNumber(false);
    setLoading(false);
    setOpen(false);
    // Straight into setup: the record is the start of HR's work, not the end.
    router.push(`/admin/employees/${created.id}/setup?step=identity&created=1`);
  }

  return (
    <>
      <button className="btn-primary" onClick={openDialog}><Icon name="people" size={17} /> Add employee</button>
      {open && (
        <div className="modal-layer" role="presentation">
          <button className="modal-backdrop" aria-label="Close dialog" onClick={() => setOpen(false)} />
          <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="new-employee-title">
            <div className="modal-head"><div><span className="eyebrow">New hire</span><h3 id="new-employee-title">Add an employee record</h3><p>Create the HR record first. You&apos;ll complete their employment, access and onboarding next — the invitation is the last step, not the first.</p></div><button type="button" className="icon-button" aria-label="Close dialog" onClick={() => setOpen(false)}><Icon name="x" size={18} /></button></div>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="employee-number-preview">
                <span className="label">Employee number</span>
                {manualMode ? (
                  <input id="employee-number" required className="input" placeholder="Enter the employee number" value={form.existing_number} onChange={(event) => set("existing_number", event.target.value)} />
                ) : useExistingNumber ? (
                  <input id="employee-number" required className="input" placeholder="e.g. 004928" value={form.existing_number} onChange={(event) => set("existing_number", event.target.value)} />
                ) : (
                  <p><strong className="font-mono">{previewNumber ?? "…"}</strong> <small>assigned automatically when you create the record</small></p>
                )}
                {!manualMode && (
                  <label className="flex items-center gap-2 text-xs text-stone-600">
                    <input type="checkbox" checked={useExistingNumber} onChange={(event) => setUseExistingNumber(event.target.checked)} />
                    This person already has an employee number from a previous HR or payroll system — keep it
                  </label>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="label" htmlFor="employee-first">Legal first name</label><input id="employee-first" required className="input" value={form.first_name} onChange={(event) => set("first_name", event.target.value)} /></div>
                <div><label className="label" htmlFor="employee-middle">Middle name</label><input id="employee-middle" className="input" value={form.middle_name} onChange={(event) => set("middle_name", event.target.value)} /></div>
                <div><label className="label" htmlFor="employee-last">Legal last name</label><input id="employee-last" required className="input" value={form.last_name} onChange={(event) => set("last_name", event.target.value)} /></div>
                <div><label className="label" htmlFor="employee-preferred">Preferred name</label><input id="employee-preferred" className="input" value={form.preferred_name} onChange={(event) => set("preferred_name", event.target.value)} /></div>
              </div>
              <div><label className="label" htmlFor="employee-email">Work email</label><input id="employee-email" type="email" className="input" placeholder="name@company.com" value={form.work_email} onChange={(event) => set("work_email", event.target.value)} /><p className="mt-1 text-xs text-stone-500">Required before an invitation can be sent. You can add it later.</p></div>
              {error && <p role="alert" className="alert-error">{error}</p>}
              <div className="modal-actions"><button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button><button type="submit" disabled={loading} className="btn-primary">{loading ? "Creating…" : "Create & continue setup"}</button></div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
