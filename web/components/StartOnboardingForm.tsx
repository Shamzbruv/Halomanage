"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function StartOnboardingForm({
  employees,
  templates,
}: {
  employees: { id: string; label: string }[];
  templates: { id: string; label: string }[];
}) {
  const supabase = createClient();
  const router = useRouter();
  const [employeeId, setEmployeeId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.rpc("start_onboarding", {
      p_employee_id: employeeId,
      p_template_id: templateId || null,
    });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    setEmployeeId("");
    setLoading(false);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2">
      <div className="flex-1">
        <label className="label">Employee</label>
        <select required className="input" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
          <option value="">Select…</option>
          {employees.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
        </select>
      </div>
      <div className="flex-1">
        <label className="label">Template</label>
        <select className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          <option value="">Default template</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </div>
      {error && <p className="alert-error">{error}</p>}
      <button type="submit" disabled={loading || !employeeId} className="btn-primary">
        {loading ? "Starting…" : "Start onboarding"}
      </button>
    </form>
  );
}
