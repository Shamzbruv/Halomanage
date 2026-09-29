"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Identity = {
  employee_number: string;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  preferred_name: string | null;
  work_email: string | null;
  work_phone: string | null;
  external_payroll_id: string | null;
};

// HR-controlled directory fields on public.employees. RLS already lets an
// employee.manage holder update the row directly; an employee-number change
// is audited by a database trigger (EMPLOYEE_NUMBER_CHANGED).
//
// Input ids match readiness item codes (employee_number, work_email…) so a
// blocker link like …/setup?step=identity#work_email lands on the field.
export function EmployeeIdentityForm({
  employeeId,
  initial,
  hasAccount,
}: {
  employeeId: string;
  initial: Identity;
  // Once an invitation exists the work email is tied to the Auth account;
  // it must be changed with "Edit email" in People so the pending
  // invitation is corrected too (see invite-employee's correct_email mode).
  hasAccount: boolean;
}) {
  const supabase = createClient();
  const router = useRouter();
  const [form, setForm] = useState({
    employee_number: initial.employee_number,
    first_name: initial.first_name,
    middle_name: initial.middle_name ?? "",
    last_name: initial.last_name,
    preferred_name: initial.preferred_name ?? "",
    work_email: initial.work_email ?? "",
    work_phone: initial.work_phone ?? "",
    external_payroll_id: initial.external_payroll_id ?? "",
  });
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
    setSaved(false);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const update: Record<string, string | null> = {
      employee_number: form.employee_number.trim(),
      first_name: form.first_name.trim(),
      middle_name: form.middle_name.trim() || null,
      last_name: form.last_name.trim(),
      preferred_name: form.preferred_name.trim() || null,
      work_phone: form.work_phone.trim() || null,
      external_payroll_id: form.external_payroll_id.trim() || null,
    };
    if (!hasAccount) update.work_email = form.work_email.trim() || null;
    const { error: updateError } = await supabase.from("employees").update(update).eq("id", employeeId);
    if (updateError) {
      setError(updateError.code === "23505" ? `Employee number ${form.employee_number} is already in use.` : updateError.message);
      setLoading(false);
      return;
    }
    setSaved(true);
    setLoading(false);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="employee_number">Employee number</label>
          <input id="employee_number" required className="input font-mono" value={form.employee_number} onChange={(e) => set("employee_number", e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="external_payroll_id">External payroll ID</label>
          <input id="external_payroll_id" className="input" placeholder="Optional — ID in your payroll system" value={form.external_payroll_id} onChange={(e) => set("external_payroll_id", e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="first_name">Legal first name</label>
          <input id="first_name" required className="input" value={form.first_name} onChange={(e) => set("first_name", e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="middle_name">Legal middle name</label>
          <input id="middle_name" className="input" value={form.middle_name} onChange={(e) => set("middle_name", e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="last_name">Legal last name</label>
          <input id="last_name" required className="input" value={form.last_name} onChange={(e) => set("last_name", e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="preferred_name">Preferred name</label>
          <input id="preferred_name" className="input" value={form.preferred_name} onChange={(e) => set("preferred_name", e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="work_email">Work email</label>
          <input id="work_email" type="email" className="input" disabled={hasAccount} value={form.work_email} onChange={(e) => set("work_email", e.target.value)} />
          {hasAccount && <p className="mt-1 text-xs text-stone-500">Linked to their sign-in account — use <strong>Edit email</strong> in People to change it.</p>}
        </div>
        <div>
          <label className="label" htmlFor="work_phone">Work phone</label>
          <input id="work_phone" className="input" value={form.work_phone} onChange={(e) => set("work_phone", e.target.value)} />
        </div>
      </div>
      {error && <p role="alert" className="alert-error">{error}</p>}
      {saved && !error && <p role="status" className="text-xs text-emerald-700">Saved.</p>}
      <button type="submit" disabled={loading} className="btn-primary">{loading ? "Saving…" : "Save identity"}</button>
    </form>
  );
}

// Hire and probation dates live on employees (HR controlled). Onboarding
// due dates anchored to them move automatically when they change.
export function EmploymentDatesForm({
  employeeId,
  hireDate,
  probationEndDate,
}: {
  employeeId: string;
  hireDate: string | null;
  probationEndDate: string | null;
}) {
  const supabase = createClient();
  const router = useRouter();
  const [hire, setHire] = useState(hireDate ?? "");
  const [probation, setProbation] = useState(probationEndDate ?? "");
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (hire && probation && probation < hire) {
      setError("The probation end date must be after the hire date.");
      return;
    }
    setLoading(true);
    setError(null);
    const { error: updateError } = await supabase
      .from("employees")
      .update({ hire_date: hire || null, probation_end_date: probation || null })
      .eq("id", employeeId);
    if (updateError) {
      setError(updateError.message);
      setLoading(false);
      return;
    }
    setSaved(true);
    setLoading(false);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
      <div>
        <label className="label" htmlFor="hire_date">Hire / start date</label>
        <input id="hire_date" type="date" className="input" value={hire} onChange={(e) => { setHire(e.target.value); setSaved(false); }} />
      </div>
      <div>
        <label className="label" htmlFor="probation_end_date">Probation end date</label>
        <input id="probation_end_date" type="date" className="input" value={probation} onChange={(e) => { setProbation(e.target.value); setSaved(false); }} />
      </div>
      <button type="submit" disabled={loading} className="btn-primary">{loading ? "Saving…" : "Save dates"}</button>
      {error && <p role="alert" className="alert-error w-full">{error}</p>}
      {saved && !error && <p role="status" className="w-full text-xs text-emerald-700">Saved.</p>}
    </form>
  );
}
