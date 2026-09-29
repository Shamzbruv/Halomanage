// The public.employees row as the HR profile reads it (select "*").
export type EmployeeRecord = {
  id: string;
  organization_id: string;
  user_id: string | null;
  employee_number: string;
  external_payroll_id: string | null;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  preferred_name: string | null;
  work_email: string | null;
  work_phone: string | null;
  status: "prehire" | "active" | "leave" | "suspended" | "terminated";
  hire_date: string | null;
  probation_end_date: string | null;
  termination_date: string | null;
  avatar_url: string | null;
};
