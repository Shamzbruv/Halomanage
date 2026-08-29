import Link from "next/link";
import { redirect } from "next/navigation";
import { Icon } from "@/components/Icon";
import { LeaveDecisionButtons } from "@/components/LeaveDecisionButtons";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { statusBadgeClass } from "@/lib/ui";

function fullName(person: { first_name?: string | null; last_name?: string | null }) {
  return [person.first_name, person.last_name].filter(Boolean).join(" ") || "Team member";
}

function initials(person: { first_name?: string | null; last_name?: string | null }) {
  return `${person.first_name?.[0] ?? ""}${person.last_name?.[0] ?? ""}`.toUpperCase() || "TM";
}

export default async function TeamPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee || !session.organizationId) redirect("/signup/complete?repair=1");

  const canReadTeam = sessionCan(session, "employee.read_team") || sessionCan(session, "employee.read_org");
  if (!canReadTeam) redirect("/dashboard");

  const supabase = await createClient();
  const organizationId = session.organizationId;
  const today = new Date().toISOString().slice(0, 10);
  const results = await Promise.all([
    supabase.from("leave_pending_v").select("*").order("submitted_at", { ascending: true }),
    supabase.from("attendance_today_v").select("*").order("clock_in_at", { ascending: true }),
    supabase
      .from("employees")
      .select("id, employee_number, first_name, last_name, work_email, status")
      .eq("organization_id", organizationId)
      .neq("id", session.employee.id)
      .order("first_name"),
    supabase
      .from("employee_assignments")
      .select("employee_id, supervisor_employee_id, manager_employee_id, employment_type")
      .eq("organization_id", organizationId)
      .is("end_date", null),
    supabase
      .from("schedule_assignments")
      .select("employee_id, schedule_id, start_date")
      .eq("organization_id", organizationId)
      .is("end_date", null),
    supabase.from("work_schedules").select("id, name").eq("organization_id", organizationId),
    supabase
      .from("leave_balance_v")
      .select("employee_id, leave_type_id, leave_type_name, balance")
      .eq("organization_id", organizationId),
    supabase
      .from("leave_requests")
      .select("id, employee_id, leave_type_id, start_date, end_date, total_days, status")
      .eq("organization_id", organizationId)
      .gte("end_date", today)
      .in("status", ["submitted", "pending_supervisor", "pending_manager", "approved"])
      .order("start_date")
      .limit(20),
    supabase.from("leave_types").select("id, name").eq("organization_id", organizationId),
  ]);

  const labels = [
    "leave approvals",
    "today's attendance",
    "team roster",
    "reporting assignments",
    "schedule assignments",
    "work schedules",
    "leave balances",
    "upcoming leave",
    "leave types",
  ];
  const failures = results.flatMap((result, index) =>
    result.error ? [{ module: labels[index], code: result.error.code, message: result.error.message }] : [],
  );
  if (failures.length) console.error("team hub: one or more modules failed to load", failures);

  const [pendingLeaveResult, attendanceResult, peopleResult, assignmentResult, scheduleAssignmentResult, scheduleResult, balanceResult, upcomingResult, leaveTypeResult] = results;
  const pendingLeave = pendingLeaveResult.data ?? [];
  const attendanceToday = attendanceResult.data ?? [];
  const people = peopleResult.data ?? [];
  const assignments = assignmentResult.data ?? [];
  const scheduleAssignments = scheduleAssignmentResult.data ?? [];
  const schedules = scheduleResult.data ?? [];
  const balances = balanceResult.data ?? [];
  const upcomingLeave = upcomingResult.data ?? [];
  const leaveTypes = leaveTypeResult.data ?? [];

  const lateCount = attendanceToday.filter((item: any) => item.is_late).length;
  const assignmentByEmployee = new Map(assignments.map((item: any) => [item.employee_id, item]));
  const scheduleAssignmentByEmployee = new Map(scheduleAssignments.map((item: any) => [item.employee_id, item]));
  const scheduleById = new Map(schedules.map((item: any) => [item.id, item.name]));
  const personById = new Map(people.map((item: any) => [item.id, item]));
  const leaveTypeById = new Map(leaveTypes.map((item: any) => [item.id, item.name]));
  const balancesByEmployee = new Map<string, Array<{ leave_type_id: string; leave_type_name: string; balance: number }>>();
  for (const balance of balances as any[]) {
    const current = balancesByEmployee.get(balance.employee_id) ?? [];
    current.push(balance);
    balancesByEmployee.set(balance.employee_id, current);
  }

  const isOrgReader = sessionCan(session, "employee.read_org");

  return (
    <div className="space-y-6">
      <div className="page-intro">
        <span className="eyebrow">Manager workspace</span>
        <h1>Know what your team needs today.</h1>
        <p>Review your roster, working patterns, leave balances, upcoming absences, and live attendance within your authorized reporting scope.</p>
      </div>

      {failures.length > 0 && (
        <div className="alert-error" role="alert">
          {failures.length} team module{failures.length === 1 ? "" : "s"} could not be loaded. Your other team information remains available; an administrator should verify the latest database migrations and grants.
        </div>
      )}

      <div className="dashboard-metrics">
        <div className="metric-card"><span className="metric-icon mint"><Icon name="team" /></span><div><small>People in scope</small><strong>{people.length}</strong><em>{isOrgReader ? "organization members" : "direct reports"}</em></div></div>
        <div className="metric-card"><span className="metric-icon mint"><Icon name="clock" /></span><div><small>Working now</small><strong>{attendanceToday.length}</strong><em>visible team members</em></div></div>
        <div className="metric-card"><span className="metric-icon sun"><Icon name="leave" /></span><div><small>Awaiting approval</small><strong>{pendingLeave.length}</strong><em>leave requests</em></div></div>
        <div className="metric-card"><span className="metric-icon coral"><Icon name="clock" /></span><div><small>Late arrivals</small><strong>{lateCount}</strong><em>today</em></div></div>
      </div>

      {people.length === 0 && !peopleResult.error && (
        <section className="context-empty card">
          <span><Icon name="team" size={22} /></span>
          <div>
            <strong>No employees are assigned to your reporting scope yet</strong>
            <p>A manager or supervisor role controls permissions; the employee&apos;s current assignment controls who reports to whom. Ask an administrator to set you as their supervisor or manager.</p>
          </div>
          {sessionCan(session, "employee.manage") && <Link className="btn-primary" href="/admin/employees">Assign reporting lines</Link>}
        </section>
      )}

      <section className="card overflow-x-auto">
        <div className="panel-heading">
          <div><span className="panel-icon"><Icon name="people" /></span><div><h3>Team roster &amp; working patterns</h3><p>Role access and reporting assignments are managed separately.</p></div></div>
          {sessionCan(session, "employee.manage") && <Link className="btn-secondary" href="/admin/employees">Manage people</Link>}
        </div>
        <table className="w-full text-sm">
          <thead><tr className="border-b border-stone-100 text-left"><th className="pb-3">Employee</th><th className="pb-3">Relationship</th><th className="pb-3">Schedule</th><th className="pb-3">Leave available</th><th className="pb-3">Status</th></tr></thead>
          <tbody className="divide-y divide-stone-100">
            {people.length === 0 && <tr><td colSpan={5} className="py-8 text-center text-stone-400">No employees are currently visible in this scope.</td></tr>}
            {people.map((person: any) => {
              const assignment: any = assignmentByEmployee.get(person.id);
              const scheduleAssignment: any = scheduleAssignmentByEmployee.get(person.id);
              const employeeBalances = balancesByEmployee.get(person.id) ?? [];
              const relationship = isOrgReader
                ? "Organization"
                : assignment?.supervisor_employee_id === session.employee?.id
                  ? "Direct supervisor"
                  : assignment?.manager_employee_id === session.employee?.id
                    ? "Direct manager"
                    : "In scope";
              return (
                <tr key={person.id}>
                  <td className="py-3"><div className="flex items-center gap-2"><span className="user-avatar small">{initials(person)}</span><span><strong className="block font-medium text-stone-900">{fullName(person)}</strong><small className="text-stone-500">{person.employee_number}{person.work_email ? ` · ${person.work_email}` : ""}</small></span></div></td>
                  <td className="py-3 text-stone-600">{relationship}</td>
                  <td className="py-3 text-stone-600">{scheduleAssignment ? scheduleById.get(scheduleAssignment.schedule_id) ?? "Assigned schedule" : <span className="text-amber-700">Not assigned</span>}</td>
                  <td className="py-3 text-stone-600">{employeeBalances.length ? employeeBalances.slice(0, 2).map((item) => `${item.leave_type_name}: ${Number(item.balance).toLocaleString(undefined, { maximumFractionDigits: 1 })}d`).join(" · ") : <span className="text-amber-700">Not provisioned</span>}</td>
                  <td className="py-3"><span className={`badge ${person.status === "active" ? "badge-emerald" : "badge-neutral"}`}>{String(person.status).replace(/_/g, " ")}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="card">
          <div className="panel-heading"><div><span className="panel-icon"><Icon name="leave" /></span><div><h3>Leave approvals</h3><p>Oldest requests appear first.</p></div></div></div>
          <div className="team-approval-list">
            {pendingLeave.length === 0 && <div className="list-empty compact"><Icon name="check" size={17} /> No requests are waiting.</div>}
            {(pendingLeave as any[]).map((request) => (
              <article key={request.id}><span className="user-avatar small">{request.first_name?.[0]}{request.last_name?.[0]}</span><div><strong>{request.first_name} {request.last_name}</strong><p>{request.leave_type_name} · {request.total_days} day(s)</p><small>{request.start_date} → {request.end_date}{request.reason ? ` · “${request.reason}”` : ""}</small></div><LeaveDecisionButtons leaveRequestId={request.id} /></article>
            ))}
          </div>
        </section>

        <section className="card overflow-x-auto">
          <div className="panel-heading"><div><span className="panel-icon"><Icon name="clock" /></span><div><h3>Team attendance</h3><p>Live status for today.</p></div></div></div>
          <table className="w-full text-sm"><thead><tr className="border-b border-stone-100 text-left"><th className="pb-3">Employee</th><th className="pb-3">Clocked in</th><th className="pb-3">Status</th></tr></thead><tbody className="divide-y divide-stone-100">
            {attendanceToday.length === 0 && <tr><td colSpan={3} className="py-8 text-center text-stone-400">No one is on the clock right now.</td></tr>}
            {(attendanceToday as any[]).map((item) => <tr key={item.employee_id}><td className="py-3 font-medium text-stone-900">{item.first_name} {item.last_name}</td><td className="py-3 text-stone-500">{new Date(item.clock_in_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td><td className="py-3"><span className={`badge ${item.is_late ? "badge-gold" : "badge-emerald"}`}>{item.is_late ? "Late" : "On time"}</span></td></tr>)}
          </tbody></table>
        </section>
      </div>

      <section className="card overflow-x-auto">
        <div className="panel-heading"><div><span className="panel-icon"><Icon name="calendar" /></span><div><h3>Upcoming team leave</h3><p>Approved and in-flight absences from today onward.</p></div></div></div>
        <table className="w-full text-sm"><thead><tr className="border-b border-stone-100 text-left"><th className="pb-3">Employee</th><th className="pb-3">Leave type</th><th className="pb-3">Dates</th><th className="pb-3">Days</th><th className="pb-3">Status</th></tr></thead><tbody className="divide-y divide-stone-100">
          {upcomingLeave.length === 0 && <tr><td colSpan={5} className="py-8 text-center text-stone-400">No upcoming leave is visible.</td></tr>}
          {(upcomingLeave as any[]).map((request) => {
            const person: any = personById.get(request.employee_id);
            return <tr key={request.id}><td className="py-3 font-medium text-stone-900">{person ? fullName(person) : "Team member"}</td><td className="py-3 text-stone-600">{leaveTypeById.get(request.leave_type_id) ?? "Leave"}</td><td className="py-3 text-stone-600">{request.start_date} → {request.end_date}</td><td className="py-3">{request.total_days}</td><td className="py-3"><span className={`badge ${statusBadgeClass(request.status)}`}>{String(request.status).replace(/_/g, " ")}</span></td></tr>;
          })}
        </tbody></table>
      </section>
    </div>
  );
}
