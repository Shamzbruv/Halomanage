import Link from "next/link";
import { redirect } from "next/navigation";
import { Icon } from "@/components/Icon";
import { InviteButton } from "@/components/InviteButton";
import { NewEmployeeForm } from "@/components/NewEmployeeForm";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";
import { statusBadgeClass } from "@/lib/ui";

export default async function EmployeesAdminPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.roles.includes("admin")) redirect("/dashboard");
  if (!session.organizationId) redirect("/dashboard");
  const supabase = await createClient();
  const { data: employees } = await supabase.from("employees").select("id, employee_number, first_name, last_name, work_email, status, user_id").eq("organization_id", session.organizationId).order("last_name");
  const active = (employees ?? []).filter((employee) => employee.status === "active").length;
  const prehire = (employees ?? []).filter((employee) => employee.status === "prehire").length;
  const invited = (employees ?? []).filter((employee) => employee.user_id).length;

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
        <table className="w-full text-sm"><thead><tr className="border-b border-stone-100 text-left"><th className="pb-3">Employee</th><th className="pb-3">Employee #</th><th className="pb-3">Status</th><th className="pb-3">Account</th></tr></thead><tbody className="divide-y divide-stone-100">
          {(employees ?? []).length === 0 && <tr><td colSpan={4} className="py-10 text-center text-stone-400">No employee records yet.</td></tr>}
          {(employees ?? []).map((employee) => (
            <tr key={employee.id}><td className="py-3"><Link href={`/admin/employees/${employee.id}`} className="employee-cell"><span className="user-avatar small">{employee.first_name[0]}{employee.last_name[0]}</span><span><strong>{employee.first_name} {employee.last_name}</strong><small>{employee.work_email ?? "No email on file"}</small></span></Link></td><td className="py-3 font-mono text-xs text-stone-500">{employee.employee_number}</td><td className="py-3"><span className={`badge ${statusBadgeClass(employee.status)}`}>{employee.status}</span></td><td className="py-3"><InviteButton employeeId={employee.id} alreadyInvited={!!employee.user_id} /></td></tr>
          ))}
        </tbody></table>
      </section>
    </div>
  );
}
