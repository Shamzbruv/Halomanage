import type { AppPermission } from "@/lib/supabase/types";

// The full permission vocabulary, grouped by domain for the Roles &
// Permissions admin UI (see 20260831100000_custom_organization_roles.sql).
// Kept as a flat, hand-maintained list next to AppPermission itself — same
// "no full schema mirror" reasoning as lib/supabase/types.ts. Add a new
// permission here in the same change that adds it to the app_permission
// enum and the AppPermission union, or it simply won't show up as an
// option to grant.
export const PERMISSION_GROUPS: { domain: string; label: string; permissions: AppPermission[] }[] = [
  { domain: "organization", label: "Organization", permissions: ["organization.manage"] },
  {
    domain: "employee",
    label: "Employees",
    permissions: ["employee.read_self", "employee.read_team", "employee.read_org", "employee.update_self", "employee.manage"],
  },
  {
    domain: "attendance",
    label: "Attendance",
    permissions: ["attendance.clock_self", "attendance.read_team", "attendance.read_org", "attendance.adjust_team", "attendance.manage_policies"],
  },
  {
    domain: "leave",
    label: "Leave",
    permissions: ["leave.request_self", "leave.approve_direct_reports", "leave.approve_unit", "leave.manage_policies"],
  },
  {
    domain: "onboarding",
    label: "Onboarding",
    permissions: ["onboarding.complete_self", "onboarding.manage_team", "onboarding.manage_templates"],
  },
  {
    domain: "appraisal",
    label: "Performance",
    permissions: ["appraisal.complete_self", "appraisal.review_direct_reports", "appraisal.manage_cycles"],
  },
  {
    domain: "documents",
    label: "Documents",
    permissions: ["documents.read_self", "documents.manage_team", "documents.manage_org"],
  },
  {
    domain: "payroll",
    label: "Payroll",
    permissions: ["payroll.read_self", "payroll.import", "payroll.read_org", "payroll.export"],
  },
  {
    domain: "compensation",
    label: "Compensation",
    permissions: [
      "compensation.read_self",
      "compensation.read_team",
      "compensation.read_org",
      "compensation.manage",
      "compensation.approve",
      "compensation.manage_structure",
    ],
  },
  { domain: "pay_calendar", label: "Pay calendars", permissions: ["pay_calendar.read", "pay_calendar.manage"] },
  {
    domain: "rewards",
    label: "Rewards",
    permissions: ["rewards.read_self", "rewards.redeem_self", "rewards.award_points", "rewards.manage_catalog", "rewards.fulfill"],
  },
  { domain: "recognition", label: "Recognition", permissions: ["recognition.give"] },
  { domain: "assets", label: "Assets", permissions: ["assets.manage"] },
  { domain: "training", label: "Training", permissions: ["training.manage"] },
  { domain: "reports", label: "Reports", permissions: ["reports.team", "reports.org"] },
  { domain: "roles", label: "Roles & access", permissions: ["roles.manage"] },
  { domain: "audit", label: "Audit", permissions: ["audit.read"] },
];

export function permissionLabel(permission: AppPermission): string {
  const suffix = permission.split(".").slice(1).join(".");
  return suffix.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
