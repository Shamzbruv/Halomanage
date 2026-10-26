"use client";
import { RewardCatalogEditor } from "./RewardCatalogEditor";
import type { RewardProvider, RewardVendor } from "@/lib/rewards";
export function NewRewardVendorForm({
  organizationId,
  providers,
  initial,
}: {
  organizationId: string;
  providers: RewardProvider[];
  initial?: RewardVendor;
}) {
  return (
    <RewardCatalogEditor
      organizationId={organizationId}
      mode="vendor"
      providers={providers}
      initial={initial}
    />
  );
}
