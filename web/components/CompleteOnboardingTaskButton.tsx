"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function CompleteOnboardingTaskButton({ taskId }: { taskId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);
    const { error } = await supabase.rpc("complete_onboarding_task", { p_task_id: taskId, p_completion_data: null });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      <button className="btn-secondary px-3 py-1 text-xs" disabled={loading} onClick={handleClick}>
        {loading ? "…" : "Mark complete"}
      </button>
      {error && <span className="text-xs text-error">{error}</span>}
    </div>
  );
}
