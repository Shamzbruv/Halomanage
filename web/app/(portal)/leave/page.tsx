import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";
import { LeaveRequestForm } from "@/components/LeaveRequestForm";
import type { LeaveType } from "@/lib/supabase/types";

function statusBadgeClass(status: string) {
  if (status === "approved") return "bg-green-100 text-green-700";
  if (status === "rejected" || status === "cancelled") return "bg-red-100 text-red-700";
  return "bg-amber-100 text-amber-700";
}

export default async function LeavePage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee) return null;

  const supabase = await createClient();
  const employeeId = session.employee.id;

  const [{ data: leaveTypes }, { data: requests }] = await Promise.all([
    supabase
      .from("leave_types")
      .select("*")
      .eq("organization_id", session.organizationId)
      .eq("is_active", true)
      .order("name"),
    supabase
      .from("leave_requests")
      .select("*, leave_types(name)")
      .eq("employee_id", employeeId)
      .order("submitted_at", { ascending: false }),
  ]);

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="lg:col-span-1">
        <LeaveRequestForm leaveTypes={(leaveTypes as LeaveType[]) ?? []} />
      </div>
      <div className="lg:col-span-2">
        <div className="card">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">My leave history</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs uppercase text-slate-400">
                <th className="pb-2">Type</th>
                <th className="pb-2">Dates</th>
                <th className="pb-2">Days</th>
                <th className="pb-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(requests ?? []).length === 0 && (
                <tr>
                  <td colSpan={4} className="py-4 text-slate-400">No leave requests yet.</td>
                </tr>
              )}
              {(requests ?? []).map((r: any) => (
                <tr key={r.id}>
                  <td className="py-2">{r.leave_types?.name}</td>
                  <td className="py-2 text-slate-500">{r.start_date} → {r.end_date}</td>
                  <td className="py-2">{r.total_days}</td>
                  <td className="py-2">
                    <span className={`badge ${statusBadgeClass(r.status)}`}>{r.status.replace(/_/g, " ")}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
