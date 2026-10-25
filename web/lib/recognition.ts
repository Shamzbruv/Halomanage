export type RecognitionSettings = {
  monthly_point_allowance: number;
  max_points_per_recognition: number | null;
  max_recognitions_per_day_per_giver: number | null;
  default_visibility: "public" | "private";
  enabled: boolean;
  require_value: boolean;
  max_points_per_recipient_per_month: number | null;
};
export type RecognitionState = {
  settings: RecognitionSettings;
  employee_id: string;
  timezone: string;
  month_start: string;
  resets_at: string;
  day_resets_at: string;
  given_points: number;
  remaining_points: number;
  given_today: number;
  daily_remaining: number;
  allow_public: boolean;
  points_balance: number | null;
  rewards_enabled: boolean;
  can_give: boolean;
  can_manage: boolean;
  can_moderate: boolean;
};
export type RecognitionItem = {
  id: string;
  message: string;
  points_given: number;
  visibility: "public" | "private";
  status: "active" | "removed";
  created_at: string;
  giver_name: string;
  recipient_name: string;
  value_name: string | null;
  giver_employee_id: string;
  recipient_employee_id: string;
  recognition_value_id: string | null;
  can_make_private: boolean;
};
export type RecognitionFeed = {
  total: number;
  page: number;
  items: RecognitionItem[];
};
export function recognitionPage(value: string | undefined) {
  return Math.max(1, Math.min(100000, Math.trunc(Number(value)) || 1));
}
