"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { RewardDialog } from "./RewardDialog";
import type { RewardProduct } from "@/lib/rewards";
export function RedeemRewardButton({
  product,
  balance,
}: {
  product: RewardProduct;
  balance: number;
}) {
  const router = useRouter(),
    retry = useRef<{ payload: string; key: string } | null>(null),
    submitting = useRef(false);
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  async function redeem() {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    const payload = JSON.stringify([
      product.id,
      product.points_cost,
      product.updated_at,
    ]);
    if (retry.current?.payload !== payload)
      retry.current = { payload, key: crypto.randomUUID() };
    try {
      const { error } = await createClient().rpc("request_reward", {
        p_product_id: product.id,
        p_client_request_id: retry.current.key,
        p_expected_points_cost: product.points_cost,
        p_expected_updated_at: product.updated_at,
      });
      if (error) throw error;
      retry.current = null;
      setOpen(false);
      router.refresh();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : ((error as { message?: string })?.message ??
              "Unable to submit. Retry safely, or refresh to review current details."),
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className="btn-primary"
        disabled={
          balance < product.points_cost || product.inventory_quantity === 0
        }
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {product.inventory_quantity === 0
          ? "Out of stock"
          : balance < product.points_cost
            ? "Not enough points"
            : "Redeem"}
      </button>
      <RewardDialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Redeem ${product.name}`}
        busy={busy}
      >
        <div className="space-y-3">
          <p>
            {product.vendor_name} ·{" "}
            <strong>{product.points_cost.toLocaleString()} points</strong>
          </p>
          <p>
            Balance after request:{" "}
            {(balance - product.points_cost).toLocaleString()} points.
          </p>
          <p>{product.description}</p>
          <p className="whitespace-pre-wrap">
            {product.terms ||
              "HR arranges collection or delivery. Contact HR for details before requesting."}
          </p>
          <p className="text-sm">
            Points are deducted when you request this reward. You can cancel
            while it awaits fulfillment; cancelled or failed requests receive a
            full points refund.
          </p>
          {error && (
            <p role="alert" className="alert-error">
              {error}
            </p>
          )}
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={() => void redeem()}
          >
            {busy
              ? "Submitting…"
              : `Confirm ${product.points_cost.toLocaleString()} points`}
          </button>
        </div>
      </RewardDialog>
    </>
  );
}
