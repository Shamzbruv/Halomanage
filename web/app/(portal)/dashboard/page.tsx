import Link from "next/link";
import { redirect } from "next/navigation";
import { ClockButton } from "@/components/ClockButton";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";
import { statusBadgeClass } from "@/lib/ui";
import type { AttendanceSession, LeaveRequest } from "@/lib/supabase/types";

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export default async function DashboardPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");

  if (!session.employee) redirect("/signup/complete?repair=1");

  const supabase = await createClient();
  const employeeId = session.employee.id;
  const [
    { data: openSession },
    { data: balances },
    { data: leaveRequests },
    { data: notifications },
    { data: onboardingTasks },
    { data: reviews },
    { data: assignment },
  ] = await Promise.all([
    supabase.from("attendance_sessions").select("*").eq("employee_id", employeeId).is("clock_out_at", null).maybeSingle(),
    supabase.from("leave_balance_v").select("balance, leave_type_id, leave_type_name").eq("employee_id", employeeId),
    supabase.from("leave_requests").select("*, leave_types(name)").eq("employee_id", employeeId).order("submitted_at", { ascending: false }).limit(4),
    supabase.from("notifications").select("id, title, body, link_url, is_read, created_at").eq("recipient_user_id", session.userId).order("created_at", { ascending: false }).limit(5),
    supabase.from("onboarding_tasks").select("id, title, due_date, status").neq("status", "completed").order("due_date", { ascending: true }).limit(4),
    supabase.from("appraisal_reviewers").select("id, role, appraisal_instance_id").eq("reviewer_user_id", session.userId).eq("status", "pending").limit(4),
    supabase.from("employee_assignments").select("positions(title), org_units(name)").eq("employee_id", employeeId).is("end_date", null).maybeSingle(),
  ]);

  const firstName = session.employee.preferred_name || session.employee.first_name;
  const unreadCount = (notifications ?? []).filter((item) => !item.is_read).length;
  const openTaskCount = (onboardingTasks ?? []).length + (reviews ?? []).length;
  const totalLeave = (balances ?? []).reduce((sum, item) => sum + Number(item.balance || 0), 0);
  const assignmentData = assignment as any;
  const canManage = session.roles.some((role) => role === "supervisor" || role === "manager" || role === "admin");

  return (
    <div className="dashboard-space">
      <section className="dashboard-welcome">
        <div>
          <span className="dashboard-date">{new Intl.DateTimeFormat("en", { weekday: "long", month: "long", day: "numeric" }).format(new Date())}</span>
          <h2>{greeting()}, {firstName}.</h2>
          <p>{assignmentData?.positions?.title || "Your workspace"}{assignmentData?.org_units?.name ? ` · ${assignmentData.org_units.name}` : ""}</p>
        </div>
        <div className="dashboard-welcome-action">
          <span className={openSession ? "status-light online" : "status-light"} />
          <div><small>{openSession ? "You’re working" : "You’re off the clock"}</small><strong>{openSession ? `Since ${new Date(openSession.clock_in_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Ready when you are"}</strong></div>
        </div>
      </section>

      {session.roles.includes("admin") && session.organization && (
        <section className="workspace-launch-strip">
          <span className="metric-icon sun"><Icon name="spark" /></span>
          <div><small>Organization launch centre</small><strong>Finish setting up {session.organization.name}</strong><p>Review your business structure, add employees, prepare workflows, and share your team&apos;s sign-in link.</p></div>
          <div className="workspace-launch-actions"><Link className="btn-primary" href="/admin/setup">Open setup guide</Link><Link className="btn-secondary" href={`/portal/${session.organization.slug}`} target="_blank">Preview employee portal</Link></div>
        </section>
      )}

      <section className="dashboard-metrics" aria-label="Workspace summary">
        <div className="metric-card"><span className="metric-icon mint"><Icon name="leave" /></span><div><small>Available leave</small><strong>{totalLeave.toLocaleString(undefined, { maximumFractionDigits: 1 })}</strong><em>days across all policies</em></div></div>
        <div className="metric-card"><span className="metric-icon sun"><Icon name="onboarding" /></span><div><small>Open actions</small><strong>{openTaskCount}</strong><em>{openTaskCount === 1 ? "item needs" : "items need"} your attention</em></div></div>
        <div className="metric-card"><span className="metric-icon coral"><Icon name="document" /></span><div><small>Unread updates</small><strong>{unreadCount}</strong><em>{unreadCount ? "new in your inbox" : "you’re all caught up"}</em></div></div>
      </section>

      <section className="dashboard-grid">
        <div className="dashboard-column wide">
          <div className="card dashboard-attendance">
            <div className="panel-heading"><div><span className="panel-icon"><Icon name="clock" /></span><div><h3>Today&apos;s attendance</h3><p>Your time is recorded using a trusted server timestamp.</p></div></div><span className={`badge ${openSession ? "badge-emerald" : "badge-neutral"}`}>{openSession ? "Clocked in" : "Not clocked in"}</span></div>
            <div className="attendance-action"><div><small>{openSession ? "Session started" : "Current local time"}</small><strong>{openSession ? new Date(openSession.clock_in_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</strong></div><ClockButton openSession={(openSession as AttendanceSession) ?? null} /></div>
          </div>

          <div className="card">
            <div className="panel-heading"><div><span className="panel-icon"><Icon name="leave" /></span><div><h3>Recent leave</h3><p>Your latest requests and decisions.</p></div></div><Link href="/leave" className="panel-link">View all <Icon name="arrow-right" size={15} /></Link></div>
            <div className="dashboard-list">
              {(leaveRequests ?? []).length === 0 && <div className="list-empty">No leave requests yet. <Link href="/leave">Plan some time away</Link></div>}
              {(leaveRequests as (LeaveRequest & { leave_types: { name: string } })[] | null)?.map((request) => (
                <div className="dashboard-list-row" key={request.id}><span className="list-date"><strong>{new Date(request.start_date).toLocaleDateString("en", { day: "2-digit" })}</strong><small>{new Date(request.start_date).toLocaleDateString("en", { month: "short" })}</small></span><div><strong>{request.leave_types?.name}</strong><small>{request.start_date} → {request.end_date} · {request.total_days} day(s)</small></div><span className={`badge ${statusBadgeClass(request.status)}`}>{request.status.replace(/_/g, " ")}</span></div>
              ))}
            </div>
          </div>
        </div>

        <div className="dashboard-column">
          <div className="card">
            <div className="panel-heading"><div><span className="panel-icon"><Icon name="spark" /></span><div><h3>Next actions</h3><p>Keep your work moving.</p></div></div></div>
            <div className="action-list">
              {(onboardingTasks ?? []).map((task) => <Link href="/onboarding" key={task.id}><span className="metric-icon sun small"><Icon name="onboarding" size={16} /></span><div><strong>{task.title}</strong><small>{task.due_date ? `Due ${task.due_date}` : "Onboarding task"}</small></div><Icon name="arrow-right" size={15} /></Link>)}
              {(reviews ?? []).map((review) => <Link href={`/appraisals/${review.appraisal_instance_id}`} key={review.id}><span className="metric-icon mint small"><Icon name="performance" size={16} /></span><div><strong>Complete your {review.role} review</strong><small>Performance checkpoint</small></div><Icon name="arrow-right" size={15} /></Link>)}
              {openTaskCount === 0 && <div className="list-empty compact"><Icon name="check" size={17} /> You&apos;re all caught up.</div>}
            </div>
          </div>

          <div className="card">
            <div className="panel-heading"><div><span className="panel-icon"><Icon name="spark" /></span><div><h3>Updates</h3><p>Recent activity for you.</p></div></div></div>
            <div className="notification-list">
              {(notifications ?? []).length === 0 && <div className="list-empty compact">No new updates.</div>}
              {(notifications ?? []).map((item) => <div key={item.id} className={item.is_read ? "read" : ""}><span /><div><strong>{item.title}</strong>{item.body && <small>{item.body}</small>}<time>{new Date(item.created_at).toLocaleDateString("en", { month: "short", day: "numeric" })}</time></div></div>)}
            </div>
          </div>

          {canManage && <Link href="/team" className="team-callout"><span><Icon name="team" /></span><div><small>Manager workspace</small><strong>Open your team hub</strong><p>Approvals, attendance, and direct reports in one place.</p></div><Icon name="arrow-right" /></Link>}
        </div>
      </section>
    </div>
  );
}
