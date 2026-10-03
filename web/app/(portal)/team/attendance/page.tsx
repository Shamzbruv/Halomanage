import Link from "next/link";
import { redirect } from "next/navigation";
import { Icon } from "@/components/Icon";
import { LiveBreakBadge } from "@/components/clock/Clock";
import { CorrectionDecision, OvertimeDecision, ViolationDecision } from "@/components/team/AttendanceDecisions";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import type { AppPermission } from "@/lib/supabase/types";
import { DAY_STATUS_LABELS, EXCEPTION_LABELS, VIOLATION_STATUS, violationLabel } from "@/lib/attendance";
import { addDaysToDate, formatDate, formatDateTime, formatMinutes, formatTime, todayIn } from "@/lib/timezone";

type DayRow = {
  employee_id: string; employee_name: string; employee_number: string | null; department: string | null;
  scheduled_start_at: string | null; scheduled_end_at: string | null;
  session_id: string | null; clock_in_at: string | null; clock_out_at: string | null;
  worked_minutes: number | null; late_minutes: number; overtime_minutes: number; overtime_status: string;
  day_status: string; detail: string | null; needs_review: boolean;
  current_break_type: "lunch" | "break" | null; current_break_started_at: string | null; current_break_allowed_minutes: number | null; current_break_grace_minutes: number | null;
  pending_break_overruns: number;
};
type ExceptionRow = { employee_id: string; employee_name: string; work_date: string; exception_type: string; detail: string | null; session_id: string | null };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const dayLabel = (date: string, options: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" }) => formatDate(`${date}T12:00:00Z`, "UTC", options);

export default async function TeamAttendancePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee || !session.organizationId) redirect("/signup/complete?repair=1");
  const canView = (["attendance.read_team", "attendance.read_org", "attendance.adjust_team", "attendance.adjust_org"] as AppPermission[]).some((p) => sessionCan(session, p));
  if (!canView) redirect("/dashboard");
  const canDecide = sessionCan(session, "attendance.adjust_team") || sessionCan(session, "attendance.adjust_org");

  const params = await searchParams;
  const tz = session.organization?.timezone ?? undefined;
  const today = todayIn(tz);
  const pick = (key: string) => (typeof params[key] === "string" && ISO_DATE.test(params[key] as string) ? (params[key] as string) : null);
  const date = pick("date") ?? today;
  let to = pick("to") ?? today;
  let from = pick("from") ?? addDaysToDate(to, -13);
  if (from > to) [from, to] = [to, from];
  if (addDaysToDate(from, 62) < to) from = addDaysToDate(to, -62);

  const supabase = await createClient();
  const organizationId = session.organizationId;
  const [dayResult, exceptionResult, correctionResult, overtimeResult, violationResult] = await Promise.all([
    supabase.rpc("list_attendance_day", { p_organization_id: organizationId, p_date: date }),
    supabase.rpc("list_attendance_exceptions", { p_organization_id: organizationId, p_from: from, p_to: to }),
    supabase
      .from("attendance_adjustments")
      .select("id, employee_id, session_id, field, original_value, requested_value, reason, requested_at, attendance_sessions(work_date, clock_in_at, clock_out_at)")
      .eq("organization_id", organizationId)
      .eq("status", "pending")
      .neq("employee_id", session.employee.id)
      .order("requested_at", { ascending: true }),
    supabase
      .from("attendance_sessions")
      .select("id, employee_id, work_date, clock_in_at, clock_out_at, worked_minutes, overtime_minutes, scheduled_start_at, scheduled_end_at")
      .eq("organization_id", organizationId)
      .eq("overtime_status", "pending")
      .neq("employee_id", session.employee.id)
      .order("work_date", { ascending: true }),
    supabase
      .from("attendance_violations")
      .select("id, employee_id, kind, work_date, allowed_minutes, actual_minutes, overrun_minutes, status, makeup_due_date, makeup_credited_minutes, decision_note")
      .eq("organization_id", organizationId)
      .in("status", ["pending", "make_up"])
      .neq("employee_id", session.employee.id)
      .order("work_date", { ascending: true }),
  ]);
  const failures = [dayResult, exceptionResult, correctionResult, overtimeResult, violationResult].filter((r) => r.error);
  if (failures.length) console.error("team attendance: a module failed to load", failures.map((r) => r.error));

  const day = (dayResult.data ?? []) as DayRow[];
  const exceptions = (exceptionResult.data ?? []) as ExceptionRow[];
  const corrections = (correctionResult.data ?? []) as any[];
  const overtime = (overtimeResult.data ?? []) as any[];
  const violations = (violationResult.data ?? []) as any[];

  // Names for the queues: everyone the viewer can see is in the day view.
  const nameById = new Map(day.map((row) => [row.employee_id, row.employee_name]));
  for (const row of exceptions) nameById.set(row.employee_id, row.employee_name);
  const nameOf = (id: string) => nameById.get(id) ?? "Team member";
  const count = (...statuses: string[]) => day.filter((row) => statuses.includes(row.day_status)).length;
  const isToday = date === today;

  // Exceptions can run to hundreds of rows (e.g. a team that doesn't clock
  // in yet): filter by type, and show the first 50 unless asked for all.
  const typeFilter = typeof params.type === "string" && params.type in EXCEPTION_LABELS ? params.type : null;
  const showAll = params.all === "1";
  const typeCounts = new Map<string, number>();
  for (const row of exceptions) typeCounts.set(row.exception_type, (typeCounts.get(row.exception_type) ?? 0) + 1);
  const filteredExceptions = typeFilter ? exceptions.filter((row) => row.exception_type === typeFilter) : exceptions;
  const shownExceptions = showAll ? filteredExceptions : filteredExceptions.slice(0, 50);
  const exceptionHref = (type: string | null, all = false) => {
    const query = new URLSearchParams({ date, from, to });
    if (type) query.set("type", type);
    if (all) query.set("all", "1");
    return `/team/attendance?${query.toString()}#exceptions`;
  };

  return (
    <div className="space-y-6">
      <div className="page-intro"><span className="eyebrow">Manager workspace</span><h1>Team attendance</h1><p>Who&apos;s working, who isn&apos;t and why, and the corrections and overtime waiting for you — for the people in your reporting scope. Times are in {tz ?? "your organization's timezone"}.</p></div>
      <p><Link className="table-action" href="/team">← Back to Team hub</Link></p>

      {failures.length > 0 && <div className="alert-error" role="alert">Some attendance information couldn&apos;t be loaded: {failures.map((r) => r.error?.message).join(" · ")}</div>}

      <div className="dashboard-metrics">
        <div className="metric-card"><span className="metric-icon mint"><Icon name="clock" /></span><div><small>{isToday ? "Working now" : "Attended"}</small><strong>{isToday ? count("working", "late") : count("working", "late", "completed", "missing_out")}</strong><em>{dayLabel(date)}</em></div></div>
        <div className="metric-card"><span className="metric-icon coral"><Icon name="clock" /></span><div><small>Late</small><strong>{day.filter((r) => r.late_minutes > 0).length}</strong><em>after the grace period</em></div></div>
        <div className="metric-card"><span className="metric-icon coral"><Icon name="people" /></span><div><small>No clock-in</small><strong>{count("absent")}</strong><em>scheduled, not on leave</em></div></div>
        <div className="metric-card"><span className="metric-icon sun"><Icon name="check" /></span><div><small>Waiting for you</small><strong>{corrections.length + overtime.length + violations.filter((v) => v.status === "pending").length}</strong><em>corrections, overtime &amp; breaks</em></div></div>
      </div>

      <section className="card overflow-x-auto">
        <div className="panel-heading"><div><span className="panel-icon"><Icon name="check" /></span><div><h3>Correction requests</h3><p>Oldest first. Approving applies the corrected time and recalculates the record; the original stays in the audit trail.</p></div></div></div>
        <table className="w-full text-sm">
          <thead><tr className="border-b border-stone-100 text-left"><th className="pb-3">Employee</th><th className="pb-3">Record</th><th className="pb-3">Change</th><th className="pb-3">Reason</th><th className="pb-3 text-right">{canDecide ? "Decision" : ""}</th></tr></thead>
          <tbody className="divide-y divide-stone-100">
            {corrections.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-stone-400">No corrections are waiting.</td></tr>}
            {corrections.map((item) => {
              const record = Array.isArray(item.attendance_sessions) ? item.attendance_sessions[0] : item.attendance_sessions;
              return (
                <tr key={item.id}>
                  <td className="py-3 font-medium text-stone-900"><Link className="hover:underline" href={`/team/${item.employee_id}`}>{nameOf(item.employee_id)}</Link><small className="block text-stone-500">Requested {formatDate(item.requested_at, tz, { month: "short", day: "numeric" })}</small></td>
                  <td className="py-3 text-stone-600">{record ? <>{dayLabel(record.work_date)}<small className="block">{formatTime(record.clock_in_at, tz)} – {record.clock_out_at ? formatTime(record.clock_out_at, tz) : "no clock-out"}</small></> : "—"}</td>
                  <td className="py-3">{item.field === "clock_in_at" ? "Clock-in" : "Clock-out"}: {item.original_value ? formatTime(item.original_value, tz) : "none"} → <strong>{formatDateTime(item.requested_value, tz, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</strong></td>
                  <td className="py-3 max-w-[260px] text-stone-600">{item.reason}</td>
                  <td className="py-3">{canDecide ? <CorrectionDecision adjustmentId={item.id} /> : <span className="text-xs text-stone-500">View only</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="card overflow-x-auto" id="breaks">
        <div className="panel-heading"><div><span className="panel-icon"><Icon name="clock" /></span><div><h3>Lunch &amp; break overruns</h3><p>Lunches and breaks that ran past the allowance. Excuse it, deduct the extra minutes from pay, or have the time made up — worked before or after a shift by the date you choose, credited automatically and not counted as overtime.</p></div></div></div>
        <table className="w-full text-sm">
          <thead><tr className="border-b border-stone-100 text-left"><th className="pb-3">Employee</th><th className="pb-3">Date</th><th className="pb-3">What happened</th><th className="pb-3">Status</th><th className="pb-3 text-right">{canDecide ? "Decision" : ""}</th></tr></thead>
          <tbody className="divide-y divide-stone-100">
            {violations.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-stone-400">No lunch or break overruns are waiting.</td></tr>}
            {violations.map((v) => {
              const overdue = v.status === "make_up" && v.makeup_due_date < today;
              const status = VIOLATION_STATUS[v.status] ?? { label: v.status, badge: "badge-neutral" };
              const latest = v.work_date > today ? v.work_date : today;
              return (
                <tr key={v.id}>
                  <td className="py-3 font-medium text-stone-900"><Link className="hover:underline" href={`/team/${v.employee_id}`}>{nameOf(v.employee_id)}</Link></td>
                  <td className="py-3">{dayLabel(v.work_date)}</td>
                  <td className="py-3">{violationLabel(v)}</td>
                  <td className="py-3"><span className={`badge ${overdue ? "badge-ruby" : status.badge}`}>{overdue ? "Make-up overdue" : status.label}</span>{v.status === "make_up" && <small className="block text-stone-500">{v.makeup_credited_minutes} of {v.overrun_minutes} min made up · due {dayLabel(v.makeup_due_date)}</small>}</td>
                  <td className="py-3">{canDecide ? <ViolationDecision violationId={v.id} defaultDueDate={v.status === "make_up" ? v.makeup_due_date : latest} minDueDate={v.work_date} maxDueDate={addDaysToDate(latest, 31)} /> : <span className="text-xs text-stone-500">View only</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {(overtime.length > 0 || canDecide) && (
        <section className="card overflow-x-auto">
          <div className="panel-heading"><div><span className="panel-icon"><Icon name="performance" /></span><div><h3>Overtime to approve</h3><p>Time worked beyond the scheduled shift, under a policy that requires approval.</p></div></div></div>
          <table className="w-full text-sm">
            <thead><tr className="border-b border-stone-100 text-left"><th className="pb-3">Employee</th><th className="pb-3">Date</th><th className="pb-3">Scheduled</th><th className="pb-3">Worked</th><th className="pb-3">Overtime</th><th className="pb-3 text-right">{canDecide ? "Decision" : ""}</th></tr></thead>
            <tbody className="divide-y divide-stone-100">
              {overtime.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-stone-400">No overtime is waiting for approval.</td></tr>}
              {overtime.map((item) => (
                <tr key={item.id}>
                  <td className="py-3 font-medium text-stone-900">{nameOf(item.employee_id)}</td>
                  <td className="py-3">{dayLabel(item.work_date)}</td>
                  <td className="py-3 text-stone-500">{item.scheduled_start_at ? `${formatTime(item.scheduled_start_at, tz)}–${formatTime(item.scheduled_end_at, tz)}` : "Day off"}</td>
                  <td className="py-3">{formatMinutes(item.worked_minutes)}<small className="block text-stone-500">{formatTime(item.clock_in_at, tz)} – {item.clock_out_at ? formatTime(item.clock_out_at, tz) : "…"}</small></td>
                  <td className="py-3 font-medium">{formatMinutes(item.overtime_minutes)}</td>
                  <td className="py-3">{canDecide ? <OvertimeDecision sessionId={item.id} /> : <span className="text-xs text-stone-500">View only</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card overflow-x-auto">
        <div className="panel-heading"><div><span className="panel-icon"><Icon name="calendar" /></span><div><h3>Day view · {dayLabel(date, { weekday: "long", month: "long", day: "numeric" })}</h3><p>Scheduled shift against what actually happened, aware of approved leave and holidays.</p></div></div></div>
        <form className="attendance-toolbar" method="get">
          <input type="hidden" name="from" value={from} /><input type="hidden" name="to" value={to} />
          <div><label className="label" htmlFor="attendance-date">Date</label><input id="attendance-date" className="input" type="date" name="date" defaultValue={date} max={today} /></div>
          <button className="btn-secondary" type="submit">Show day</button>
          {!isToday && <Link className="table-action" href={`/team/attendance?from=${from}&to=${to}`}>Back to today</Link>}
        </form>
        <table className="w-full text-sm">
          <thead><tr className="border-b border-stone-100 text-left"><th className="pb-3">Employee</th><th className="pb-3">Scheduled</th><th className="pb-3">In</th><th className="pb-3">Out</th><th className="pb-3">Worked</th><th className="pb-3">Status</th></tr></thead>
          <tbody className="divide-y divide-stone-100">
            {day.length === 0 && <tr><td colSpan={6} className="py-8 text-center text-stone-400">No one is in your attendance scope yet.</td></tr>}
            {day.map((row) => {
              const status = DAY_STATUS_LABELS[row.day_status] ?? { label: row.day_status, badge: "badge-neutral" };
              return (
                <tr key={row.employee_id}>
                  <td className="py-3 font-medium text-stone-900"><Link className="hover:underline" href={`/team/${row.employee_id}`}>{row.employee_name}</Link><small className="block text-stone-500">{[row.employee_number, row.department].filter(Boolean).join(" · ")}</small></td>
                  <td className="py-3 text-stone-500">{row.scheduled_start_at && row.scheduled_end_at ? `${formatTime(row.scheduled_start_at, tz)}–${formatTime(row.scheduled_end_at, tz)}` : "—"}</td>
                  <td className="py-3">{row.clock_in_at ? formatTime(row.clock_in_at, tz) : "—"}</td>
                  <td className="py-3">{row.clock_out_at ? formatTime(row.clock_out_at, tz) : row.session_id && row.day_status !== "missing_out" ? "On the clock" : "—"}</td>
                  <td className="py-3">{row.clock_out_at ? formatMinutes(row.worked_minutes) : "—"}{row.overtime_minutes > 0 && <small className="block text-stone-500">+{formatMinutes(row.overtime_minutes)} overtime ({row.overtime_status})</small>}</td>
                  <td className="py-3">
                    {row.current_break_type && row.current_break_started_at
                      ? <LiveBreakBadge type={row.current_break_type} startedAt={row.current_break_started_at} allowedMinutes={row.current_break_allowed_minutes ?? 0} graceMinutes={row.current_break_grace_minutes ?? 0} />
                      : <span className={`badge ${status.badge}`}>{status.label}</span>}
                    {row.pending_break_overruns > 0 && <a className="ml-1 badge badge-ruby" href="#breaks">{row.pending_break_overruns} overrun{row.pending_break_overruns === 1 ? "" : "s"}</a>}
                    {row.detail && <small className="block text-stone-500">{row.detail}</small>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="card overflow-x-auto" id="exceptions">
        <div className="panel-heading"><div><span className="panel-icon"><Icon name="reports" /></span><div><h3>Exceptions</h3><p>Anything outside the expected pattern from {dayLabel(from, { month: "short", day: "numeric" })} to {dayLabel(to, { month: "short", day: "numeric", year: "numeric" })} (up to 62 days). Approved leave and holidays are never counted as absences.</p></div></div></div>
        <form className="attendance-toolbar" method="get">
          <input type="hidden" name="date" value={date} />
          {typeFilter && <input type="hidden" name="type" value={typeFilter} />}
          <div><label className="label" htmlFor="exceptions-from">From</label><input id="exceptions-from" className="input" type="date" name="from" defaultValue={from} max={today} /></div>
          <div><label className="label" htmlFor="exceptions-to">To</label><input id="exceptions-to" className="input" type="date" name="to" defaultValue={to} max={today} /></div>
          <button className="btn-secondary" type="submit">Update period</button>
        </form>
        {exceptions.length > 0 && (
          <div className="filter-chips mb-3">
            <Link className={typeFilter ? "" : "active"} href={exceptionHref(null)}>All <span>{exceptions.length}</span></Link>
            {Object.keys(EXCEPTION_LABELS).filter((type) => typeCounts.has(type)).map((type) => (
              <Link key={type} className={typeFilter === type ? "active" : ""} href={exceptionHref(type)}>{EXCEPTION_LABELS[type]} <span>{typeCounts.get(type)}</span></Link>
            ))}
          </div>
        )}
        <table className="w-full text-sm">
          <thead><tr className="border-b border-stone-100 text-left"><th className="pb-3">Date</th><th className="pb-3">Employee</th><th className="pb-3">Exception</th><th className="pb-3">Detail</th></tr></thead>
          <tbody className="divide-y divide-stone-100">
            {filteredExceptions.length === 0 && <tr><td colSpan={4} className="py-8 text-center text-stone-400">No exceptions in this period.</td></tr>}
            {shownExceptions.map((row, index) => (
              <tr key={`${row.employee_id}-${row.work_date}-${row.exception_type}-${index}`}>
                <td className="py-3">{dayLabel(row.work_date)}</td>
                <td className="py-3 font-medium text-stone-900">{row.employee_name}</td>
                <td className="py-3"><span className={`badge ${["absent", "missing_clock_out", "late"].includes(row.exception_type) ? "badge-ruby" : "badge-gold"}`}>{EXCEPTION_LABELS[row.exception_type] ?? row.exception_type}</span></td>
                <td className="py-3 text-stone-600">{row.detail ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {shownExceptions.length < filteredExceptions.length && (
          <p className="mt-3 text-xs text-stone-500">Showing the latest 50 of {filteredExceptions.length}. <Link className="table-action" href={exceptionHref(typeFilter, true)}>Show all</Link> or narrow the period or type.</p>
        )}
      </section>
    </div>
  );
}
