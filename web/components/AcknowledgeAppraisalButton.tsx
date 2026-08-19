"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function AcknowledgeAppraisalButton({ instanceId }: { instanceId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);
    const { error } = await supabase.rpc("acknowledge_appraisal", { p_instance_id: instanceId, p_note: note || null });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-2">
      <textarea className="input" rows={2} placeholder="Optional comment" value={note} onChange={(e) => setNote(e.target.value)} />
      {error && <p className="alert-error">{error}</p>}
      <button className="btn-primary" disabled={loading} onClick={handleClick}>
        {loading ? "…" : "Acknowledge checkpoint"}
      </button>
    </div>
  );
}
