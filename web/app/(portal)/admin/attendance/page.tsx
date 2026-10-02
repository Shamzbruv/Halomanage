import Link from "next/link";
import { redirect } from "next/navigation";
import { Icon } from "@/components/Icon";
import { AttendancePolicyForm, HolidayManager, ScheduleAssignments, ScheduleManager, type AssignmentRow, type PolicyValues, type ScheduleRow } from "@/components/attendance/AttendanceSetup";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { addDaysToDate, formatDate, todayIn } from "@/lib/timezone";

const dateLabel = (date: string, options: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", year: "numeric" }) => formatDate(`${date}T12:00:00Z`, "UTC", options);

export default async function AttendanceSetupPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.organizationId) redirect("/dashboard");
  if (!sessionCan(session, "attendance.manage_policies")) redirect("/dashboard");

  const supabase = await createClient();
  const organizationId = session.organizationId;
  const tz = session.organization?.timezone ?? undefined;
  const today = todayIn(tz);

  const results = await Promise.all([
    supabase.from("attendance_policies").select("*").eq("organization_id", organizationId).order("is_default", { ascending: false }).order("created_at").limit(1).maybeSingle(),
    supabase.from("work_schedules").select("id, name, description, is_default, is_active, schedule_shifts(day_of_week, start_time, end_time, break_minutes)").eq("organization_id", organizationId).order("is_active", { ascending: false }).order("name"),
    supabase.from("holidays").select("id, name, observed_on, location_id, is_paid").eq("organization_id", organizationId).gte("observed_on", addDaysToDate(today, -365)).order("observed_on", { ascending: false }),
    supabase.from("locations").select("id, name").eq("organization_id", organizationId).order("name"),
    supabase.from("employees").select("id, first_name, last_name, preferred_name, employee_number, status").eq("organization_id", organizationId).in("status", ["prehire", "active", "leave", "suspended"]).order("last_name"),
    supabase.from("schedule_assignments").select("employee_id, schedule_id, start_date, end_date").eq("organization_id", organizationId).or(`end_date.is.null,end_date.gte.${today}`),
    supabase.from("employee_assignments").select("employee_id, org_units(name)").eq("organization_id", organizationId).is("end_date", null),
  ]);
  const failures = results.filter((r) => r.error);
  if (failures.length) console.error("attendance setup: a module failed to load", failures.map((r) => r.error));
  const [policyResult, scheduleResult, holidayResult, locationResult, employeeResult, scheduleAssignmentResult, assignmentResult] = results;

  const policy = policyResult.data as (PolicyValues & Record<string, unknown>) | null;
  const scheduleAssignments = (scheduleAssignmentResult.data ?? []) as { employee_id: string; schedule_id: string; start_date: string; end_date: string | null }[];
  const scheduleRows: ScheduleRow[] = ((scheduleResult.data ?? []) as any[]).map((s) => ({
    id: s.id, name: s.name, description: s.description, is_default: s.is_default, is_active: s.is_active,
    shifts: (s.schedule_shifts ?? []) as ScheduleRow["shifts"],
    assigned: new Set(scheduleAssignments.filter((a) => a.schedule_id === s.id && a.start_date <= today).map((a) => a.employee_id)).size,
  }));
  const scheduleName = new Map(scheduleRows.map((s) => [s.id, s.name]));
  const departmentOf = new Map(((assignmentResult.data ?? []) as any[]).map((a) => [a.employee_id, (Array.isArray(a.org_units) ? a.org_units[0] : a.org_units)?.name ?? null]));

  const assignmentRows: AssignmentRow[] = ((employeeResult.data ?? []) as any[]).map((e) => {
    const mine = scheduleAssignments.filter((a) => a.employee_id === e.id);
    const current = mine.filter((a) => a.start_date <= today).sort((a, b) => b.start_date.localeCompare(a.start_date))[0];
    const upcoming = mine.filter((a) => a.start_date > today).sort((a, b) => a.start_date.localeCompare(b.start_date))[0];
    return {
      employeeId: e.id,
      name: `${e.preferred_name || e.first_name} ${e.last_name}`,
      employeeNumber: e.employee_number,
      department: departmentOf.get(e.id) ?? null,
      current: current ? { name: scheduleName.get(current.schedule_id) ?? "Schedule", since: dateLabel(current.start_date, { month: "short", day: "numeric", year: "numeric" }) } : null,
      upcoming: upcoming ? { name: scheduleName.get(upcoming.schedule_id) ?? "Schedule", starts: dateLabel(upcoming.start_date, { month: "short", day: "numeric", year: "numeric" }) } : null,
    };
  });
  const unassigned = assignmentRows.filter((r) => !r.current && !r.upcoming).length;

  return (
    <div className="space-y-6">
      <div className="page-intro"><span className="eyebrow">Administration</span><h1>Time &amp; attendance setup</h1><p>The rules HaloManage uses to judge attendance: when someone is late, how breaks count, what happens to a forgotten clock-out, which schedule each person follows, and which days are holidays. Times are in your organization&apos;s timezone ({tz ?? "not set"}).</p></div>

      {failures.length > 0 && <div className="alert-error" role="alert">Some setup information couldn&apos;t be loaded: {failures.map((r) => r.error?.message).join(" · ")}</div>}
      {unassigned > 0 && <div className="alert-warning" role="status">{unassigned} {unassigned === 1 ? "person has" : "people have"} no work schedule — their time is recorded, but lateness, absences and overtime can&apos;t be judged. Assign them below.</div>}

      <section className="card">
        <div className="panel-heading"><div><span className="panel-icon"><Icon name="shield" /></span><div><h3>Attendance policy</h3><p>Applies to everyone unless their compensation record names a different time policy.</p></div></div></div>
        {policy
          ? <AttendancePolicyForm initial={{
              id: policy.id, name: policy.name, grace_period_minutes: policy.grace_period_minutes, early_departure_grace_minutes: policy.early_departure_grace_minutes,
              break_deduction: policy.break_deduction, correction_window_days: policy.correction_window_days, missing_clock_out_after_hours: Number(policy.missing_clock_out_after_hours),
              missing_clock_out_action: policy.missing_clock_out_action, overtime_requires_approval: policy.overtime_requires_approval,
            }} />
          : <div className="list-empty">No attendance policy exists yet. Apply the starter workspace from the <Link className="table-action" href="/admin/setup">Setup guide</Link>.</div>}
        <p className="field-help mt-4">Not offered: time rounding (recorded times are never rounded), location or geofence checks, and kiosk or mobile-only clocking — HaloManage records the server&apos;s time for each clock action from a signed-in web session.</p>
      </section>

      <section className="card">
        <div className="panel-heading"><div><span className="panel-icon"><Icon name="calendar" /></span><div><h3>Work schedules</h3><p>Per-day hours, including overnight shifts (an end time earlier than the start ends the next day). Each attendance record keeps the schedule it was made under.</p></div></div></div>
        <ScheduleManager organizationId={organizationId} schedules={scheduleRows} />
      </section>

      <section className="card" id="assignments">
        <div className="panel-heading"><div><span className="panel-icon"><Icon name="people" /></span><div><h3>Who works which schedule</h3><p>Effective-dated: a new schedule starts on the date you choose and the previous one ends the day before.</p></div></div></div>
        {scheduleRows.some((s) => s.is_active)
          ? <ScheduleAssignments rows={assignmentRows} schedules={scheduleRows.filter((s) => s.is_active).map((s) => ({ id: s.id, name: s.name }))} today={today} />
          : <div className="list-empty">Create a schedule first.</div>}
      </section>

      <section className="card overflow-x-auto">
        <div className="panel-heading"><div><span className="panel-icon"><Icon name="leave" /></span><div><h3>Holidays</h3><p>On a holiday no one is counted absent; anyone who works is recorded normally. The past year and all upcoming holidays are shown.</p></div></div></div>
        <HolidayManager
          organizationId={organizationId}
          locations={(locationResult.data ?? []) as { id: string; name: string }[]}
          holidays={((holidayResult.data ?? []) as any[]).map((h) => ({ ...h, dateLabel: dateLabel(h.observed_on) }))}
        />
      </section>
    </div>
  );
}
