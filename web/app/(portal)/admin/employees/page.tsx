import Link from "next/link";
import { redirect } from "next/navigation";
import { DeleteEmployeeButton } from "@/components/DeleteEmployeeButton";
import { EditEmployeeEmailButton } from "@/components/EditEmployeeEmailButton";
import { Icon } from "@/components/Icon";
import { InviteButton } from "@/components/InviteButton";
import { NewEmployeeForm } from "@/components/NewEmployeeForm";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { statusBadgeClass } from "@/lib/ui";
import { todayIn } from "@/lib/timezone";

type Summary = {
  employee_id: string;
  ready: boolean;
  percent: number;
  blocker_count: number;
  account_state: "not_invited" | "invited" | "active";
  onboarding_status: string | null;
  onboarding_completed: number;
  onboarding_total: number;
  // Required personal items (organization settings) missing right now —
  // checked after activation too, not only before invitation.
  profile_missing: string[];
  profile_last_confirmed_at: string | null;
};

const FILTERS = [
  { key: "all", label: "All" },
  { key: "prehire", label: "Pre-hires" },
  { key: "incomplete", label: "Setup incomplete" },
  { key: "ready", label: "Ready to invite" },
  { key: "pending", label: "Invitation pending" },
  { key: "active", label: "Active" },
  { key: "onboarding", label: "Onboarding" },
  { key: "profile", label: "Profile incomplete" },
  { key: "leave", label: "On leave" },
  { key: "terminated", label: "Terminated" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

type Row = { id: string; status: string; user_id: string | null };

function matches(filter: FilterKey, employee: Row, summary: Summary | undefined) {
  switch (filter) {
    case "prehire": return employee.status === "prehire";
    case "incomplete": return !employee.user_id && employee.status !== "terminated" && !summary?.ready;
    case "ready": return !employee.user_id && employee.status !== "terminated" && !!summary?.ready;
    case "pending": return summary?.account_state === "invited";
    case "active": return employee.status === "active";
    case "onboarding": return summary?.onboarding_status === "in_progress";
    case "profile": return !!employee.user_id && employee.status !== "terminated" && (summary?.profile_missing?.length ?? 0) > 0;
    case "leave": return employee.status === "leave";
    case "terminated": return employee.status === "terminated";
    default: return true;
  }
}

export default async function EmployeesAdminPage({ searchParams }: { searchParams: Promise<{ filter?: string; q?: string }> }) {
  const { filter: requestedFilter, q } = await searchParams;
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!sessionCan(session, "employee.manage")) redirect("/dashboard");
  if (!session.organizationId || !session.organization) redirect("/dashboard");
  const portalSlug = session.organization.slug;
  const filter: FilterKey = (FILTERS.find((f) => f.key === requestedFilter)?.key ?? "all") as FilterKey;
  const supabase = await createClient();
  const [{ data: employees }, { data: summaries }, { data: assignments }] = await Promise.all([
    supabase.from("employees").select("id, employee_number, first_name, last_name, preferred_name, work_email, status, user_id, avatar_url").eq("organization_id", session.organizationId).order("last_name"),
    supabase.rpc("list_employee_setup_summary", { p_organization_id: session.organizationId }),
    supabase.from("employee_assignments").select("employee_id, org_units(name), positions(title)").eq("organization_id", session.organizationId).is("end_date", null),
  ]);
  const { count: pendingRequests } = await supabase
    .from("employee_record_requests")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", session.organizationId)
    .eq("status", "pending");
  // Profile confirmation within the last 12 months, among people with an account.
  const yearAgo = new Date(new Date(todayIn(session.organization.timezone)).getTime() - 365 * 86400000).toISOString();
  const withAccounts = (employees ?? []).filter((e) => e.user_id && e.status !== "terminated");
  const confirmedRecently = withAccounts.filter((e) => {
    const confirmed = summaryById.get(e.id)?.profile_last_confirmed_at;
    return !!confirmed && confirmed >= yearAgo;
  }).length;
  const summaryById = new Map(((summaries ?? []) as Summary[]).map((s) => [s.employee_id, s]));
  const assignmentById = new Map((assignments ?? []).map((a: any) => [a.employee_id, a]));
  const all = employees ?? [];
  const counts = Object.fromEntries(FILTERS.map((f) => [f.key, all.filter((e) => matches(f.key, e, summaryById.get(e.id))).length])) as Record<FilterKey, number>;
  const needle = (q ?? "").trim().toLowerCase();
  const visible = all
    .filter((e) => matches(filter, e, summaryById.get(e.id)))
    .filter((e) => !needle || `${e.first_name} ${e.last_name} ${e.preferred_name ?? ""} ${e.employee_number} ${e.work_email ?? ""}`.toLowerCase().includes(needle));

  const avatarPaths = visible.map((employee) => employee.avatar_url).filter((path): path is string => !!path);
  const avatarUrlByPath = new Map<string, string>();
  if (avatarPaths.length > 0) {
    const { data: signed } = await supabase.storage.from("employee-avatars").createSignedUrls(avatarPaths, 3600);
    for (const entry of signed ?? []) {
      if (entry.signedUrl) avatarUrlByPath.set(entry.path ?? "", entry.signedUrl);
    }
  }

  return (
    <div className="space-y-6">
      <div className="admin-page-head">
        <div className="page-intro"><span className="eyebrow">People</span><h1>Every person, one reliable record.</h1><p>Build the complete HR record first — employment, access and onboarding — then send the invitation as the final step.</p></div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/admin/employees/requests" className="btn-secondary"><Icon name="edit" size={16} /> Employee requests{(pendingRequests ?? 0) > 0 && <span className="badge badge-gold ml-1">{pendingRequests}</span>}</Link>
          <Link href="/admin/employees/settings" className="btn-secondary"><Icon name="settings" size={16} /> Record settings</Link>
          <NewEmployeeForm organizationId={session.organizationId} />
        </div>
      </div>
      <div className="dashboard-metrics">
        <div className="metric-card"><span className="metric-icon mint"><Icon name="people" /></span><div><small>Total people</small><strong>{all.length}</strong><em>{counts.active} active</em></div></div>
        <div className="metric-card"><span className="metric-icon sun"><Icon name="onboarding" /></span><div><small>Pre-hires</small><strong>{counts.prehire}</strong><em>{counts.ready} ready to invite</em></div></div>
        <div className="metric-card"><span className="metric-icon coral"><Icon name="profile" /></span><div><small>Invitations pending</small><strong>{counts.pending}</strong><em>{counts.onboarding} onboarding</em></div></div>
        <div className="metric-card"><span className="metric-icon mint"><Icon name="check" /></span><div><small>Details confirmed</small><strong>{withAccounts.length ? Math.round((confirmedRecently / withAccounts.length) * 100) : 0}%</strong><em>in the last 12 months · {counts.profile} incomplete</em></div></div>
      </div>
      <section className="card overflow-x-auto">
        <div className="panel-heading"><div><span className="panel-icon"><Icon name="people" /></span><div><h3>People directory</h3><p>Select an employee to open their complete HR record.</p></div></div></div>
        <div className="directory-toolbar">
          <nav className="filter-chips" aria-label="Filter employees">
            {FILTERS.map((f) => (
              <Link key={f.key} href={`/admin/employees${f.key === "all" ? "" : `?filter=${f.key}`}`} aria-current={filter === f.key ? "page" : undefined} className={filter === f.key ? "active" : ""}>
                {f.label} <span>{counts[f.key]}</span>
              </Link>
            ))}
          </nav>
          <form className="directory-search" role="search">
            {filter !== "all" && <input type="hidden" name="filter" value={filter} />}
            <label className="sr-only" htmlFor="people-search">Search people</label>
            <input id="people-search" name="q" className="input" placeholder="Search name, number or email" defaultValue={q ?? ""} />
          </form>
        </div>
        <table className="w-full text-sm"><thead><tr className="border-b border-stone-100 text-left"><th className="pb-3">Employee</th><th className="pb-3">Employee #</th><th className="pb-3">Department / position</th><th className="pb-3">Status</th><th className="pb-3">Setup</th><th className="pb-3">Account</th><th className="pb-3">Onboarding</th><th className="pb-3">Actions</th></tr></thead><tbody className="divide-y divide-stone-100">
          {visible.length === 0 && <tr><td colSpan={8} className="py-10 text-center text-stone-400">{all.length === 0 ? "No employee records yet." : "No one matches this view."}</td></tr>}
          {visible.map((employee) => {
            const avatarUrl = employee.avatar_url ? avatarUrlByPath.get(employee.avatar_url) ?? null : null;
            const fullName = `${employee.preferred_name || employee.first_name} ${employee.last_name}`;
            const summary = summaryById.get(employee.id);
            const assignment = assignmentById.get(employee.id);
            const hasPendingInvite = summary?.account_state === "invited";
            const canDelete = employee.status === "prehire" && !employee.user_id;
            return (
              <tr key={employee.id}>
                <td className="py-3"><Link href={`/admin/employees/${employee.id}`} className="employee-cell"><span className="user-avatar small">{avatarUrl ? <img src={avatarUrl} alt="" /> : `${employee.first_name[0]}${employee.last_name[0]}`}</span><span><strong>{fullName}</strong><small>{employee.work_email ?? "No email on file"}</small></span></Link></td>
                <td className="py-3 font-mono text-xs text-stone-500">{employee.employee_number}</td>
                <td className="py-3 text-xs text-stone-600">{assignment?.org_units?.name ?? "—"}<br /><span className="text-stone-400">{assignment?.positions?.title ?? "No position"}</span></td>
                <td className="py-3"><span className={`badge ${statusBadgeClass(employee.status)}`}>{employee.status}</span></td>
                <td className="py-3">
                  {summary ? (
                    <div className="setup-mini" title={summary.ready ? "Setup complete" : `${summary.blocker_count} item(s) remaining`}>
                      <span className="setup-progress small"><span style={{ width: `${summary.percent}%` }} /></span>
                      <small>{summary.percent}%</small>
                    </div>
                  ) : "—"}
                </td>
                <td className="py-3"><InviteButton employeeId={employee.id} alreadyInvited={!!employee.user_id} accepted={summary?.account_state === "active"} portalSlug={portalSlug} setup={summary && !employee.user_id ? { ready: summary.ready, percent: summary.percent } : undefined} /></td>
                <td className="py-3 text-xs text-stone-600">
                  {summary?.onboarding_status
                    ? <>{summary.onboarding_completed}/{summary.onboarding_total} tasks<br /><span className="text-stone-400">{summary.onboarding_status.replace("_", " ")}</span></>
                    : <span className="text-stone-400">Not started</span>}
                </td>
                <td className="py-3">
                  <div className="flex items-center gap-1">
                    <EditEmployeeEmailButton employeeId={employee.id} employeeName={fullName} currentEmail={employee.work_email} hasPendingInvite={hasPendingInvite} />
                    {canDelete && <DeleteEmployeeButton employeeId={employee.id} employeeName={fullName} />}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody></table>
      </section>
    </div>
  );
}
