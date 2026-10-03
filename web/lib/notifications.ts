// The notification groups HaloManage actually sends today. One friendly
// group can cover several raw notification_type strings (see
// private.create_notification()'s call sites in the migrations for the
// authoritative list). Only groups whose notifications really exist are
// listed — no toggles for things that are never sent.
//
// Whether a group is required comes from the database
// (get_required_notifications(): system-critical notices, HaloManage
// defaults and the organization's own policy), never from this file.
export type NotificationGroup = { key: string; label: string; description: string; types: string[] };

export const NOTIFICATION_GROUPS: NotificationGroup[] = [
  {
    key: "record",
    label: "Your employee record",
    description: "HR responds to a correction or data request, or asks everyone to confirm their details.",
    types: ["record_request.decided", "record_request.submitted", "profile.confirmation_requested"],
  },
  {
    key: "onboarding",
    label: "Onboarding tasks",
    description: "A new onboarding task is assigned to you.",
    types: ["onboarding.task_assigned"],
  },
  {
    key: "leave",
    label: "Leave requests & decisions",
    description: "A team member requests leave you can approve, or your own request is decided.",
    types: ["leave.requested", "leave.approved", "leave.rejected"],
  },
  {
    key: "attendance",
    label: "Attendance: corrections, overtime & breaks",
    description: "Correction requests you can decide, a lunch or break that runs over (yours or a team member's), and decisions on your corrections, overtime and break time.",
    types: ["attendance.correction_requested", "attendance.correction_decided", "attendance.overtime_decided", "attendance.break_overrun", "attendance.break_overrun_decided"],
  },
  {
    key: "documents",
    label: "Document requests",
    description: "A document you requested from HR is ready or declined.",
    types: ["document_request.fulfilled", "document_request.rejected"],
  },
  {
    key: "rewards",
    label: "Rewards & recognition",
    description: "Points awarded to you, a redemption's status, or a coworker recognizing you.",
    types: ["rewards.points_awarded", "rewards.redemption_fulfilled", "rewards.redemption_cancelled", "rewards.redemption_failed", "recognition.received"],
  },
];

export const ALL_NOTIFICATION_TYPES = NOTIFICATION_GROUPS.flatMap((g) => g.types);

export type RequiredState = { required: boolean; system: boolean };

// A group is required if any of its types is; "system" means HaloManage
// requires it and the organization can't change that.
export function groupRequirement(group: NotificationGroup, rows: { notification_type: string; required: boolean; system_required: boolean }[]): RequiredState {
  const relevant = rows.filter((r) => group.types.includes(r.notification_type));
  return {
    required: relevant.some((r) => r.required),
    system: relevant.some((r) => r.system_required),
  };
}

// Events recorded in account_security_events (shown as "Recent security
// activity" — see 20261004110000_account_security_events.sql).
export const SECURITY_ACTIVITY_LABELS: Record<string, string> = {
  signed_in: "Signed in",
  password_changed: "Password changed",
  mfa_added: "Authenticator app added",
  mfa_removed: "Authenticator app removed",
};
