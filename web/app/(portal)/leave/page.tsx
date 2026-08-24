import Link from "next/link";
import { redirect } from "next/navigation";
import { Icon } from "@/components/Icon";
import { LeaveRequestForm } from "@/components/LeaveRequestForm";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";
import { statusBadgeClass } from "@/lib/ui";
import type { LeaveType } from "@/lib/supabase/types";

export default async function LeavePage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee) redirect("/signup/complete?repair=1");

  const supabase = await createClient();
  const employeeId = session.employee.id;
  const [{ data: leaveTypes }, { data: requests }, { data: balances }] = await Promise.all([
    supabase.from("leave_types").select("*").eq("organization_id", session.organizationId).eq("is_active", true).order("name"),
    supabase.from("leave_requests").select("*, leave_types(name)").eq("employee_id", employeeId).order("submitted_at", { ascending: false }),
    supabase.from("leave_balance_v").select("balance, leave_type_id, leave_type_name").eq("employee_id", employeeId),
  ]);

  const pending = (requests ?? []).filter((request) => request.status.startsWith("pending") || request.status === "submitted").length;

  return (
    <div className="space-y-6">
      <div className="page-intro"><span className="eyebrow">Time away</span><h1>Plan leave without the back-and-forth.</h1><p>See what you have available, submit a request, and follow every approval in one place.</p></div>

      <div className="leave-balance-grid">
        {(balances ?? []).map((balance: any, index) => (
          <div className="metric-card" key={balance.leave_type_id}><span className={`metric-icon ${index % 2 ? "sun" : "mint"}`}><Icon name="calendar" /></span><div><small>{balance.leave_type_name}</small><strong>{Number(balance.balance).toLocaleString(undefined, { maximumFractionDigits: 1 })}</strong><em>days available</em></div></div>
        ))}
        <div className="metric-card"><span className="metric-icon coral"><Icon name="clock" /></span><div><small>Pending requests</small><strong>{pending}</strong><em>awaiting a decision</em></div></div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[380px_minmax(0,1fr)]">
        <div>
          {(leaveTypes ?? []).length > 0 ? <LeaveRequestForm leaveTypes={(leaveTypes as LeaveType[]) ?? []} /> : (
            <div className="context-empty card">
              <span><Icon name="leave" size={22} /></span>
              <div><strong>Leave policies are not configured yet</strong><p>Add vacation, sick, unpaid, or business-specific policies before employees submit requests.</p></div>
              {session.roles.includes("admin") && <Link className="btn-primary" href="/admin/setup">Finish leave setup</Link>}
            </div>
          )}
        </div>
        <div className="card overflow-x-auto">
          <div className="panel-heading"><div><span className="panel-icon"><Icon name="leave" /></span><div><h3>Request history</h3><p>Every request and its current approval status.</p></div></div></div>
          <table className="w-full text-sm">
            <thead><tr className="border-b border-stone-100 text-left"><th className="pb-3">Type</th><th className="pb-3">Dates</th><th className="pb-3">Days</th><th className="pb-3">Status</th></tr></thead>
            <tbody className="divide-y divide-stone-100">
              {(requests ?? []).length === 0 && <tr><td colSpan={4} className="py-8 text-center text-stone-400">No leave requests yet.</td></tr>}
              {(requests ?? []).map((request: any) => (
                <tr key={request.id}><td className="py-3 font-medium text-stone-900">{request.leave_types?.name}</td><td className="py-3 text-stone-500">{request.start_date} → {request.end_date}</td><td className="py-3">{request.total_days}</td><td className="py-3"><span className={`badge ${statusBadgeClass(request.status)}`}>{request.status.replace(/_/g, " ")}</span></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
