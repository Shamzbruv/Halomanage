"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Option = { id: string; label: string };

// Ref: docs/ARCHITECTURE.md "Use effective-dated records" — this always
// calls change_employee_assignment(), never a direct UPDATE, so the prior
// assignment is preserved as history rather than overwritten. See
// supabase/migrations/20260818001800_employee_assignment_rpc.sql.
export function ChangeAssignmentForm({
  employeeId,
  orgUnits,
  positions,
  locations,
  employees,
}: {
  employeeId: string;
  orgUnits: Option[];
  positions: Option[];
  locations: Option[];
  employees: Option[];
}) {
  const supabase = createClient();
  const router = useRouter();
  const [form, setForm] = useState({
    org_unit_id: "",
    position_id: "",
    location_id: "",
    supervisor_employee_id: "",
    manager_employee_id: "",
    employment_type: "full_time",
    start_date: new Date().toISOString().slice(0, 10),
    change_reason: "",
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
    const { error } = await supabase.rpc("change_employee_assignment", {
      p_employee_id: employeeId,
      p_org_unit_id: form.org_unit_id || null,
      p_position_id: form.position_id || null,
      p_location_id: form.location_id || null,
      p_supervisor_employee_id: form.supervisor_employee_id || null,
      p_manager_employee_id: form.manager_employee_id || null,
      p_employment_type: form.employment_type,
      p_start_date: form.start_date,
      p_change_reason: form.change_reason || null,
    });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    setLoading(false);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Department / team</label>
          <select className="input" value={form.org_unit_id} onChange={(e) => set("org_unit_id", e.target.value)}>
            <option value="">—</option>
            {orgUnits.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Position</label>
          <select className="input" value={form.position_id} onChange={(e) => set("position_id", e.target.value)}>
            <option value="">—</option>
            {positions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Location</label>
          <select className="input" value={form.location_id} onChange={(e) => set("location_id", e.target.value)}>
            <option value="">—</option>
            {locations.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Employment type</label>
          <select className="input" value={form.employment_type} onChange={(e) => set("employment_type", e.target.value)}>
            <option value="full_time">Full-time</option>
            <option value="part_time">Part-time</option>
            <option value="contract">Contract</option>
            <option value="temporary">Temporary</option>
            <option value="intern">Intern</option>
          </select>
        </div>
        <div>
          <label className="label">Supervisor</label>
          <select className="input" value={form.supervisor_employee_id} onChange={(e) => set("supervisor_employee_id", e.target.value)}>
            <option value="">None</option>
            {employees.filter((e) => e.id !== employeeId).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Manager</label>
          <select className="input" value={form.manager_employee_id} onChange={(e) => set("manager_employee_id", e.target.value)}>
            <option value="">None</option>
            {employees.filter((e) => e.id !== employeeId).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Effective date</label>
          <input type="date" className="input" value={form.start_date} onChange={(e) => set("start_date", e.target.value)} />
        </div>
        <div>
          <label className="label">Reason (optional)</label>
          <input className="input" placeholder="e.g. Promotion" value={form.change_reason} onChange={(e) => set("change_reason", e.target.value)} />
        </div>
      </div>
      {error && <p className="alert-error">{error}</p>}
      <button type="submit" disabled={loading} className="btn-primary">
        {loading ? "Saving…" : "Save assignment"}
      </button>
    </form>
  );
}
