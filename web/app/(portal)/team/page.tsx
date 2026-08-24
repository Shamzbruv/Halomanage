import { redirect } from "next/navigation";
import { Icon } from "@/components/Icon";
import { LeaveDecisionButtons } from "@/components/LeaveDecisionButtons";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";

export default async function TeamPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  const canSeeTeam = session.roles.some((role) => role === "supervisor" || role === "manager" || role === "admin");
  if (!canSeeTeam) redirect("/dashboard");
  const supabase = await createClient();
  const [{ data: pendingLeave }, { data: attendanceToday }] = await Promise.all([
    supabase.from("leave_pending_v").select("*").order("submitted_at", { ascending: true }),
    supabase.from("attendance_today_v").select("*").order("clock_in_at", { ascending: true }),
  ]);
  const lateCount = (attendanceToday ?? []).filter((item: any) => item.is_late).length;

  return (
    <div className="space-y-6">
      <div className="page-intro"><span className="eyebrow">Manager workspace</span><h1>Know what your team needs today.</h1><p>Make timely leave decisions and see who is working without stepping outside your authorized reporting scope.</p></div>
      <div className="dashboard-metrics">
        <div className="metric-card"><span className="metric-icon mint"><Icon name="team" /></span><div><small>Working now</small><strong>{(attendanceToday ?? []).length}</strong><em>visible team members</em></div></div>
        <div className="metric-card"><span className="metric-icon sun"><Icon name="leave" /></span><div><small>Awaiting approval</small><strong>{(pendingLeave ?? []).length}</strong><em>leave requests</em></div></div>
        <div className="metric-card"><span className="metric-icon coral"><Icon name="clock" /></span><div><small>Late arrivals</small><strong>{lateCount}</strong><em>today</em></div></div>
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <section className="card">
          <div className="panel-heading"><div><span className="panel-icon"><Icon name="leave" /></span><div><h3>Leave approvals</h3><p>Oldest requests appear first.</p></div></div></div>
          <div className="team-approval-list">
            {(pendingLeave ?? []).length === 0 && <div className="list-empty compact"><Icon name="check" size={17} /> No requests are waiting.</div>}
            {(pendingLeave ?? []).map((request: any) => (
              <article key={request.id}><span className="user-avatar small">{request.first_name?.[0]}{request.last_name?.[0]}</span><div><strong>{request.first_name} {request.last_name}</strong><p>{request.leave_type_name} · {request.total_days} day(s)</p><small>{request.start_date} → {request.end_date}{request.reason ? ` · “${request.reason}”` : ""}</small></div><LeaveDecisionButtons leaveRequestId={request.id} /></article>
            ))}
          </div>
        </section>
        <section className="card overflow-x-auto">
          <div className="panel-heading"><div><span className="panel-icon"><Icon name="clock" /></span><div><h3>Team attendance</h3><p>Live status for today.</p></div></div></div>
          <table className="w-full text-sm"><thead><tr className="border-b border-stone-100 text-left"><th className="pb-3">Employee</th><th className="pb-3">Clocked in</th><th className="pb-3">Status</th></tr></thead><tbody className="divide-y divide-stone-100">
            {(attendanceToday ?? []).length === 0 && <tr><td colSpan={3} className="py-8 text-center text-stone-400">No one is on the clock right now.</td></tr>}
            {(attendanceToday ?? []).map((item: any) => <tr key={item.employee_id}><td className="py-3 font-medium text-stone-900">{item.first_name} {item.last_name}</td><td className="py-3 text-stone-500">{new Date(item.clock_in_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td><td className="py-3"><span className={`badge ${item.is_late ? "badge-gold" : "badge-emerald"}`}>{item.is_late ? "Late" : "On time"}</span></td></tr>)}
          </tbody></table>
        </section>
      </div>
    </div>
  );
}
