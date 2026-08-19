import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";
import { LeaveTypeForm } from "@/components/LeaveTypeForm";

export default async function LeaveTypesAdminPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.roles.includes("admin")) redirect("/dashboard");
  if (!session.organizationId) redirect("/dashboard");

  const supabase = await createClient();
  const { data: leaveTypes } = await supabase
    .from("leave_types")
    .select("*")
    .eq("organization_id", session.organizationId)
    .order("name");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-stone-900">Leave types</h1>
        <LeaveTypeForm organizationId={session.organizationId} />
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-stone-100 text-left text-xs uppercase text-stone-400">
              <th className="pb-2">Name</th>
              <th className="pb-2">Paid</th>
              <th className="pb-2">Approval</th>
              <th className="pb-2">Half-day</th>
              <th className="pb-2">Min notice</th>
              <th className="pb-2">Max consecutive</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {(leaveTypes ?? []).length === 0 && (
              <tr><td colSpan={6} className="py-4 text-stone-400">No leave types yet — create one above.</td></tr>
            )}
            {(leaveTypes ?? []).map((t) => (
              <tr key={t.id}>
                <td className="py-2 font-medium text-stone-900">{t.name} <span className="text-xs text-stone-400">({t.code})</span></td>
                <td className="py-2">{t.is_paid ? "Yes" : "No"}</td>
                <td className="py-2">{t.requires_approval ? "Required" : "Auto-approved"}</td>
                <td className="py-2">{t.allow_half_day ? "Yes" : "No"}</td>
                <td className="py-2">{t.minimum_notice_days} day(s)</td>
                <td className="py-2">{t.maximum_consecutive_days ?? "No limit"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
