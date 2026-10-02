// Shared attendance labels. Plain module (no "use client"), so both Server
// Components and client components can import values from it.

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function arrivalLabel(status: string | null | undefined, lateMinutes?: number | null): string {
  switch (status) {
    case "on_time": return "On time";
    case "within_grace": return "Within grace";
    case "late": return lateMinutes ? `Late · ${lateMinutes} min` : "Late";
    case "unscheduled": return "Unscheduled";
    default: return "—";
  }
}

export function sessionStatusBadge(status: string, needsReview = false): string {
  if (status === "missing_out" || needsReview) return "badge-ruby";
  if (status === "closed" || status === "corrected") return "badge-emerald";
  if (status === "open") return "badge-gold";
  return "badge-neutral";
}

export function sessionStatusLabel(status: string): string {
  switch (status) {
    case "open": return "In progress";
    case "closed": return "Complete";
    case "corrected": return "Corrected";
    case "auto_closed": return "Auto-closed";
    case "missing_out": return "Missing clock-out";
    default: return status.replace(/_/g, " ");
  }
}

// "09:00:00" → "9:00 AM". Schedule times are wall-clock times in the
// organization's timezone already, so no conversion applies.
export function wallTime(value: string): string {
  const [h, m] = String(value).split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${suffix}`;
}

export function shiftHours(start: string, end: string): { label: string; overnight: boolean } {
  const overnight = String(end).slice(0, 5) <= String(start).slice(0, 5);
  return { label: `${wallTime(start)} – ${wallTime(end)}`, overnight };
}

export const DAY_STATUS_LABELS: Record<string, { label: string; badge: string }> = {
  working: { label: "Working", badge: "badge-emerald" },
  late: { label: "Working · late", badge: "badge-gold" },
  completed: { label: "Completed", badge: "badge-emerald" },
  missing_out: { label: "Missing clock-out", badge: "badge-ruby" },
  absent: { label: "No clock-in", badge: "badge-ruby" },
  not_started: { label: "Shift not started", badge: "badge-neutral" },
  on_leave: { label: "On leave", badge: "badge-neutral" },
  holiday: { label: "Holiday", badge: "badge-neutral" },
  day_off: { label: "Day off", badge: "badge-neutral" },
  no_schedule: { label: "No schedule", badge: "badge-neutral" },
};

export const EXCEPTION_LABELS: Record<string, string> = {
  late: "Late arrival",
  absent: "No clock-in",
  missing_clock_out: "Missing clock-out",
  early_departure: "Early departure",
  unscheduled_work: "Unscheduled work",
  overtime_pending: "Overtime to approve",
  worked_during_leave: "Worked during leave",
  correction_pending: "Correction to decide",
};
