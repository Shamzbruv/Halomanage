"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function LeaveDecisionButtons({ leaveRequestId }: { leaveRequestId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(approve: boolean) {
    setLoading(approve ? "approve" : "reject");
    setError(null);
    const { error } = await supabase.rpc("decide_leave_request", {
      p_leave_request_id: leaveRequestId,
      p_approve: approve,
    });
    if (error) {
      setError(error.message);
      setLoading(null);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      <button className="btn-primary px-3 py-1.5 text-xs" disabled={!!loading} onClick={() => decide(true)}>
        {loading === "approve" ? "…" : "Approve"}
      </button>
      <button className="btn-danger px-3 py-1.5 text-xs" disabled={!!loading} onClick={() => decide(false)}>
        {loading === "reject" ? "…" : "Reject"}
      </button>
      {error && <span className="text-xs text-error">{error}</span>}
    </div>
  );
}
