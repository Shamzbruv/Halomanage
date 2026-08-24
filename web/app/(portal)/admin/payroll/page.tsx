import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";
import { PayrollUploadForm } from "@/components/PayrollUploadForm";
import { ApproveBatchButton } from "@/components/ApproveBatchButton";
import { statusBadgeClass } from "@/lib/ui";

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
    <div className="space-y-6">
      <div className="page-intro"><span className="eyebrow">External pay records</span><h1>Import finalized pay with a clear audit trail.</h1><p>Validate, reconcile, approve, and preserve external payroll results without calculating payroll inside Halomanage.</p></div>
      <div className="grid gap-6 lg:grid-cols-3">
      <div className="lg:col-span-1">
        <PayrollUploadForm organizationId={session.organizationId} />
      </div>

      <div className="lg:col-span-2">
        <div className="card overflow-x-auto">
          <h2 className="mb-3 text-sm font-semibold text-stone-900">Import batches</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-100 text-left text-xs uppercase text-stone-400">
                <th className="pb-2">Type</th>
                <th className="pb-2">Period</th>
                <th className="pb-2">Rows</th>
                <th className="pb-2">Status</th>
                <th className="pb-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {(batches ?? []).length === 0 && (
                <tr>
                  <td colSpan={5} className="py-4 text-stone-400">No payroll imports yet.</td>
                </tr>
              )}
              {(batches ?? []).map((b) => (
                <tr key={b.id}>
                  <td className="py-2">{b.batch_type === "pay_run_results" ? "Pay run" : "Comp. change"}</td>
                  <td className="py-2 text-stone-500">
                    {b.pay_period_start ? `${b.pay_period_start} → ${b.pay_period_end}` : "—"}
                  </td>
                  <td className="py-2 text-xs text-stone-500">
                    {b.matched_rows}/{b.total_rows} matched
                    {b.unmatched_rows > 0 && <span className="text-ruby-600"> · {b.unmatched_rows} unmatched</span>}
                    {b.error_rows > 0 && <span className="text-ruby-600"> · {b.error_rows} errors</span>}
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
    </div>
  );
}
