"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function CompleteOffboardingTaskButton({ taskId }: { taskId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function completeTask() {
    setLoading(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("complete_offboarding_task", { p_task_id: taskId });

    if (rpcError) {
      setError(rpcError.message);
      setLoading(false);
      return;
    }

    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" className="btn-secondary min-h-8 px-2.5 py-1 text-xs" disabled={loading} onClick={completeTask}>
        {loading ? "Saving…" : "Mark complete"}
      </button>
      {error && <small className="max-w-48 text-right text-error" role="alert">{error}</small>}
    </div>
  );
}
