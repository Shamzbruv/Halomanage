"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function ApproveBatchButton({ batchId }: { batchId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleApprove() {
    if (!confirm("Post this batch to employee records? This posts the imported figures as-is.")) return;
    setLoading(true);
    setError(null);
    const { error } = await supabase.rpc("approve_payroll_import", { p_batch_id: batchId });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      <button className="btn-primary px-3 py-1 text-xs" disabled={loading} onClick={handleApprove}>
        {loading ? "…" : "Approve & post"}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
