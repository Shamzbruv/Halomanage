import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";
import { PayrollUploadForm } from "@/components/PayrollUploadForm";
import { ApproveBatchButton } from "@/components/ApproveBatchButton";

function statusBadgeClass(status: string) {
  if (status === "approved") return "bg-green-100 text-green-700";
  if (status === "rejected" || status === "superseded") return "bg-slate-100 text-slate-500";
  if (status === "needs_review") return "bg-red-100 text-red-700";
  if (status === "ready_for_approval") return "bg-amber-100 text-amber-700";
  return "bg-blue-100 text-blue-700";
}

// Ref: PRODUCT_BLUEPRINT.md "External payroll import and employee pay
// records" — this page never shows a "calculate payroll" action. It only
// ever uploads what an external payroll system already calculated, and
// reconciles/approves it.
export default async function PayrollAdminPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.roles.includes("admin")) redirect("/dashboard");
  if (!session.organizationId) redirect("/dashboard");

  const supabase = await createClient();
  const { data: batches } = await supabase
    .from("payroll_import_batches")
    .select("*")
    .eq("organization_id", session.organizationId)
    .order("uploaded_at", { ascending: false });

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="lg:col-span-1">
        <PayrollUploadForm organizationId={session.organizationId} />
      </div>

      <div className="lg:col-span-2">
        <div className="card overflow-x-auto">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Import batches</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs uppercase text-slate-400">
                <th className="pb-2">Type</th>
                <th className="pb-2">Period</th>
                <th className="pb-2">Rows</th>
                <th className="pb-2">Status</th>
                <th className="pb-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(batches ?? []).length === 0 && (
                <tr>
                  <td colSpan={5} className="py-4 text-slate-400">No payroll imports yet.</td>
                </tr>
              )}
              {(batches ?? []).map((b) => (
                <tr key={b.id}>
                  <td className="py-2">{b.batch_type === "pay_run_results" ? "Pay run" : "Comp. change"}</td>
                  <td className="py-2 text-slate-500">
                    {b.pay_period_start ? `${b.pay_period_start} → ${b.pay_period_end}` : "—"}
                  </td>
                  <td className="py-2 text-xs text-slate-500">
                    {b.matched_rows}/{b.total_rows} matched
                    {b.unmatched_rows > 0 && <span className="text-red-600"> · {b.unmatched_rows} unmatched</span>}
                    {b.error_rows > 0 && <span className="text-red-600"> · {b.error_rows} errors</span>}
                  </td>
                  <td className="py-2">
                    <span className={`badge ${statusBadgeClass(b.status)}`}>{b.status.replace(/_/g, " ")}</span>
                  </td>
                  <td className="py-2">
                    {b.status === "ready_for_approval" && <ApproveBatchButton batchId={b.id} />}
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
