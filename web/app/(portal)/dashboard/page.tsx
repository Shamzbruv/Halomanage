import Link from "next/link";
import { redirect } from "next/navigation";
import { ClockButton } from "@/components/ClockButton";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/Icon";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";
import { statusBadgeClass } from "@/lib/ui";
import type { AttendanceSession, LeaveRequest } from "@/lib/supabase/types";

type AdminEmployee = {
  id: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  status: string;
  user_id: string | null;
};

type AttendanceTodayRow = {
  employee_id: string;
  first_name: string;
  last_name: string;
  clock_in_at: string;
  is_late: boolean;
  status: string;
};

type PendingLeaveRow = {
  id: string;
  employee_id: string;
  first_name: string;
  last_name: string;
  leave_type_name: string;
  start_date: string;
  end_date: string;
  total_days: number;
  status: string;
  submitted_at: string;
};

type OnboardingProgressRow = {
  run_id: string;
  employee_id: string;
  status: string;
  total_tasks: number;
  completed_tasks: number;
  overdue_tasks: number;
  percent_complete: number | null;
};

type OffboardingTaskRow = {
  id: string;
  status: string;
  due_date: string | null;
};

type OffboardingRunRow = {
  id: string;
  employee_id: string;
  final_work_date: string | null;
  status: string;
  started_at: string;
  offboarding_tasks: OffboardingTaskRow[] | null;
};

type ExpiringItemRow = {
  employee_id: string | null;
  item_type: "document" | "certification" | "training";
  item_id: string;
  item_name: string;
  expires_on: string;
};

type AdminAction = {
  key: string;
  href: string;
  icon: IconName;
  priority: "urgent" | "high" | "normal";
  rank: number;
  title: string;
  detail: string;
};

const DAY_MS = 86_400_000;

function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateOrdinal(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function daysUntil(value: string, today: string) {
  return Math.round((dateOrdinal(value) - dateOrdinal(today)) / DAY_MS);
}

function formatShortDate(value: string) {
  return new Date(`${value}T12:00:00`).toLocaleDateString("en", { month: "short", day: "numeric" });
}

function formatExpiry(value: string, today: string) {
  const days = daysUntil(value, today);
  if (days < 0) return `Expired ${Math.abs(days)} ${Math.abs(days) === 1 ? "day" : "days"} ago`;
  if (days === 0) return "Expires today";
  if (days === 1) return "Expires tomorrow";
  return `Expires in ${days} days`;
}

function employeeName(employee: AdminEmployee | undefined) {
  if (!employee) return "Employee";
  return `${employee.preferred_name || employee.first_name} ${employee.last_name}`;
}

function initials(firstName: string, lastName: string) {
  return `${firstName?.[0] ?? ""}${lastName?.[0] ?? ""}`.toUpperCase();
}

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

  // Org-wide "what needs an Admin today" feed, combining sources that each
  // already have their own full page (Team, Migration Center, Onboarding,
  // Offboarding, Documents) into one prioritized glance. Every underlying
  // view is security_invoker (supabase/migrations/20260818001600_reporting_views.sql),
  // so this can never surface a row this admin's own RLS wouldn't already
  // allow — the .eq("organization_id", …) filters below are for index
  // usage and clarity, not the security boundary.
  const isAdmin = session.roles.includes("admin");
  let adminActions: AdminAction[] = [];
  if (isAdmin && session.organizationId) {
    const organizationId = session.organizationId;
    const today = dateKey(new Date());
    const expiryCutoff = dateKey(new Date(Date.now() + 60 * DAY_MS));

    const [
      { data: attendanceToday },
      { data: pendingLeaveAdmin },
      { data: onboardingProgress },
      { data: offboardingRuns },
      { data: expiringItems },
      { data: adminEmployees },
    ] = await Promise.all([
      supabase.from("attendance_today_v").select("*").eq("organization_id", organizationId),
      supabase.from("leave_pending_v").select("*").eq("organization_id", organizationId).order("submitted_at", { ascending: true }),
      supabase.from("onboarding_progress_v").select("*").eq("organization_id", organizationId).eq("status", "in_progress").gt("overdue_tasks", 0),
      supabase.from("offboarding_runs").select("id, employee_id, final_work_date, status, started_at, offboarding_tasks(id, status, due_date)").eq("organization_id", organizationId).eq("status", "in_progress"),
      supabase.from("expiring_items_v").select("*").eq("organization_id", organizationId).lte("expires_on", expiryCutoff).order("expires_on", { ascending: true }),
      supabase.from("employees").select("id, first_name, last_name, preferred_name, status, user_id").eq("organization_id", organizationId),
    ]);

    const employeesById = new Map((adminEmployees as AdminEmployee[] | null ?? []).map((employee) => [employee.id, employee]));
    const lateTodayCount = (attendanceToday as AttendanceTodayRow[] | null ?? []).filter((row) => row.is_late).length;
    const actions: AdminAction[] = [];

    if (lateTodayCount > 0) {
      actions.push({
        key: "late-today",
        href: "/team",
        icon: "clock",
        priority: "normal",
        rank: 0,
        title: `${lateTodayCount} late ${lateTodayCount === 1 ? "arrival" : "arrivals"} today`,
        detail: "Review who clocked in after their scheduled start.",
      });
    }

    (pendingLeaveAdmin as PendingLeaveRow[] | null ?? []).forEach((request, index) => {
      actions.push({
        key: `leave-${request.id}`,
        href: "/team",
        icon: "leave",
        priority: "high",
        rank: index,
        title: `Approve ${request.first_name} ${request.last_name}'s leave`,
        detail: `${request.leave_type_name} · ${request.start_date} → ${request.end_date} · ${request.total_days} day(s)`,
      });
    });

    (onboardingProgress as OnboardingProgressRow[] | null ?? []).forEach((run) => {
      actions.push({
        key: `onboarding-${run.run_id}`,
        href: "/admin/onboarding",
        icon: "onboarding",
        priority: "high",
        rank: -run.overdue_tasks,
        title: `${employeeName(employeesById.get(run.employee_id))}'s onboarding has ${run.overdue_tasks} overdue ${run.overdue_tasks === 1 ? "task" : "tasks"}`,
        detail: `${run.completed_tasks} of ${run.total_tasks} tasks complete`,
      });
    });

    (offboardingRuns as OffboardingRunRow[] | null ?? []).forEach((run) => {
      const overdue = (run.offboarding_tasks ?? []).filter((task) => task.status === "pending" && task.due_date && task.due_date < today).length;
      if (overdue === 0) return;
      actions.push({
        key: `offboarding-${run.id}`,
        href: "/admin/offboarding",
        icon: "people",
        priority: "urgent",
        rank: -overdue,
        title: `${employeeName(employeesById.get(run.employee_id))}'s exit has ${overdue} overdue ${overdue === 1 ? "task" : "tasks"}`,
        detail: run.final_work_date ? `Final day ${formatShortDate(run.final_work_date)}` : "Final day not set",
      });
    });

    (expiringItems as ExpiringItemRow[] | null ?? []).forEach((item) => {
      const days = daysUntil(item.expires_on, today);
      const employee = item.employee_id ? employeesById.get(item.employee_id) : undefined;
      actions.push({
        key: `expiring-${item.item_type}-${item.item_id}`,
        href: item.item_type === "document" ? "/admin/documents" : "/admin/employees",
        icon: item.item_type === "document" ? "document" : "spark",
        priority: days <= 7 ? "urgent" : days <= 30 ? "high" : "normal",
        rank: days,
        title: `${item.item_name} ${formatExpiry(item.expires_on, today)}`,
        detail: employee ? employeeName(employee) : "Organization-wide",
      });
    });

    const priorityWeight: Record<AdminAction["priority"], number> = { urgent: 0, high: 1, normal: 2 };
    actions.sort((a, b) => priorityWeight[a.priority] - priorityWeight[b.priority] || a.rank - b.rank);
    adminActions = actions;
  }

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

      {isAdmin && (
        <section className="card admin-attention-panel">
          <div className="panel-heading">
            <div><span className="panel-icon"><Icon name="shield" /></span><div><h3>Needs an Admin today</h3><p>Leave, onboarding, offboarding, attendance, and expiring items across the whole organization.</p></div></div>
            {adminActions.length > 0 && <span className="badge badge-gold">{adminActions.length}</span>}
          </div>
          <div className="action-list">
            {adminActions.length === 0 && <div className="list-empty compact"><Icon name="check" size={17} /> Nothing needs Admin attention right now.</div>}
            {adminActions.slice(0, 8).map((action) => (
              <Link href={action.href} key={action.key}>
                <span className={`metric-icon small ${action.priority === "urgent" ? "coral" : action.priority === "high" ? "sun" : "mint"}`}><Icon name={action.icon} size={16} /></span>
                <div><strong>{action.title}</strong><small>{action.detail}</small></div>
                <Icon name="arrow-right" size={15} />
              </Link>
            ))}
          </div>
          {adminActions.length > 8 && <p className="mt-3 text-xs text-stone-400">+{adminActions.length - 8} more — open Team, Migration Center, Onboarding, or Offboarding for the full list.</p>}
        </section>
      )}

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
