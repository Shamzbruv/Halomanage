"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function PositionForm({ organizationId }: { organizationId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [jobCode, setJobCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.from("positions").insert({
      organization_id: organizationId,
      title,
      job_code: jobCode || null,
    });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    setTitle("");
    setJobCode("");
    setLoading(false);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <input required placeholder="Title (e.g. Customer Service Representative)" className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      <input placeholder="Job code (optional)" className="input" value={jobCode} onChange={(e) => setJobCode(e.target.value)} />
      {error && <p className="alert-error">{error}</p>}
      <button type="submit" disabled={loading} className="btn-secondary w-full">
        {loading ? "Adding…" : "Add position"}
      </button>
    </form>
  );
}
