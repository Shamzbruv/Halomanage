"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { resolveFunctionErrorMessage } from "@/lib/supabase/functions";

export function RedemptionFulfillmentActions({ redemptionId }: { redemptionId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fulfill() {
    setLoading(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("fulfill_redemption", { p_redemption_id: redemptionId, p_note: note || null });
    if (rpcError) {
      setError(await resolveFunctionErrorMessage(rpcError, "Could not mark this fulfilled."));
      setLoading(false);
      return;
    }
    setLoading(false);
    router.refresh();
  }

  async function cancel() {
    setLoading(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("cancel_redemption", { p_redemption_id: redemptionId, p_reason: note || null });
    if (rpcError) {
      setError(await resolveFunctionErrorMessage(rpcError, "Could not cancel this redemption."));
      setLoading(false);
      return;
    }
    setLoading(false);
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-1">
        <input className="input" style={{ width: 160 }} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} disabled={loading} />
        <button type="button" className="btn-primary px-2.5 py-1 text-xs" disabled={loading} onClick={() => void fulfill()}>Fulfill</button>
        <button type="button" className="btn-danger px-2.5 py-1 text-xs" disabled={loading} onClick={() => void cancel()}>Cancel</button>
      </div>
      {error && <span className="text-xs leading-snug text-ruby-600">{error}</span>}
    </div>
  );
}
