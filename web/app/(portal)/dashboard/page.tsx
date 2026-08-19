import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";
import { ClockButton } from "@/components/ClockButton";
import { statusBadgeClass } from "@/lib/ui";
import type { AttendanceSession, LeaveRequest } from "@/lib/supabase/types";

export default async function DashboardPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");

  if (!session.employee) {
    return (
      <div className="card">
        <h1 className="text-lg font-semibold">No employee record linked</h1>
        <p className="mt-2 text-sm text-stone-600">
          Your login exists but isn&apos;t linked to an employee record in this organization yet.
          Ask an HR administrator to check your invitation.
        </p>
      </div>
    );
  }

  const supabase = await createClient();
  const employeeId = session.employee.id;

  const [{ data: openSession }, { data: balances }, { data: leaveRequests }, { data: notifications }] =
    await Promise.all([
      supabase
        .from("attendance_sessions")
        .select("*")
        .eq("employee_id", employeeId)
        .is("clock_out_at", null)
        .maybeSingle(),
      supabase
        .from("leave_balance_v")
        .select("balance, leave_type_id, leave_type_name")
        .eq("employee_id", employeeId),
      supabase
        .from("leave_requests")
        .select("*, leave_types(name)")
        .eq("employee_id", employeeId)
        .order("submitted_at", { ascending: false })
        .limit(5),
      supabase
        .from("notifications")
        .select("id, title, body, link_url, is_read, created_at")
        .eq("recipient_user_id", session.userId)
        .order("created_at", { ascending: false })
        .limit(5),
    ]);

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-1">
        <div className="card">
          <h2 className="text-sm font-medium text-stone-500">
            {session.employee.first_name} {session.employee.last_name}
          </h2>
          <p className="mt-1 text-xs text-stone-400">{session.employee.employee_number}</p>
          <div className="mt-4">
            <ClockButton openSession={(openSession as AttendanceSession) ?? null} />
          </div>
        </div>

        <div className="card">
          <h2 className="mb-3 text-sm font-semibold text-stone-900">Leave balances</h2>
          <ul className="space-y-2">
            {(balances ?? []).length === 0 && (
              <li className="text-sm text-stone-400">No leave policy assigned yet.</li>
            )}
            {(balances ?? []).map((b: any) => (
              <li key={b.leave_type_id} className="flex items-center justify-between text-sm">
                <span className="text-stone-600">{b.leave_type_name}</span>
                <span className="font-medium text-stone-900">{b.balance} days</span>
              </li>
            ))}
          </ul>
          <Link href="/leave" className="mt-4 inline-block text-sm font-medium text-royal-700 hover:text-royal-800">
            Request leave →
          </Link>
        </div>
      </div>

      <div className="space-y-6 lg:col-span-2">
        <div className="card">
          <h2 className="mb-3 text-sm font-semibold text-stone-900">Recent leave requests</h2>
          <ul className="divide-y divide-stone-100">
            {(leaveRequests ?? []).length === 0 && (
              <li className="py-3 text-sm text-stone-400">No leave requests yet.</li>
            )}
            {(leaveRequests as (LeaveRequest & { leave_types: { name: string } })[] | null)?.map((r) => (
              <li key={r.id} className="flex items-center justify-between py-3 text-sm">
                <div>
                  <p className="font-medium text-stone-900">{r.leave_types?.name}</p>
                  <p className="text-xs text-stone-500">
                    {r.start_date} → {r.end_date} · {r.total_days} day(s)
                  </p>
                </div>
                <span className={`badge ${statusBadgeClass(r.status)}`}>{r.status.replace(/_/g, " ")}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <h2 className="mb-3 text-sm font-semibold text-stone-900">Notifications</h2>
          <ul className="divide-y divide-stone-100">
            {(notifications ?? []).length === 0 && (
              <li className="py-3 text-sm text-stone-400">You&apos;re all caught up.</li>
            )}
            {(notifications ?? []).map((n) => (
              <li key={n.id} className="py-3 text-sm">
                <p className={n.is_read ? "text-stone-500" : "font-medium text-stone-900"}>{n.title}</p>
                {n.body && <p className="text-xs text-stone-500">{n.body}</p>}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
