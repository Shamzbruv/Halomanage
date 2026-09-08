"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const STATUSES = ["assigned", "in_progress", "completed", "expired"] as const;

// HR-side status control — employee_training has no employee-facing update
// policy (only "read own"), so status here is deliberately an HR/admin
// action: it records what actually happened (e.g. after verifying
// completion in an external LMS), not a self-report.
export function TrainingStatusSelect({ id, status }: { id: string; status: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleChange(next: string) {
    setLoading(true);
    const { error } = await supabase
      .from("employee_training")
      .update({ status: next, completed_at: next === "completed" ? new Date().toISOString() : null })
      .eq("id", id);
    setLoading(false);
    if (!error) router.refresh();
  }

  return (
    <select className="input" disabled={loading} value={status} onChange={(e) => handleChange(e.target.value)}>
      {STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
    </select>
  );
}
