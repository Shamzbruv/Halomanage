import { formatDate } from "@/lib/timezone";
import { rewardStatus, type RewardReceipt as Receipt } from "@/lib/rewards";
import { RedemptionFulfillmentActions } from "./RedemptionFulfillmentActions";
export function RewardReceipt({
  receipt,
  timezone,
  admin = false,
}: {
  receipt: Receipt;
  timezone?: string;
  admin?: boolean;
}) {
  return (
    <article
      className="rounded-xl border border-stone-200 p-4 space-y-2"
      id={`reward-${receipt.id}`}
    >
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h3 className="font-semibold">{receipt.product_name}</h3>
          <p>
            {receipt.vendor_name} · {receipt.points_spent.toLocaleString()}{" "}
            points
          </p>
          {admin && (
            <p>
              {receipt.employee_name} · {receipt.employee_status}
            </p>
          )}
        </div>
        <strong>{rewardStatus(receipt.status)}</strong>
      </div>
      <p className="text-sm">
        Requested {formatDate(receipt.created_at, timezone)}
        {receipt.resolved_at
          ? ` · Resolved ${formatDate(receipt.resolved_at, timezone)}`
          : ""}
      </p>
      <p className="text-xs text-stone-500">Reference: {receipt.id}</p>
      {receipt.product_description && <p>{receipt.product_description}</p>}
      {receipt.terms && (
        <details>
          <summary>Terms at request</summary>
          <p className="whitespace-pre-wrap">{receipt.terms}</p>
        </details>
      )}
      {(receipt.fulfillment_note || receipt.cancelled_reason) && (
        <p className="whitespace-pre-wrap">
          <strong>
            {receipt.status === "fulfilled"
              ? "Collection / delivery details"
              : "Outcome explanation"}
            :{" "}
          </strong>
          {receipt.fulfillment_note || receipt.cancelled_reason}
        </p>
      )}
      {["cancelled", "failed"].includes(receipt.status) && (
        <p className="text-sm">
          All {receipt.points_spent.toLocaleString()} points refunded.
        </p>
      )}
      {receipt.status === "pending_fulfillment" && (
        <RedemptionFulfillmentActions redemptionId={receipt.id} self={!admin} />
      )}
    </article>
  );
}
