export type RewardVendor = {
  id: string;
  provider_id: string;
  name: string;
  description: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  is_active: boolean;
  updated_at: string;
};
export type RewardProduct = {
  id: string;
  vendor_id: string;
  name: string;
  vendor_name: string;
  description: string | null;
  terms: string | null;
  image_url: string | null;
  points_cost: number;
  inventory_quantity: number | null;
  is_active: boolean;
  updated_at: string;
};
export type RewardReceipt = {
  id: string;
  employee_id: string;
  employee_name?: string;
  employee_status?: string;
  product_name: string;
  vendor_name: string;
  product_description: string | null;
  terms: string | null;
  points_spent: number;
  fulfillment_type: string;
  status: "pending_fulfillment" | "fulfilled" | "cancelled" | "failed";
  fulfillment_note: string | null;
  cancelled_reason: string | null;
  created_at: string;
  resolved_at: string | null;
};
export type RewardLedgerItem = {
  id: string;
  entry_type: string;
  amount: number;
  reason: string | null;
  created_at: string;
  related_redemption_id: string | null;
  related_recognition_id: string | null;
};
export type RewardsState = {
  enabled: boolean;
  can_redeem: boolean;
  balance: number;
  catalog_total: number;
  catalog: RewardProduct[];
  history_total: number;
  history: RewardReceipt[];
  selected: RewardReceipt | null;
  ledger_total: number;
  ledger: RewardLedgerItem[];
};
export type RewardProvider = {
  id: string;
  name: string;
  fulfillment_type: string;
};
export type RewardsAdminState = {
  enabled: boolean;
  can_catalog: boolean;
  can_fulfill: boolean;
  can_award: boolean;
  providers: RewardProvider[];
  vendors: RewardVendor[];
  products_total: number;
  products: RewardProduct[];
  requests_total: number;
  requests: RewardReceipt[];
  pending_count: number | null;
  oldest_pending: string | null;
  negative_balances: number | null;
};
export function rewardPage(value: string | undefined) {
  return Math.max(1, Math.min(100000, Math.trunc(Number(value)) || 1));
}
export function rewardStatus(value: string) {
  return value === "pending_fulfillment"
    ? "Awaiting fulfillment"
    : value.charAt(0).toUpperCase() + value.slice(1).replaceAll("_", " ");
}
