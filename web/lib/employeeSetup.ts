// Shapes returned by get_employee_setup_readiness() — see
// supabase/migrations/20260910100000_employee_setup_and_invitation_readiness.sql.
// That function is the single source of truth for "is this employee ready
// to be invited?"; nothing here recomputes readiness, it only decides where
// in the UI each item lives.

export type SetupItem = {
  code: string;
  label: string;
  section: SetupSection;
  required: boolean;
  complete: boolean;
  message: string;
};

export type SetupSection =
  | "identity"
  | "employment"
  | "reporting"
  | "personal"
  | "identifiers"
  | "emergency"
  | "access"
  | "onboarding";

export type AccountState = "not_invited" | "invited" | "active";

export type SetupReadiness = {
  employee_id: string;
  ready: boolean;
  percent: number;
  required_count: number;
  complete_count: number;
  blockers: SetupItem[];
  warnings: SetupItem[];
  items: SetupItem[];
  account: { state: AccountState; invited_at: string | null; last_sign_in_at: string | null };
  access: {
    pending_role: string | null;
    pending_custom_role_id: string | null;
    configured_at: string | null;
    applied_at: string | null;
    onboarding_template_id: string | null;
    onboarding_was_recommended: boolean;
  };
};

// The Prepare & Invite wizard's steps, in order.
export const SETUP_STEPS = [
  { key: "identity", label: "Identity" },
  { key: "personal", label: "Personal & IDs" },
  { key: "employment", label: "Employment" },
  { key: "access", label: "Access" },
  { key: "onboarding", label: "Onboarding" },
  { key: "review", label: "Review & invite" },
] as const;

export type SetupStepKey = (typeof SETUP_STEPS)[number]["key"];

export function isSetupStep(value: string | undefined): value is SetupStepKey {
  return SETUP_STEPS.some((step) => step.key === value);
}

// Checklist groups shown in the setup status card.
export const SETUP_GROUPS: { label: string; sections: SetupSection[]; step: SetupStepKey }[] = [
  { label: "Identity", sections: ["identity"], step: "identity" },
  { label: "Employment", sections: ["employment"], step: "employment" },
  { label: "Reporting line", sections: ["reporting"], step: "employment" },
  { label: "Personal details", sections: ["personal", "identifiers", "emergency"], step: "personal" },
  { label: "Portal access", sections: ["access"], step: "access" },
  { label: "Onboarding plan", sections: ["onboarding"], step: "onboarding" },
];

export function stepForSection(section: SetupSection): SetupStepKey {
  return SETUP_GROUPS.find((group) => group.sections.includes(section))?.step ?? "identity";
}

// Deep link that jumps straight to the field that needs attention; each
// setup form gives its inputs an id matching the readiness item code.
export function setupHref(employeeId: string, item: Pick<SetupItem, "section" | "code">): string {
  return `/admin/employees/${employeeId}/setup?step=${stepForSection(item.section)}#${item.code}`;
}

export function accountLabel(account: SetupReadiness["account"] | null | undefined): string {
  if (!account || account.state === "not_invited") return "Not invited";
  if (account.state === "invited") return "Awaiting acceptance";
  return "Active";
}

export const IDENTIFIER_TYPES: { value: string; label: string }[] = [
  { value: "trn", label: "TRN (Tax Registration Number)" },
  { value: "nis", label: "NIS (National Insurance)" },
  { value: "national_id", label: "National ID" },
  { value: "passport", label: "Passport" },
  { value: "drivers_licence", label: "Driver's licence" },
  { value: "other", label: "Other identifier" },
];

export function identifierTypeLabel(type: string, label?: string | null): string {
  if (type === "other") return label || "Other identifier";
  return IDENTIFIER_TYPES.find((t) => t.value === type)?.label ?? type;
}

export function maskIdentifier(value: string): string {
  return value.length <= 3 ? "•••" : `•••${value.slice(-3)}`;
}

export const EMPLOYMENT_TYPE_LABELS: Record<string, string> = {
  full_time: "Full-time",
  part_time: "Part-time",
  contract: "Contract",
  temporary: "Temporary",
  intern: "Intern",
};

export const ONBOARDING_PHASE_LABELS: Record<string, string> = {
  preboarding: "Preboarding — HR preparation",
  first_day: "First day",
  first_week: "First week",
  first_30_days: "30-day checkpoint",
  probation: "Probation review",
};

export const DUE_ANCHOR_LABELS: Record<string, string> = {
  run_start: "onboarding start",
  hire_date: "hire date",
  invitation_date: "invitation date",
  probation_end_date: "probation end date",
};

export function describeDueOffset(anchor: string, offset: number | null): string {
  if (offset === null || offset === undefined) return "No due date";
  const anchorLabel = DUE_ANCHOR_LABELS[anchor] ?? anchor;
  if (offset === 0) return `On ${anchorLabel}`;
  const days = Math.abs(offset);
  return `${days} day${days === 1 ? "" : "s"} ${offset < 0 ? "before" : "after"} ${anchorLabel}`;
}

// Human-readable names for audit actions on the employee HR timeline.
const HISTORY_LABELS: Record<string, string> = {
  EMPLOYEE_CREATED: "Employee record created",
  EMPLOYEE_NUMBER_ASSIGNED: "Employee number assigned",
  EMPLOYEE_NUMBER_CHANGED: "Employee number changed",
  EMPLOYEE_PERSONAL_INFO_UPDATED: "Personal information updated",
  EMPLOYEE_IDENTIFIER_ADDED: "Government ID added",
  EMPLOYEE_IDENTIFIER_UPDATED: "Government ID updated",
  EMPLOYEE_IDENTIFIER_VERIFIED: "Government ID verified",
  EMPLOYEE_IDENTIFIER_REMOVED: "Government ID removed",
  EMERGENCY_CONTACT_ADDED: "Emergency contact added",
  EMERGENCY_CONTACT_UPDATED: "Emergency contact updated",
  EMERGENCY_CONTACT_REMOVED: "Emergency contact removed",
  EMPLOYEE_ASSIGNMENT_CHANGED: "Assignment changed",
  EMPLOYEE_ASSIGNMENT_CORRECTED: "Assignment corrected",
  EMPLOYEE_ACCESS_PREPARED: "Portal access prepared",
  ONBOARDING_TEMPLATE_ASSIGNED: "Onboarding plan selected",
  EMPLOYEE_INVITED: "Invitation sent",
  EMPLOYEE_EMAIL_CORRECTED: "Invitation email corrected",
  EMPLOYEE_ACTIVATED: "Employee activated",
  EMPLOYEE_TERMINATED: "Employment ended",
  MEMBER_ROLE_CHANGED: "Role changed",
  ONBOARDING_STARTED: "Onboarding started",
  ONBOARDING_TASK_COMPLETED: "Onboarding step completed",
  ONBOARDING_TASK_SKIPPED: "Onboarding step skipped",
  ONBOARDING_COMPLETED: "Onboarding completed",
  ONBOARDING_CANCELLED: "Onboarding cancelled",
  ONBOARDING_EVIDENCE_ATTACHED: "Onboarding evidence attached",
  COMPENSATION_CHANGED: "Compensation changed",
};

export function historyLabel(action: string): string {
  return HISTORY_LABELS[action] ?? action.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
