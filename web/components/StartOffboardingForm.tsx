"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type SelectOption = { id: string; label: string };

export function StartOffboardingForm({
  employees,
  templates,
  defaultTemplateId,
}: {
  employees: SelectOption[];
  templates: SelectOption[];
  defaultTemplateId: string | null;
}) {
  const supabase = createClient();
  const router = useRouter();
  const [employeeId, setEmployeeId] = useState("");
  const [templateId, setTemplateId] = useState(defaultTemplateId ?? "");
  const [finalWorkDate, setFinalWorkDate] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    const { data, error: rpcError } = await supabase.rpc("start_offboarding", {
      p_employee_id: employeeId,
      p_template_id: templateId || null,
      p_final_work_date: finalWorkDate || null,
    });

    if (rpcError || !data) {
      setError(rpcError?.message ?? "Choose a template with at least one configured checklist.");
      setLoading(false);
      return;
    }

    setEmployeeId("");
    setFinalWorkDate("");
    setLoading(false);
    router.refresh();
  }

  const unavailable = employees.length === 0 || templates.length === 0;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="offboarding-employee">Employee</label>
          <select id="offboarding-employee" required className="input" value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
            <option value="">Select an employee…</option>
            {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="offboarding-final-date">Final work date</label>
          <input
            id="offboarding-final-date"
            type="date"
            required
            className="input"
            value={finalWorkDate}
            onChange={(event) => setFinalWorkDate(event.target.value)}
          />
        </div>
      </div>
      <div>
        <label className="label" htmlFor="offboarding-template">Checklist template</label>
        <select id="offboarding-template" required className="input" value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
          <option value="">Select a template…</option>
          {templates.map((template) => <option key={template.id} value={template.id}>{template.label}</option>)}
        </select>
      </div>
      {templates.length === 0 && <p className="alert-error">Create a checklist template before starting an employee exit.</p>}
      {employees.length === 0 && <p className="text-xs text-stone-400">Add an employee before starting an exit.</p>}
      {error && <p className="alert-error" role="alert">{error}</p>}
      <button type="submit" disabled={loading || unavailable || !employeeId || !templateId || !finalWorkDate} className="btn-primary">
        {loading ? "Starting…" : "Start employee exit"}
      </button>
    </form>
  );
}
