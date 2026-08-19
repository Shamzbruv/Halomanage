"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function AppraisalSectionForm({ templateId, nextSequence }: { templateId: string; nextSequence: number }) {
  const supabase = createClient();
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.from("appraisal_sections").insert({ template_id: templateId, title, sequence: nextSequence });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    setTitle("");
    setLoading(false);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-end gap-2">
      <div className="flex-1">
        <label className="label">New section</label>
        <input required placeholder="Goals" className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      {error && <p className="alert-error">{error}</p>}
      <button type="submit" disabled={loading || !title} className="btn-secondary">{loading ? "…" : "Add section"}</button>
    </form>
  );
}
