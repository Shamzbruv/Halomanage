// The live clock's state (get_my_clock_state()) and the arithmetic behind
// the timers. Plain module: shared by the top-bar timer and the clock cards.
// Mirrors private.break_unpaid_minutes() so the live "worked" figure matches
// what the record will say once the break ends.

import { formatDate, formatTime } from "@/lib/timezone";

export type BreakType = "lunch" | "break";

export type ClockState = {
  server_now: string;
  timezone: string;
  can_clock: boolean;
  session: { id: string; clock_in_at: string; scheduled_start_at: string | null; scheduled_end_at: string | null; arrival_status: string | null; late_minutes: number | null } | null;
  current_break: { id: string; type: BreakType; started_at: string; allowed_minutes: number; grace_minutes: number; paid: boolean } | null;
  completed_unpaid_minutes: number;
  deduction_mode: "recorded" | "scheduled" | "none";
  breaks_used: { lunch: number; break: number };
  allowances: { lunch_minutes: number; lunches_per_shift: number; short_break_minutes: number; short_breaks_per_shift: number; grace_minutes: number; short_breaks_paid: boolean };
  makeup_owed_minutes: number;
  makeup_due_date: string | null;
  pending_violations: number;
};

export const BREAK_LABEL: Record<BreakType, string> = { lunch: "Lunch", break: "Break" };

// Times as display strings, formatted on the server (Intl output can
// differ between Node and the browser, which breaks hydration).
export type ClockLabels = { clockIn: string | null; shift: string | null; breakStarted: string | null; makeupDue: string | null };
export type ClockView = { state: ClockState; labels: ClockLabels };

export function clockView(state: ClockState | null): ClockView | null {
  if (!state) return null;
  const tz = state.timezone;
  const s = state.session;
  return {
    state,
    labels: {
      clockIn: s ? formatTime(s.clock_in_at, tz) : null,
      shift: s?.scheduled_start_at && s.scheduled_end_at ? `${formatTime(s.scheduled_start_at, tz)} – ${formatTime(s.scheduled_end_at, tz)}` : null,
      breakStarted: state.current_break ? formatTime(state.current_break.started_at, tz) : null,
      makeupDue: state.makeup_due_date ? formatDate(`${state.makeup_due_date}T12:00:00Z`, "UTC", { weekday: "short", month: "short", day: "numeric" }) : null,
    },
  };
}

// Seconds on the current break and how it stands against its allowance.
export function breakStatus(state: ClockState, nowMs: number) {
  const b = state.current_break;
  if (!b) return null;
  const elapsed = Math.max(0, (nowMs - Date.parse(b.started_at)) / 1000);
  const allowed = b.allowed_minutes * 60;
  const remaining = allowed - elapsed;
  const phase: "ok" | "grace" | "over" = remaining > 0 ? "ok" : -remaining <= b.grace_minutes * 60 ? "grace" : "over";
  return { elapsed, allowed, remaining, phase, extra: b.allowed_minutes === 0 };
}

// Worked so far: time on the clock minus unpaid break time.
export function workedSeconds(state: ClockState, nowMs: number): number {
  if (!state.session) return 0;
  const elapsed = Math.max(0, (nowMs - Date.parse(state.session.clock_in_at)) / 1000);
  let unpaid = state.completed_unpaid_minutes * 60;
  const b = state.current_break;
  const status = breakStatus(state, nowMs);
  if (b && status) {
    const unpaidAllowance = state.deduction_mode !== "none" && (b.type === "lunch" || !b.paid);
    if (status.phase === "over") unpaid += (unpaidAllowance ? status.allowed : 0) + (status.elapsed - status.allowed);
    else unpaid += unpaidAllowance ? status.elapsed : 0;
  }
  return Math.max(0, elapsed - unpaid);
}

// 3725 → "1:02:05"; under an hour → "02:05".
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function breakAllowanceLabel(state: ClockState, type: BreakType): { minutes: number; used: number; perShift: number; extra: boolean } {
  const minutes = type === "lunch" ? state.allowances.lunch_minutes : state.allowances.short_break_minutes;
  const perShift = type === "lunch" ? state.allowances.lunches_per_shift : state.allowances.short_breaks_per_shift;
  const used = state.breaks_used[type] ?? 0;
  return { minutes, used, perShift, extra: used >= perShift };
}
