export type PerformanceQuestion = {
  id: string;
  prompt: string;
  question_type: string;
  options: unknown;
  weight: number;
  required: boolean;
  sequence: number;
};
export type PerformanceSection = {
  id: string;
  title: string;
  sequence: number;
  questions: PerformanceQuestion[];
};
export type PerformanceReviewer = {
  id: string;
  instance_id: string;
  role: string;
  reviewer_user_id: string | null;
  reviewer_name: string | null;
  sequence: number;
  status: string;
  due_date: string | null;
  draft_version: number;
  submitted_at: string | null;
  resolution_reason: string | null;
  is_mine: boolean;
  can_edit: boolean;
  eligible: boolean;
};
export type PerformanceResponse = {
  id: string;
  reviewer_id: string;
  question_id: string;
  response_json: unknown;
  response_text: string | null;
  response_numeric: number | null;
};
export type PerformanceGoal = {
  id: string;
  title: string;
  measure: string;
  target_date: string;
  support: string | null;
  status: string;
  progress: number;
  version: number;
  created_by: string;
  events: {
    id: string;
    kind: string;
    note: string;
    progress: number;
    actor_name: string;
    created_at: string;
    prior_values: {
      title: string;
      measure: string;
      target_date: string;
      support: string | null;
    } | null;
  }[];
};
export type PerformanceCheckpoint = {
  id: string;
  employee_id: string;
  employee_name: string;
  organization_id: string;
  cycle_name: string;
  label: string;
  status: string;
  review_period_start: string | null;
  review_period_end: string | null;
  opening_date: string | null;
  acknowledgement_due: string | null;
  released_at: string | null;
  acknowledged_at: string | null;
  cancel_reason: string | null;
  query_status: string;
  is_subject: boolean;
  can_admin: boolean;
  can_lead: boolean;
  current_stage_id: string | null;
  form_snapshot: {
    name: string;
    rating_scale: { value: number; label: string }[];
    sections: PerformanceSection[];
  };
  reviewers: PerformanceReviewer[];
  responses: PerformanceResponse[];
  signoffs: {
    id: string;
    disposition: string;
    note: string | null;
    signed_at: string;
  }[];
  messages: {
    id: string;
    kind: string;
    body: string;
    actor_name: string;
    created_at: string;
  }[];
  goals: PerformanceGoal[];
  previous: {
    id: string;
    label: string;
    review_period_start: string | null;
    review_period_end: string | null;
  } | null;
};
export type PerformanceCycle = {
  id: string;
  template_id: string;
  name: string;
  status: string;
  start_date: string;
  review_period_start: string | null;
  review_period_end: string | null;
  self_review_due: string | null;
  supervisor_review_due: string | null;
  manager_review_due: string | null;
  acknowledgement_due: string | null;
  employee_filter: Record<string, string[]>;
  revision: number;
  total_instances?: number;
  completed_instances?: number;
  cancelled_instances?: number;
  open_queries?: number;
  blocked_reviewers?: number;
};
export function performancePage(value: string | undefined) {
  return Math.max(1, Math.min(100000, Math.trunc(Number(value)) || 1));
}
export function performanceStatus(value: string) {
  return value === "complete" ? "Complete" : value.replaceAll("_", " ");
}
export function performanceAnswer(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") {
    const g = value as Record<string, unknown>;
    return `${g.title ?? ""}\nSuccess: ${g.measure ?? ""}\nTarget: ${g.target_date ?? ""}${g.support ? `\nSupport: ${g.support}` : ""}`;
  }
  return String(value);
}
