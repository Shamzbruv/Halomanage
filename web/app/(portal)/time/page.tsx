import { redirect } from "next/navigation";
import { AttendanceCorrectionButton, WithdrawCorrectionButton } from "@/components/AttendanceCorrectionButton";
import { ClockPanel, LiveWorkedMinutes } from "@/components/clock/Clock";
import { clockView, type ClockState } from "@/lib/clock";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";
import { statusBadgeClass } from "@/lib/ui";
import { arrivalLabel, DAY_NAMES, sessionStatusBadge, sessionStatusLabel, shiftHours, VIOLATION_STATUS, violationLabel } from "@/lib/attendance";
import { currentTimeIn, formatDate, formatDateTime, formatMinutes, formatTime, todayIn } from "@/lib/timezone";

type Overview = {
  timezone: string;
  today: string;
  today_shift: { start_at: string; end_at: string; break_minutes: number } | null;
  today_leave: string | null;
  today_holiday: string | null;
  next_shift: { date: string; start_at: string; end_at: string } | null;
  open_session: { id: string; clock_in_at: string; arrival_status: string | null; late_minutes: number | null; scheduled_start_at: string | null; scheduled_end_at: string | null; on_break: boolean; break_minutes: number | null } | null;
  current_schedule: { name: string; since: string } | null;
  upcoming_schedule: { name: string; starts: string } | null;
  today_worked_minutes: number;
  week_worked_minutes: number;
  week_scheduled_minutes: number;
  month_worked_minutes: number;
  pending_corrections: number;
  needs_review: number;
};

export default async function TimePage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee) redirect("/signup/complete?repair=1");

  const supabase = await createClient();
  const employeeId = session.employee.id;
  const tz = session.organization?.timezone ?? undefined;
  const today = todayIn(tz);

  const [{ data: overviewData }, { data: sessions }, { data: adjustments }, { data: currentAssignment }, { data: clockState }, { data: violations }] = await Promise.all([
    supabase.rpc("get_my_attendance_overview"),
    supabase
      .from("attendance_sessions")
      .select("id, work_date, clock_in_at, clock_out_at, status, scheduled_start_at, scheduled_end_at, arrival_status, late_minutes, early_departure_minutes, break_minutes, worked_minutes, overtime_minutes, overtime_status, needs_review, review_reason")
      .eq("employee_id", employeeId)
      .order("clock_in_at", { ascending: false })
      .limit(40),
    supabase
      .from("attendance_adjustments")
      .select("id, session_id, field, original_value, requested_value, reason, status, requested_at, decided_at, decision_note")
      .eq("employee_id", employeeId)
      .order("requested_at", { ascending: false })
      .limit(10),
    supabase
      .from("schedule_assignments")
      .select("schedule_id, start_date")
      .eq("employee_id", employeeId)
      .lte("start_date", today)
      .or(`end_date.is.null,end_date.gte.${today}`)
      .order("start_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase.rpc("get_my_clock_state"),
    supabase
      .from("attendance_violations")
      .select("id, kind, work_date, allowed_minutes, actual_minutes, overrun_minutes, status, makeup_due_date, makeup_credited_minutes, decision_note")
      .eq("employee_id", employeeId)
      .order("work_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(20),
  ]);
  const clock = clockView(clockState as ClockState | null);
  const currentBreak = clock?.state.current_break ?? null;
  const overview = overviewData as Overview | null;
  const scheduleId = currentAssignment?.schedule_id;
  const { data: shifts } = scheduleId
    ? await supabase.from("schedule_shifts").select("day_of_week, start_time, end_time, break_minutes").eq("schedule_id", scheduleId).order("day_of_week")
    : { data: [] };

  const open = overview?.open_session ?? null;
  const pendingBySession = new Set((adjustments ?? []).filter((a) => a.status === "pending").map((a) => `${a.session_id}:${a.field}`));
  const weekScheduled = overview?.week_scheduled_minutes ?? 0;

  return (
    <div className="space-y-6">
      <div className="page-intro"><span className="eyebrow">Your workday</span><h1>Time you can see and trust.</h1><p>Start or end your shift, take breaks, see what you&apos;re scheduled for, and request a correction without overwriting the original record. All times are in your organization&apos;s timezone ({overview?.timezone ?? tz ?? "organization time"}).</p></div>

      {overview?.today_leave && <div className="alert-success" role="status">You&apos;re on approved {overview.today_leave} today — no clock-in is expected.</div>}
      {!overview?.today_leave && overview?.today_holiday && <div className="alert-success" role="status">Today is a holiday: {overview.today_holiday}. Clock in only if you&apos;ve been asked to work.</div>}
      {(overview?.needs_review ?? 0) > 0 && <div className="alert-warning" role="alert">{overview!.needs_review === 1 ? "One of your records needs" : `${overview!.needs_review} of your records need`} attention — a clock-out was missing. Use &ldquo;Add clock-out&rdquo; on the record below so your manager can confirm the real time.</div>}

      <div className="time-overview-grid">
        <section className="card time-clock-card">
          <div className="panel-heading"><div><span className="panel-icon"><Icon name="clock" /></span><div><h3>Current shift</h3><p>The server records the time of every clock action.</p></div></div><span className={`badge ${open ? (currentBreak ? "badge-gold" : "badge-emerald") : "badge-neutral"}`}>{open ? (currentBreak ? (currentBreak.type === "lunch" ? "On lunch" : "On a break") : "Working") : "Off the clock"}</span></div>
          {!open && <div className="time-clock-value"><small>Current time</small><strong>{currentTimeIn(tz)}</strong></div>}
          <dl className="time-shift-facts">
            <div><dt>Today&apos;s shift</dt><dd>{overview?.today_shift ? `${formatTime(overview.today_shift.start_at, tz)} – ${formatTime(overview.today_shift.end_at, tz)} · ${overview.today_shift.break_minutes} min break` : "Not scheduled today"}</dd></div>
            {open && <div><dt>Arrival</dt><dd><span className={`badge ${statusBadgeClass(open.arrival_status ?? "")}`}>{arrivalLabel(open.arrival_status, open.late_minutes)}</span></dd></div>}
            {clock && <div><dt>Allowed</dt><dd>Lunch {clock.state.allowances.lunch_minutes} min{clock.state.allowances.lunches_per_shift !== 1 ? ` ×${clock.state.allowances.lunches_per_shift}` : ""} · {clock.state.allowances.short_breaks_per_shift} break{clock.state.allowances.short_breaks_per_shift === 1 ? "" : "s"} of {clock.state.allowances.short_break_minutes} min</dd></div>}
            {!overview?.today_shift && overview?.next_shift && <div><dt>Next shift</dt><dd>{formatDate(overview.next_shift.start_at, tz, { weekday: "short", month: "short", day: "numeric" })} · {formatTime(overview.next_shift.start_at, tz)}</dd></div>}
          </dl>
          {clock ? <ClockPanel view={clock} /> : <p className="field-help">Your time clock couldn&apos;t be loaded. Refresh the page to try again.</p>}
        </section>

        <section className="card">
          <div className="panel-heading"><div><span className="panel-icon"><Icon name="calendar" /></span><div><h3>{overview?.current_schedule?.name ?? "Work schedule"}</h3><p>{overview?.current_schedule ? `In effect since ${formatDate(`${overview.current_schedule.since}T12:00:00Z`, "UTC", { month: "long", day: "numeric", year: "numeric" })}.` : "Your assigned working pattern."}</p></div></div></div>
          {overview?.upcoming_schedule && <p className="alert-warning mb-3">Changing to <strong>{overview.upcoming_schedule.name}</strong> on {formatDate(`${overview.upcoming_schedule.starts}T12:00:00Z`, "UTC", { weekday: "short", month: "long", day: "numeric" })}.</p>}
          {(shifts ?? []).length
            ? <div className="schedule-week">{(shifts ?? []).map((shift) => { const hours = shiftHours(shift.start_time, shift.end_time); return <div key={shift.day_of_week}><strong>{DAY_NAMES[shift.day_of_week]}</strong><span>{hours.label}</span><small>{shift.break_minutes} min break{hours.overnight ? " · ends next day" : ""}</small></div>; })}</div>
            : <div className="list-empty">No schedule has been assigned yet. Time you record still counts — it just can&apos;t be compared with a shift.</div>}
        </section>
      </div>

      <div className="dashboard-metrics">
        <div className="metric-card"><span className="metric-icon mint"><Icon name="clock" /></span><div><small>Today</small><strong>{clock ? <LiveWorkedMinutes view={clock} baseMinutes={overview?.today_worked_minutes ?? 0} /> : formatMinutes(overview?.today_worked_minutes ?? 0)}</strong><em>worked{open ? " so far" : ""}</em></div></div>
        <div className="metric-card"><span className="metric-icon mint"><Icon name="calendar" /></span><div><small>This week</small><strong>{clock ? <LiveWorkedMinutes view={clock} baseMinutes={overview?.week_worked_minutes ?? 0} /> : formatMinutes(overview?.week_worked_minutes ?? 0)}</strong><em>{weekScheduled ? `of ${formatMinutes(weekScheduled)} scheduled` : "no scheduled hours"}</em></div></div>
        <div className="metric-card"><span className="metric-icon sun"><Icon name="performance" /></span><div><small>This month</small><strong>{clock ? <LiveWorkedMinutes view={clock} baseMinutes={overview?.month_worked_minutes ?? 0} /> : formatMinutes(overview?.month_worked_minutes ?? 0)}</strong><em>worked, after breaks</em></div></div>
        <div className="metric-card"><span className="metric-icon coral"><Icon name="check" /></span><div><small>Corrections</small><strong>{overview?.pending_corrections ?? 0}</strong><em>awaiting a decision</em></div></div>
      </div>

      <section className="card overflow-x-auto">
        <div className="panel-heading"><div><span className="panel-icon"><Icon name="reports" /></span><div><h3>Attendance history</h3><p>Worked time is clock-in to clock-out minus breaks, as your organization&apos;s attendance policy defines them.</p></div></div></div>
        <table className="w-full text-sm">
          <thead><tr className="border-b border-stone-100 text-left"><th className="pb-3">Date</th><th className="pb-3">Scheduled</th><th className="pb-3">In</th><th className="pb-3">Out</th><th className="pb-3">Breaks</th><th className="pb-3">Worked</th><th className="pb-3">Arrival</th><th className="pb-3">Status</th><th className="pb-3 text-right">Action</th></tr></thead>
          <tbody className="divide-y divide-stone-100">
            {(sessions ?? []).length === 0 && <tr><td colSpan={9}><div className="context-empty table-context-empty"><span><Icon name="clock" /></span><div><strong>No attendance records yet</strong><p>Your first shift will appear here with its start, end, breaks and worked time.</p></div></div></td></tr>}
            {(sessions ?? []).map((item) => {
              const inProgress = item.status === "open" && !item.clock_out_at;
              const missingOut = item.status === "missing_out";
              const correctionPending = pendingBySession.has(`${item.id}:clock_in_at`) || pendingBySession.has(`${item.id}:clock_out_at`);
              return (
                <tr key={item.id}>
                  <td className="py-3 font-medium text-stone-900">{formatDate(`${item.work_date}T12:00:00Z`, "UTC", { weekday: "short", month: "short", day: "numeric" })}</td>
                  <td className="py-3 text-stone-500">{item.scheduled_start_at && item.scheduled_end_at ? `${formatTime(item.scheduled_start_at, tz)}–${formatTime(item.scheduled_end_at, tz)}` : "—"}</td>
                  <td className="py-3">{formatTime(item.clock_in_at, tz)}</td>
                  <td className="py-3">{item.clock_out_at ? formatTime(item.clock_out_at, tz) : inProgress ? "In progress" : "Missing"}</td>
                  <td className="py-3">{item.break_minutes ? formatMinutes(item.break_minutes) : "—"}</td>
                  <td className="py-3">{item.clock_out_at ? formatMinutes(item.worked_minutes) : "—"}{(item.overtime_minutes ?? 0) > 0 && <small className="block text-stone-500">+{formatMinutes(item.overtime_minutes)} overtime{item.overtime_status === "pending" ? " (awaiting approval)" : item.overtime_status === "rejected" ? " (not approved)" : ""}</small>}</td>
                  <td className="py-3"><span className={`badge ${statusBadgeClass(item.arrival_status ?? "")}`}>{arrivalLabel(item.arrival_status, item.late_minutes)}</span>{(item.early_departure_minutes ?? 0) > 0 && <small className="block text-stone-500">Left {item.early_departure_minutes} min early</small>}</td>
                  <td className="py-3"><span className={`badge ${sessionStatusBadge(item.status, item.needs_review)}`}>{sessionStatusLabel(item.status)}</span></td>
                  <td className="py-3 text-right">
                    {correctionPending
                      ? <span className="text-xs text-stone-500">Correction pending</span>
                      : !inProgress && <AttendanceCorrectionButton sessionId={item.id} clockInAt={item.clock_in_at} clockOutAt={missingOut ? null : item.clock_out_at} timezone={tz} label={missingOut ? "Add clock-out" : "Request correction"} />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="card">
        <div className="panel-heading"><div><span className="panel-icon"><Icon name="check" /></span><div><h3>Correction requests</h3><p>Your manager decides each request; the original time stays in the audit trail either way.</p></div></div></div>
        {(adjustments ?? []).length === 0
          ? <div className="list-empty">You haven&apos;t requested any corrections.</div>
          : <div className="correction-list">{(adjustments ?? []).map((item) => (
              <div key={item.id}>
                <div>
                  <strong>{item.field === "clock_in_at" ? "Clock-in" : "Clock-out"} → {formatDateTime(item.requested_value, tz, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</strong>
                  <small>Requested {formatDate(item.requested_at, tz)}{item.original_value ? ` · was ${formatDateTime(item.original_value, tz, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : " · no clock-out recorded"} · “{item.reason}”</small>
                  {item.decision_note && <small>Reviewer: “{item.decision_note}”</small>}
                </div>
                <span className="flex items-center gap-2"><span className={`badge ${statusBadgeClass(item.status)}`}>{item.status === "rejected" ? "declined" : item.status}</span>{item.status === "pending" && <WithdrawCorrectionButton adjustmentId={item.id} />}</span>
              </div>
            ))}</div>}
      </section>

      <section className="card overflow-x-auto">
        <div className="panel-heading"><div><span className="panel-icon"><Icon name="clock" /></span><div><h3>Lunch &amp; break record</h3><p>Lunches and breaks that ran past what your organization allows, and what your manager decided.</p></div></div></div>
        {(violations ?? []).length === 0
          ? <div className="list-empty">Nothing here — every lunch and break has been within its allowance.</div>
          : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-stone-100 text-left"><th className="pb-3">Date</th><th className="pb-3">What happened</th><th className="pb-3">Outcome</th><th className="pb-3">Details</th></tr></thead>
              <tbody className="divide-y divide-stone-100">
                {(violations ?? []).map((v) => {
                  const status = VIOLATION_STATUS[v.status] ?? { label: v.status, badge: "badge-neutral" };
                  const owed = v.overrun_minutes - v.makeup_credited_minutes;
                  const overdue = v.status === "make_up" && v.makeup_due_date && v.makeup_due_date < today;
                  return (
                    <tr key={v.id}>
                      <td className="py-3 font-medium text-stone-900">{formatDate(`${v.work_date}T12:00:00Z`, "UTC", { weekday: "short", month: "short", day: "numeric" })}</td>
                      <td className="py-3">{violationLabel(v)}</td>
                      <td className="py-3"><span className={`badge ${overdue ? "badge-ruby" : status.badge}`}>{overdue ? "Make-up overdue" : status.label}</span></td>
                      <td className="py-3 text-stone-600">
                        {v.status === "pending" && "Your manager will excuse it, deduct the time from your pay, or ask you to make it up."}
                        {v.status === "excused" && "No further action."}
                        {v.status === "deduct_pay" && `${v.overrun_minutes} min unpaid.`}
                        {v.status === "make_up" && `${v.makeup_credited_minutes} of ${v.overrun_minutes} min made up — work ${owed} more min before or after a shift by ${v.makeup_due_date ? formatDate(`${v.makeup_due_date}T12:00:00Z`, "UTC", { weekday: "short", month: "short", day: "numeric" }) : "the due date"}.`}
                        {v.status === "made_up" && `All ${v.overrun_minutes} min made up.`}
                        {v.decision_note && <small className="block text-stone-500">Manager&apos;s note: “{v.decision_note}”</small>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
      </section>

      <p className="field-help">Attendance records track time and attendance. They don&apos;t change your pay automatically — pay comes from your organization&apos;s payroll provider (see My pay).</p>
    </div>
  );
}
