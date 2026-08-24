import { redirect } from "next/navigation";
import { AttendanceCorrectionButton } from "@/components/AttendanceCorrectionButton";
import { ClockButton } from "@/components/ClockButton";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";
import { statusBadgeClass } from "@/lib/ui";
import type { AttendanceSession } from "@/lib/supabase/types";

function duration(start: string, end: string | null) {
  if (!end) return "In progress";
  const minutes = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60_000));
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export default async function TimePage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee) redirect("/signup/complete?repair=1");

  const supabase = await createClient();
  const employeeId = session.employee.id;
  const [{ data: sessions }, { data: scheduleAssignment }, { data: adjustments }] = await Promise.all([
    supabase.from("attendance_sessions").select("*").eq("employee_id", employeeId).order("clock_in_at", { ascending: false }).limit(30),
    supabase.from("schedule_assignments").select("id, schedule_id, start_date").eq("employee_id", employeeId).is("end_date", null).maybeSingle(),
    supabase.from("attendance_adjustments").select("id, session_id, field, requested_value, status, requested_at").eq("employee_id", employeeId).order("requested_at", { ascending: false }).limit(8),
  ]);
  const scheduleId = scheduleAssignment?.schedule_id;
  const [{ data: schedule }, { data: shifts }] = scheduleId ? await Promise.all([
    supabase.from("work_schedules").select("name, description").eq("id", scheduleId).maybeSingle(),
    supabase.from("schedule_shifts").select("day_of_week, start_time, end_time, break_minutes").eq("schedule_id", scheduleId).order("day_of_week"),
  ]) : [{ data: null }, { data: [] }];
  const openSession = (sessions ?? []).find((item) => !item.clock_out_at) ?? null;
  const closedSessions = (sessions ?? []).filter((item) => item.clock_out_at);
  const completedMinutes = closedSessions.reduce((sum, item) => sum + Math.max(0, (new Date(item.clock_out_at!).getTime() - new Date(item.clock_in_at).getTime()) / 60_000), 0);
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  return (
    <div className="space-y-6">
      <div className="page-intro"><span className="eyebrow">Your workday</span><h1>Time you can see and trust.</h1><p>Start or end your shift, check your assigned schedule, review attendance history, and request a correction without overwriting the original record.</p></div>
      <div className="time-overview-grid">
        <section className="card time-clock-card"><div className="panel-heading"><div><span className="panel-icon"><Icon name="clock" /></span><div><h3>Current shift</h3><p>Clock actions use the secure server time.</p></div></div><span className={`badge ${openSession ? "badge-emerald" : "badge-neutral"}`}>{openSession ? "Working" : "Off the clock"}</span></div><div className="time-clock-value"><small>{openSession ? "Started at" : "Ready to start"}</small><strong>{openSession ? new Date(openSession.clock_in_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</strong></div><ClockButton openSession={(openSession as AttendanceSession) ?? null} /></section>
        <section className="card"><div className="panel-heading"><div><span className="panel-icon"><Icon name="calendar" /></span><div><h3>{schedule?.name ?? "Work schedule"}</h3><p>{schedule?.description ?? "Your assigned working pattern."}</p></div></div></div>{(shifts ?? []).length ? <div className="schedule-week">{(shifts ?? []).map((shift) => <div key={shift.day_of_week}><strong>{dayNames[shift.day_of_week]}</strong><span>{String(shift.start_time).slice(0,5)}–{String(shift.end_time).slice(0,5)}</span><small>{shift.break_minutes} min break</small></div>)}</div> : <div className="list-empty">No schedule has been assigned yet.</div>}</section>
      </div>
      <div className="performance-summary">
        <div className="metric-card"><span className="metric-icon mint"><Icon name="clock" /></span><div><small>Recorded sessions</small><strong>{closedSessions.length}</strong><em>last 30 records</em></div></div>
        <div className="metric-card"><span className="metric-icon sun"><Icon name="performance" /></span><div><small>Recorded hours</small><strong>{Math.round(completedMinutes / 60 * 10) / 10}</strong><em>across this history</em></div></div>
      </div>
      <section className="card overflow-x-auto"><div className="panel-heading"><div><span className="panel-icon"><Icon name="reports" /></span><div><h3>Attendance history</h3><p>Your newest records appear first.</p></div></div></div><table className="w-full text-sm"><thead><tr className="border-b border-stone-100 text-left"><th className="pb-3">Date</th><th className="pb-3">Clock in</th><th className="pb-3">Clock out</th><th className="pb-3">Duration</th><th className="pb-3">Status</th><th className="pb-3 text-right">Action</th></tr></thead><tbody className="divide-y divide-stone-100">{(sessions ?? []).length === 0 && <tr><td colSpan={6}><div className="context-empty table-context-empty"><span><Icon name="clock" /></span><div><strong>No attendance records yet</strong><p>Your first completed shift will appear here with its start, end, and duration.</p></div></div></td></tr>}{(sessions ?? []).map((item) => <tr key={item.id}><td className="py-3 font-medium text-stone-900">{new Date(item.clock_in_at).toLocaleDateString()}</td><td className="py-3">{new Date(item.clock_in_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td><td className="py-3">{item.clock_out_at ? new Date(item.clock_out_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}</td><td className="py-3">{duration(item.clock_in_at, item.clock_out_at)}</td><td className="py-3"><span className={`badge ${statusBadgeClass(item.status)}`}>{item.status.replace(/_/g," ")}</span></td><td className="py-3 text-right">{item.clock_out_at && <AttendanceCorrectionButton sessionId={item.id} clockInAt={item.clock_in_at} clockOutAt={item.clock_out_at} />}</td></tr>)}</tbody></table></section>
      {(adjustments ?? []).length > 0 && <section className="card"><div className="panel-heading"><div><span className="panel-icon"><Icon name="check" /></span><div><h3>Correction requests</h3><p>Decisions stay visible alongside the audit trail.</p></div></div></div><div className="correction-list">{(adjustments ?? []).map((item) => <div key={item.id}><div><strong>{item.field === "clock_in_at" ? "Clock-in" : "Clock-out"} correction</strong><small>Requested {new Date(item.requested_at).toLocaleDateString()} · {new Date(item.requested_value).toLocaleString()}</small></div><span className={`badge ${statusBadgeClass(item.status)}`}>{item.status}</span></div>)}</div></section>}
    </div>
  );
}
