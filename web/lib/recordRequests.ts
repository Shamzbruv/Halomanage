// Fields an employee can ask HR to correct — must match
// private.correctable_fields() in 20261003100000_my_profile_employee_record.sql.
// "applied" fields are written to the record automatically when HR
// approves; the rest are corrected by HR in the employee's record.
export const CORRECTABLE_FIELDS = [
  { key: "first_name", label: "Legal first name", applied: true },
  { key: "middle_name", label: "Legal middle name", applied: true },
  { key: "last_name", label: "Legal last name", applied: true },
  { key: "date_of_birth", label: "Date of birth", applied: true },
  { key: "employee_number", label: "Employee number", applied: false },
  { key: "work_email", label: "Work email", applied: false },
  { key: "work_phone", label: "Work phone", applied: false },
  { key: "position", label: "Position", applied: false },
  { key: "department", label: "Department", applied: false },
  { key: "location", label: "Work location", applied: false },
  { key: "employment_type", label: "Employment type", applied: false },
  { key: "supervisor", label: "Supervisor", applied: false },
  { key: "manager", label: "Manager", applied: false },
  { key: "hire_date", label: "Hire date", applied: false },
  { key: "probation_end_date", label: "Probation end date", applied: false },
  { key: "government_id", label: "Government ID", applied: false },
  { key: "other", label: "Something else", applied: false },
] as const;

export type CorrectableField = (typeof CORRECTABLE_FIELDS)[number]["key"];

export type RecordRequest = {
  id: string;
  kind: "correction" | "data_access";
  field_key: string | null;
  field_label: string | null;
  current_value: string | null;
  requested_value: string | null;
  reason: string | null;
  status: "pending" | "approved" | "rejected" | "cancelled";
  applied: boolean;
  requested_at: string;
  decided_at: string | null;
  decision_note: string | null;
};

export const REQUEST_STATUS_LABELS: Record<RecordRequest["status"], string> = {
  pending: "Waiting for HR",
  approved: "Approved",
  rejected: "Declined",
  cancelled: "Withdrawn",
};
