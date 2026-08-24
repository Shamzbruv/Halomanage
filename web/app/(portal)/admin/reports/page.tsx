import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";
import { Icon } from "@/components/Icon";

export default async function ReportsPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.roles.includes("admin")) redirect("/dashboard");
  if (!session.organizationId) redirect("/dashboard");

  const supabase = await createClient();
  const orgId = session.organizationId;

  const [
    { data: headcount },
    { data: pendingLeave },
    { data: onboarding },
    { data: expiring },
    { data: payrollBatches },
  ] = await Promise.all([
    supabase.from("employee_headcount_v").select("*").eq("organization_id", orgId),
    supabase.from("leave_pending_v").select("id"),
    supabase.from("onboarding_progress_v").select("status, percent_complete").eq("organization_id", orgId),
    supabase.from("expiring_items_v").select("*").eq("organization_id", orgId).order("expires_on"),
    supabase.from("payroll_import_status_v").select("*").eq("organization_id", orgId).order("uploaded_at", { ascending: false }).limit(5),
  ]);

  const totalHeadcount = (headcount ?? []).reduce((sum, h) => sum + Number(h.employee_count), 0);
  const activeHeadcount = (headcount ?? []).find((h) => h.status === "active")?.employee_count ?? 0;
  const onboardingInProgress = (onboarding ?? []).filter((o) => o.status === "in_progress").length;
  const avgOnboardingProgress = onboarding && onboarding.length > 0
    ? Math.round(onboarding.reduce((sum, o) => sum + (o.percent_complete ?? 0), 0) / onboarding.length)
    : null;

  const soon = (expiring ?? []).filter((e) => {
    // This is a request-time Server Component report, so "now" is the
    // intended reporting boundary rather than client render state.
    // eslint-disable-next-line react-hooks/purity
    const days = (new Date(e.expires_on).getTime() - Date.now()) / 86400000;
    return days <= 60;
  });

  return (
    <div className="space-y-6">
      <div className="page-intro"><span className="eyebrow">Workforce intelligence</span><h1>See what needs attention, then act.</h1><p>Every report honors the same role and scope rules as the employee record behind it.</p></div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="card"><span className="metric-icon mint mb-3"><Icon name="people" /></span>
          <p className="text-xs uppercase text-stone-400">Total employees</p>
          <p className="font-display text-3xl font-bold text-royal-800">{totalHeadcount}</p>
          <p className="text-xs text-stone-500">{activeHeadcount} active</p>
        </div>
        <div className="card"><span className="metric-icon sun mb-3"><Icon name="leave" /></span>
          <p className="text-xs uppercase text-stone-400">Pending leave</p>
          <p className="font-display text-3xl font-bold text-royal-800">{(pendingLeave ?? []).length}</p>
          <p className="text-xs text-stone-500">awaiting a decision</p>
        </div>
        <div className="card"><span className="metric-icon mint mb-3"><Icon name="onboarding" /></span>
          <p className="text-xs uppercase text-stone-400">Onboarding in progress</p>
          <p className="font-display text-3xl font-bold text-royal-800">{onboardingInProgress}</p>
          <p className="text-xs text-stone-500">{avgOnboardingProgress !== null ? `${avgOnboardingProgress}% avg. complete` : "—"}</p>
        </div>
        <div className="card"><span className="metric-icon coral mb-3"><Icon name="document" /></span>
          <p className="text-xs uppercase text-stone-400">Expiring within 60 days</p>
          <p className="font-display text-3xl font-bold text-royal-800">{soon.length}</p>
          <p className="text-xs text-stone-500">documents, certs &amp; training</p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="card">
          <h2 className="mb-3 text-sm font-semibold text-stone-900">Headcount by status</h2>
          <ul className="space-y-1 text-sm">
            {(headcount ?? []).map((h) => (
              <li key={h.status} className="flex justify-between">
                <span className="text-stone-600 capitalize">{h.status}</span>
                <span className="font-medium text-stone-900">{h.employee_count}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <h2 className="mb-3 text-sm font-semibold text-stone-900">Expiring soon</h2>
          <ul className="space-y-1 text-sm">
            {soon.length === 0 && <li className="text-stone-400">Nothing expiring in the next 60 days.</li>}
            {soon.slice(0, 8).map((e) => (
              <li key={`${e.item_type}-${e.item_id}`} className="flex justify-between">
                <span className="text-stone-600">{e.item_name} <span className="text-xs text-stone-400">({e.item_type})</span></span>
                <span className="font-medium text-stone-900">{e.expires_on}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <h2 className="mb-3 text-sm font-semibold text-stone-900">Recent payroll imports</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-stone-100 text-left text-xs uppercase text-stone-400">
              <th className="pb-2">Type</th>
              <th className="pb-2">Status</th>
              <th className="pb-2">Rows</th>
              <th className="pb-2">Uploaded</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {(payrollBatches ?? []).length === 0 && <tr><td colSpan={4} className="py-4 text-stone-400">No imports yet.</td></tr>}
            {(payrollBatches ?? []).map((b) => (
              <tr key={b.id}>
                <td className="py-2">{b.batch_type === "pay_run_results" ? "Pay run" : "Comp. change"}</td>
                <td className="py-2">{b.status}</td>
                <td className="py-2">{b.matched_rows}/{b.total_rows}</td>
                <td className="py-2 text-stone-500">{new Date(b.uploaded_at).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
