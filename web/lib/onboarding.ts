export type OnboardingField = {
  key: string;
  label: string;
  type: "text" | "number" | "date" | "checkbox";
  required?: boolean;
};
export type OnboardingFile = {
  id: string;
  title: string;
  bucket: string;
  path: string;
};
export type OnboardingTask = {
  id: string;
  run_id: string;
  organization_id: string;
  employee_id: string;
  title: string;
  description: string | null;
  step_type: string;
  assignee_type: string;
  assigned_to_user_id: string | null;
  assignee_employee_id: string | null;
  sequence: number;
  due_date: string | null;
  due_date_locked: boolean;
  required: boolean;
  phase: string | null;
  requires_signature: boolean;
  status: string;
  completed_at: string | null;
  completed_by_label?: string | null;
  assignee_label?: string | null;
  signed_at: string | null;
  form_schema: { fields: OnboardingField[] } | null;
  review_document_version_id: string | null;
  review_document: OnboardingFile | null;
  run_status: string;
  template_name: string;
  template_version_number: number;
  subject_name: string;
  can_manage: boolean;
  can_respond: boolean;
  can_skip: boolean;
  can_evidence: boolean;
  response: Record<string, unknown> | null;
  prerequisites: { id: string; title: string; status: string }[];
  files: OnboardingFile[];
  documents: { id: string; title: string }[];
};
export type OnboardingRun = {
  id: string;
  employee_id: string;
  organization_id: string;
  employee_name: string;
  template_name: string;
  template_version_number: number;
  status: string;
  started_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  can_manage: boolean;
  tasks: OnboardingTask[];
};
export function onboardingPage(value: string | undefined) {
  return Math.max(1, Math.min(100000, Math.trunc(Number(value)) || 1));
}
export function onboardingStatus(status: string) {
  return status === "skipped" ? "Waived" : status.replaceAll("_", " ");
}
