// Hand-written, deliberately partial types for the shapes the app actually
// touches today. Once the schema stabilizes, generate the full Database
// type with `supabase gen types typescript` and replace this file — do not
// hand-maintain a full schema mirror.

export type AppRole = "employee" | "supervisor" | "manager" | "admin";

export type Employee = {
  id: string;
  organization_id: string;
  user_id: string | null;
  employee_number: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  work_email: string | null;
  status: "prehire" | "active" | "leave" | "suspended" | "terminated";
  hire_date: string | null;
  avatar_url: string | null;
};

export type RoleAssignment = {
  organization_id: string;
  role: AppRole;
};

export type AttendanceSession = {
  id: string;
  employee_id: string;
  work_date: string;
  clock_in_at: string;
  clock_out_at: string | null;
  status: string;
};

export type LeaveType = {
  id: string;
  organization_id: string;
  name: string;
  code: string;
  is_paid: boolean;
  allow_half_day: boolean;
  minimum_notice_days: number;
};

export type LeaveRequest = {
  id: string;
  organization_id: string;
  employee_id: string;
  leave_type_id: string;
  start_date: string;
  end_date: string;
  half_day: boolean;
  total_days: number;
  reason: string | null;
  status:
    | "submitted"
    | "pending_supervisor"
    | "pending_manager"
    | "approved"
    | "rejected"
    | "cancelled"
    | "withdrawn";
  submitted_at: string;
};

export type LeaveBalance = {
  organization_id: string;
  employee_id: string;
  leave_type_id: string;
  balance: number;
};

export type NotificationRow = {
  id: string;
  title: string;
  body: string | null;
  link_url: string | null;
  is_read: boolean;
  created_at: string;
};

export type PayrollImportBatch = {
  id: string;
  organization_id: string;
  batch_type: "pay_run_results" | "compensation_change";
  pay_period_start: string | null;
  pay_period_end: string | null;
  pay_date: string | null;
  status: string;
  total_rows: number;
  matched_rows: number;
  unmatched_rows: number;
  error_rows: number;
  total_net_amount: number | null;
  currency: string;
  uploaded_at: string;
};
