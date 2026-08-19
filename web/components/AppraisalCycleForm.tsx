"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function AppraisalCycleForm({
  organizationId,
  templates,
}: {
  organizationId: string;
  templates: { id: string; label: string }[];
}) {
  const supabase = createClient();
  const router = useRouter();
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.from("appraisal_cycles").insert({
      organization_id: organizationId,
      template_id: templateId,
      name,
      start_date: startDate,
    });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    setName("");
    setLoading(false);
    router.refresh();
  }

  if (templates.length === 0) {
    return <p className="text-sm text-stone-400">Create a checkpoint template first.</p>;
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2">
      <div className="flex-1">
        <label className="label">Cycle name</label>
        <input required placeholder="Q1 2027 Performance Review" className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <label className="label">Template</label>
        <select className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </div>
      <div>
        <label className="label">Start date</label>
        <input type="date" className="input" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
      </div>
      {error && <p className="alert-error">{error}</p>}
      <button type="submit" disabled={loading || !name} className="btn-secondary">{loading ? "…" : "Create cycle"}</button>
    </form>
  );
}
