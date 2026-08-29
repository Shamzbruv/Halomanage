"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { resolveFunctionErrorMessage } from "@/lib/supabase/functions";

export function RedeemRewardButton({ productId, canAfford }: { productId: string; canAfford: boolean }) {
  const supabase = createClient();
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function redeem() {
    setLoading(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("redeem_reward", { p_product_id: productId });
    if (rpcError) {
      setError(await resolveFunctionErrorMessage(rpcError, "Could not redeem this reward."));
      setLoading(false);
      return;
    }
    setLoading(false);
    setConfirming(false);
    router.refresh();
  }

  if (confirming) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex gap-1">
          <button type="button" className="btn-primary px-2.5 py-1 text-xs" disabled={loading} onClick={() => void redeem()}>{loading ? "Redeeming…" : "Confirm"}</button>
          <button type="button" className="btn-secondary px-2.5 py-1 text-xs" disabled={loading} onClick={() => setConfirming(false)}>Cancel</button>
        </div>
        {error && <span className="text-xs leading-snug text-ruby-600">{error}</span>}
      </div>
    );
  }

  return (
    <button type="button" className="btn-primary px-3 py-1 text-xs" disabled={!canAfford} onClick={() => setConfirming(true)}>
      {canAfford ? "Redeem" : "Not enough points"}
    </button>
  );
}
