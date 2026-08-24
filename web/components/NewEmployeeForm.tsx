"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/client";

export function NewEmployeeForm({ organizationId }: { organizationId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ employee_number: "", first_name: "", last_name: "", work_email: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const { error: insertError } = await supabase.from("employees").insert({
      organization_id: organizationId,
      employee_number: form.employee_number,
      first_name: form.first_name,
      last_name: form.last_name,
      work_email: form.work_email || null,
      status: "prehire",
    });
    if (insertError) {
      setError(insertError.message);
      setLoading(false);
      return;
    }
    setForm({ employee_number: "", first_name: "", last_name: "", work_email: "" });
    setLoading(false);
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <button className="btn-primary" onClick={() => setOpen(true)}><Icon name="people" size={17} /> Add employee</button>
      {open && (
        <div className="modal-layer" role="presentation">
          <button className="modal-backdrop" aria-label="Close dialog" onClick={() => setOpen(false)} />
          <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="new-employee-title">
            <div className="modal-head"><div><span className="eyebrow">New hire</span><h3 id="new-employee-title">Add an employee record</h3><p>Create the HR record first. You can set their assignment and send an account invitation next.</p></div><button type="button" className="icon-button" aria-label="Close dialog" onClick={() => setOpen(false)}><Icon name="x" size={18} /></button></div>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div><label className="label" htmlFor="employee-number">Employee number</label><input id="employee-number" required className="input" placeholder="EMP-0042" value={form.employee_number} onChange={(event) => setForm({ ...form, employee_number: event.target.value })} /></div>
              <div className="grid grid-cols-2 gap-3"><div><label className="label" htmlFor="employee-first">First name</label><input id="employee-first" required className="input" value={form.first_name} onChange={(event) => setForm({ ...form, first_name: event.target.value })} /></div><div><label className="label" htmlFor="employee-last">Last name</label><input id="employee-last" required className="input" value={form.last_name} onChange={(event) => setForm({ ...form, last_name: event.target.value })} /></div></div>
              <div><label className="label" htmlFor="employee-email">Work email</label><input id="employee-email" required type="email" className="input" placeholder="name@company.com" value={form.work_email} onChange={(event) => setForm({ ...form, work_email: event.target.value })} /></div>
              {error && <p role="alert" className="alert-error">{error}</p>}
              <div className="modal-actions"><button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button><button type="submit" disabled={loading} className="btn-primary">{loading ? "Creating…" : "Create employee"}</button></div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
