import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { PayrollUploadForm } from "@/components/PayrollUploadForm";
import Link from "next/link";
import { statusBadgeClass } from "@/lib/ui";

// Ref: PRODUCT_BLUEPRINT.md "External payroll import and employee pay
// records" — this page never shows a "calculate payroll" action. It only
// ever uploads what an external payroll system already calculated, and
// reconciles/approves it.
//
// Gated on payroll.import — the actual permission every RPC on this page
// enforces — not the Admin role. This page used to gate on
// session.roles.includes("admin"), which disagreed with the database the
// moment an organization customized role_permissions: a non-admin role
// granted payroll.import would still be turned away here, and an admin
// whose org revoked payroll.import would reach the page only to have
// every RPC call fail.
export default async function PayrollAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ correct?: string; page?: string }>;
}) {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.organizationId) redirect("/dashboard");
  if (!sessionCan(session, "payroll.import")) {
    if (
      sessionCan(session, "compensation.manage") ||
      sessionCan(session, "compensation.approve")
    )
      redirect("/admin/payroll/queries");
    redirect("/dashboard");
  }

  const filters = await searchParams;
  const page = Math.max(
    1,
    Math.min(10000, Math.trunc(Number(filters.page)) || 1),
  );
  const supabase = await createClient();
  const { data: correction } = filters.correct
    ? await supabase
        .from("payroll_import_batches")
        .select(
          "id,pay_period_start,pay_period_end,pay_date,currency,batch_type,status",
        )
        .eq("id", filters.correct)
        .eq("organization_id", session.organizationId)
        .eq("batch_type", "pay_run_results")
        .eq("status", "approved")
        .maybeSingle()
    : { data: null };
  const {
    data: batches,
    error,
    count,
  } = await supabase
    .from("payroll_import_batches")
    .select("*", { count: "exact" })
    .eq("organization_id", session.organizationId)
    .order("uploaded_at", { ascending: false })
    .range((page - 1) * 30, page * 30 - 1);

  return (
    <div className="pay-workspace space-y-6">
      <div className="page-intro">
        <span className="eyebrow">External pay records</span>
        <h1>Import finalized pay with a clear audit trail.</h1>
        <p>
          Validate, reconcile, approve, and preserve external payroll results
          without calculating payroll inside Halomanage.
        </p>
      </div>
      <Link href="/admin/payroll/queries" className="btn-secondary">
        Review employee pay queries
      </Link>
      {error && (
        <p className="alert-error">
          Payroll batches could not be loaded. Please try again.
        </p>
      )}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-1">
          <PayrollUploadForm
            organizationId={session.organizationId}
            correction={correction}
          />
        </div>

        <div className="lg:col-span-2">
          <div className="card overflow-x-auto">
            <h2 className="mb-3 text-sm font-semibold text-stone-900">
              Import batches
            </h2>
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
                    <td colSpan={5} className="py-4 text-stone-400">
                      No payroll imports yet.
                    </td>
                  </tr>
                )}
                {(batches ?? []).map((b) => (
                  <tr key={b.id}>
                    <td className="py-2">
                      {b.batch_type === "pay_run_results"
                        ? "Pay run"
                        : "Comp. change"}
                    </td>
                    <td className="py-2 text-stone-500">
                      {b.pay_period_start
                        ? `${b.pay_period_start} → ${b.pay_period_end}`
                        : "—"}
                    </td>
                    <td className="py-2 text-xs text-stone-500">
                      {b.matched_rows}/{b.total_rows} matched
                      {b.unmatched_rows > 0 && (
                        <span className="text-ruby-600">
                          {" "}
                          · {b.unmatched_rows} unmatched
                        </span>
                      )}
                      {b.error_rows > 0 && (
                        <span className="text-ruby-600">
                          {" "}
                          · {b.error_rows} errors
                        </span>
                      )}
                    </td>
                    <td className="py-2">
                      <span className={`badge ${statusBadgeClass(b.status)}`}>
                        {b.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="py-2">
                      <Link
                        href={`/admin/payroll/${b.id}`}
                        className="text-royal-700"
                      >
                        Review batch
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <nav className="flex gap-4">
              {page > 1 && (
                <Link href={`/admin/payroll?page=${page - 1}`}>
                  Previous page
                </Link>
              )}
              {(count ?? 0) > page * 30 && (
                <Link href={`/admin/payroll?page=${page + 1}`}>Next page</Link>
              )}
            </nav>
          </div>
        </div>
      </div>
    </div>
  );
}
