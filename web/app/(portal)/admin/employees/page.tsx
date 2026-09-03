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

export default async function EmployeesAdminPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!sessionCan(session, "employee.manage")) redirect("/dashboard");
  if (!session.organizationId || !session.organization) redirect("/dashboard");
  const portalSlug = session.organization.slug;
  const supabase = await createClient();
  const [{ data: employees }, { data: inviteStatus }] = await Promise.all([
    supabase.from("employees").select("id, employee_number, first_name, last_name, work_email, status, user_id, avatar_url").eq("organization_id", session.organizationId).order("last_name"),
    supabase.rpc("list_employee_invite_status", { p_organization_id: session.organizationId }),
  ]);
  const acceptedByEmployeeId = new Map((inviteStatus ?? []).map((row: { employee_id: string; accepted: boolean }) => [row.employee_id, row.accepted]));
  const active = (employees ?? []).filter((employee) => employee.status === "active").length;
  const prehire = (employees ?? []).filter((employee) => employee.status === "prehire").length;
  const invited = (employees ?? []).filter((employee) => employee.user_id).length;

  const avatarPaths = (employees ?? []).map((employee) => employee.avatar_url).filter((path): path is string => !!path);
  const avatarUrlByPath = new Map<string, string>();
  if (avatarPaths.length > 0) {
    const { data: signed } = await supabase.storage.from("employee-avatars").createSignedUrls(avatarPaths, 3600);
    for (const entry of signed ?? []) {
      if (entry.signedUrl) avatarUrlByPath.set(entry.path ?? "", entry.signedUrl);
    }
  }

  return (
    <div className="space-y-6">
      <div className="admin-page-head"><div className="page-intro"><span className="eyebrow">Employee directory</span><h1>Every person, one reliable record.</h1><p>Create hires, connect their account, and keep assignments and lifecycle details together.</p></div><NewEmployeeForm organizationId={session.organizationId} /></div>
      <div className="dashboard-metrics">
        <div className="metric-card"><span className="metric-icon mint"><Icon name="people" /></span><div><small>Total people</small><strong>{(employees ?? []).length}</strong><em>{active} active</em></div></div>
        <div className="metric-card"><span className="metric-icon sun"><Icon name="onboarding" /></span><div><small>Pre-hires</small><strong>{prehire}</strong><em>ready to onboard</em></div></div>
        <div className="metric-card"><span className="metric-icon coral"><Icon name="profile" /></span><div><small>Portal accounts</small><strong>{invited}</strong><em>connected employees</em></div></div>
      </div>
      <section className="card overflow-x-auto">
        <div className="panel-heading"><div><span className="panel-icon"><Icon name="people" /></span><div><h3>People directory</h3><p>Select an employee to manage assignments, balances, and access.</p></div></div></div>
        <table className="w-full text-sm"><thead><tr className="border-b border-stone-100 text-left"><th className="pb-3">Employee</th><th className="pb-3">Employee #</th><th className="pb-3">Status</th><th className="pb-3">Account</th><th className="pb-3">Actions</th></tr></thead><tbody className="divide-y divide-stone-100">
          {(employees ?? []).length === 0 && <tr><td colSpan={5} className="py-10 text-center text-stone-400">No employee records yet.</td></tr>}
          {(employees ?? []).map((employee) => {
            const avatarUrl = employee.avatar_url ? avatarUrlByPath.get(employee.avatar_url) ?? null : null;
            const fullName = `${employee.first_name} ${employee.last_name}`;
            const hasPendingInvite = !!employee.user_id && !acceptedByEmployeeId.get(employee.id);
            const canDelete = employee.status === "prehire" && !employee.user_id;
            return (
              <tr key={employee.id}>
                <td className="py-3"><Link href={`/admin/employees/${employee.id}`} className="employee-cell"><span className="user-avatar small">{avatarUrl ? <img src={avatarUrl} alt="" /> : `${employee.first_name[0]}${employee.last_name[0]}`}</span><span><strong>{fullName}</strong><small>{employee.work_email ?? "No email on file"}</small></span></Link></td>
                <td className="py-3 font-mono text-xs text-stone-500">{employee.employee_number}</td>
                <td className="py-3"><span className={`badge ${statusBadgeClass(employee.status)}`}>{employee.status}</span></td>
                <td className="py-3"><InviteButton employeeId={employee.id} alreadyInvited={!!employee.user_id} accepted={!!acceptedByEmployeeId.get(employee.id)} portalSlug={portalSlug} /></td>
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
