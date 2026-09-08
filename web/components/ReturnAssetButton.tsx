"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function ReturnAssetButton({ assignmentId }: { assignmentId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    const { error } = await supabase
      .from("employee_asset_assignments")
      .update({ returned_at: new Date().toISOString() })
      .eq("id", assignmentId);
    setLoading(false);
    if (!error) router.refresh();
  }

  return (
    <button type="button" className="btn-ghost text-xs" disabled={loading} onClick={handleClick}>
      {loading ? "…" : "Mark returned"}
    </button>
  );
}
