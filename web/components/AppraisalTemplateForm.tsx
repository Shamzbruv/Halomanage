"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function AppraisalTemplateForm({ organizationId }: { organizationId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { data, error } = await supabase
      .from("appraisal_templates")
      .insert({
        organization_id: organizationId,
        name,
        rating_scale: [
          { value: 1, label: "Unsatisfactory" },
          { value: 2, label: "Needs improvement" },
          { value: 3, label: "Meets expectations" },
          { value: 4, label: "Exceeds expectations" },
          { value: 5, label: "Exceptional" },
        ],
      })
      .select()
      .single();
    if (error || !data) {
      setError(error?.message ?? "Failed to create template");
      setLoading(false);
      return;
    }
    setLoading(false);
    router.push(`/admin/appraisals/templates/${data.id}`);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2">
      <div className="flex-1">
        <label className="label">New checkpoint template</label>
        <input required placeholder="90-Day Probation Checkpoint" className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      {error && <p className="alert-error">{error}</p>}
      <button type="submit" disabled={loading || !name} className="btn-primary">
        {loading ? "Creating…" : "Create & edit"}
      </button>
    </form>
  );
}
