"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function LaunchCycleButton({ cycleId }: { cycleId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (!confirm("Launch this cycle? An appraisal instance will be created for every active employee.")) return;
    setLoading(true);
    setError(null);
    const { error } = await supabase.rpc("launch_appraisal_cycle", { p_cycle_id: cycleId });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      <button className="btn-primary px-3 py-1 text-xs" disabled={loading} onClick={handleClick}>
        {loading ? "…" : "Launch"}
      </button>
      {error && <span className="text-xs text-error">{error}</span>}
    </div>
  );
}
