"use client";
import { RewardCatalogEditor } from "./RewardCatalogEditor";
import type { RewardProduct } from "@/lib/rewards";
export function NewRewardProductForm({
  organizationId,
  vendors,
  initial,
}: {
  organizationId: string;
  vendors: { id: string; name: string }[];
  initial?: RewardProduct;
}) {
  return (
    <RewardCatalogEditor
      organizationId={organizationId}
      mode="product"
      vendors={vendors}
      initial={initial}
    />
  );
}
