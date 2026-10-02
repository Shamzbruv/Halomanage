"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// decide_employee_record_request(): approving a name or date-of-birth
// correction writes it to the record; other corrections are made by HR in
// the employee's record first, then approved to confirm. Declining needs a
// reason the employee will see.
export function DecideRecordRequest({ requestId, autoApplies, kind }: { requestId: string; autoApplies: boolean; kind: "correction" | "data_access" }) {
  const supabase = createClient();
  const router = useRouter();
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(approve: boolean) {
    setLoading(approve ? "approve" : "reject");
    setError(null);
    const { error: rpcError } = await supabase.rpc("decide_employee_record_request", { p_request_id: requestId, p_approve: approve, p_note: note || null });
    if (rpcError) setError(rpcError.message);
    setLoading(null);
    router.refresh();
  }

  const approveLabel = kind === "data_access" ? "Mark completed" : autoApplies ? "Approve & update record" : "Mark corrected";
  return (
    <div className="w-full max-w-md space-y-2">
      <input className="input" aria-label="Note to the employee" placeholder={kind === "data_access" ? "e.g. Copy uploaded to your Documents" : "Note to the employee (required to decline)"} value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-primary px-3 py-1.5 text-xs" disabled={loading !== null} onClick={() => decide(true)}>{loading === "approve" ? "Saving…" : approveLabel}</button>
        <button type="button" className="btn-secondary px-3 py-1.5 text-xs" disabled={loading !== null || !note.trim()} onClick={() => decide(false)}>{loading === "reject" ? "Saving…" : "Decline"}</button>
      </div>
      {error && <p role="alert" className="text-xs text-ruby-600">{error}</p>}
    </div>
  );
}
