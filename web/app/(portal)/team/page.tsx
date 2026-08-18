import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";
import { LeaveDecisionButtons } from "@/components/LeaveDecisionButtons";

// Supervisor/Manager portal. Every query here reuses the exact same tables
// an Employee queries on their own dashboard — the *rows returned* differ
// because RLS scopes them via management_scope, not because this page runs
// different queries. See docs/ARCHITECTURE.md "Recommended RLS matrix".
export default async function TeamPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");

  const canSeeTeam = session.roles.some((r) => r === "supervisor" || r === "manager" || r === "admin");
  if (!canSeeTeam) redirect("/dashboard");

  const supabase = await createClient();

  const [{ data: pendingLeave }, { data: attendanceToday }] = await Promise.all([
    supabase.from("leave_pending_v").select("*").order("submitted_at", { ascending: true }),
    supabase.from("attendance_today_v").select("*").order("clock_in_at", { ascending: true }),
  ]);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="card">
        <h2 className="mb-3 text-sm font-semibold text-slate-900">Pending leave approvals</h2>
        <ul className="divide-y divide-slate-100">
          {(pendingLeave ?? []).length === 0 && (
            <li className="py-3 text-sm text-slate-400">Nothing awaiting your decision.</li>
          )}
          {(pendingLeave ?? []).map((r: any) => (
            <li key={r.id} className="flex items-center justify-between gap-4 py-3">
              <div className="text-sm">
                <p className="font-medium text-slate-900">
                  {r.first_name} {r.last_name} — {r.leave_type_name}
                </p>
                <p className="text-xs text-slate-500">
                  {r.start_date} → {r.end_date} · {r.total_days} day(s)
                  {r.reason ? ` — "${r.reason}"` : ""}
                </p>
              </div>
              <LeaveDecisionButtons leaveRequestId={r.id} />
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h2 className="mb-3 text-sm font-semibold text-slate-900">Team attendance today</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs uppercase text-slate-400">
              <th className="pb-2">Employee</th>
              <th className="pb-2">Clocked in</th>
              <th className="pb-2">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(attendanceToday ?? []).length === 0 && (
              <tr>
                <td colSpan={3} className="py-4 text-slate-400">No one on the clock right now.</td>
              </tr>
            )}
            {(attendanceToday ?? []).map((a: any) => (
              <tr key={a.employee_id}>
                <td className="py-2">{a.first_name} {a.last_name}</td>
                <td className="py-2 text-slate-500">{new Date(a.clock_in_at).toLocaleTimeString()}</td>
                <td className="py-2">
                  {a.is_late ? (
                    <span className="badge bg-amber-100 text-amber-700">Late</span>
                  ) : (
                    <span className="badge bg-green-100 text-green-700">On time</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
