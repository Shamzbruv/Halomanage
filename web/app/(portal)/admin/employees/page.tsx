import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";
import { NewEmployeeForm } from "@/components/NewEmployeeForm";
import { InviteButton } from "@/components/InviteButton";
import { statusBadgeClass } from "@/lib/ui";

export default async function EmployeesAdminPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.roles.includes("admin")) redirect("/dashboard");
  if (!session.organizationId) redirect("/dashboard");

  const supabase = await createClient();
  const { data: employees } = await supabase
    .from("employees")
    .select("id, employee_number, first_name, last_name, work_email, status, user_id")
    .eq("organization_id", session.organizationId)
    .order("last_name");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-stone-900">Employees</h1>
        <NewEmployeeForm organizationId={session.organizationId} />
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-stone-100 text-left text-xs uppercase text-stone-400">
              <th className="pb-2">Employee #</th>
              <th className="pb-2">Name</th>
              <th className="pb-2">Work email</th>
              <th className="pb-2">Status</th>
              <th className="pb-2">Account</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {(employees ?? []).length === 0 && (
              <tr>
                <td colSpan={5} className="py-4 text-stone-400">No employees yet.</td>
              </tr>
            )}
            {(employees ?? []).map((e) => (
              <tr key={e.id}>
                <td className="py-2 font-mono text-xs">{e.employee_number}</td>
                <td className="py-2">{e.first_name} {e.last_name}</td>
                <td className="py-2 text-stone-500">{e.work_email ?? "—"}</td>
                <td className="py-2">
                  <span className={`badge ${statusBadgeClass(e.status)}`}>{e.status}</span>
                </td>
                <td className="py-2">
                  <InviteButton employeeId={e.id} alreadyInvited={!!e.user_id} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
