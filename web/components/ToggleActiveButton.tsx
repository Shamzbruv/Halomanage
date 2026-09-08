"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Shared "deactivate/reactivate" control for simple org-scoped catalog rows
// that use an is_active flag instead of a delete policy (training_courses,
// assets — same pattern leave_types and reward catalog rows already use).
// A row stays available for anything that already references it (assigned
// training, an open asset assignment) but drops out of "new assignment"
// pickers once inactive.
export function ToggleActiveButton({ table, id, isActive }: { table: "training_courses" | "assets"; id: string; isActive: boolean }) {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    const { error } = await supabase.from(table).update({ is_active: !isActive }).eq("id", id);
    setLoading(false);
    if (!error) router.refresh();
  }

  return (
    <button type="button" className="btn-ghost text-xs" disabled={loading} onClick={handleClick}>
      {loading ? "…" : isActive ? "Deactivate" : "Reactivate"}
    </button>
  );
}
