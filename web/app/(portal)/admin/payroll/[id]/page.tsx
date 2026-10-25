import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import {
  PayrollMatch,
  PayrollBatchActions,
} from "@/components/PayrollReconciliation";
import { ApproveBatchButton } from "@/components/ApproveBatchButton";
import { formatPayMoney as money, formatPayDate as date } from "@/lib/pay";
export const dynamic = "force-dynamic";
export default async function Batch({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const s = await getCurrentSession();
  if (!s) redirect("/login");
  if (!s.organizationId || !sessionCan(s, "payroll.import"))
    redirect("/dashboard");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const p = await searchParams,
    page = Math.max(1, Math.min(10000, Math.trunc(Number(p.page)) || 1)),
    db = await createClient();
  const { data: b, error } = await db
    .from("payroll_import_batches")
    .select("*")
    .eq("id", id)
    .eq("organization_id", s.organizationId)
    .maybeSingle();
  if (error) throw new Error("Batch could not be loaded");
  if (!b) notFound();
  const comp = b.batch_type === "compensation_change",
    closed = ["approved", "superseded", "rejected"].includes(b.status);
  const [
    { data: rows, error: rowError, count },
    { data: employeeData, error: employeeError },
  ] = await Promise.all([
    db
      .from(comp ? "compensation_change_rows" : "payroll_import_rows")
      .select("*", { count: "exact" })
      .eq("batch_id", id)
      .order("row_number")
      .range((page - 1) * 50, page * 50 - 1),
    db.rpc("list_payroll_employees", {
      p_organization_id: s.organizationId,
      p_search: "",
    }),
  ]);
  const employees = (employeeData ?? []) as {
    id: string;
    employee_number: string;
    first_name: string;
    last_name: string;
  }[];
  return (
    <div className="pay-workspace space-y-6">
      <div className="page-intro">
        <Link href="/admin/payroll">← Pay records</Link>
        <h1>Review payroll import</h1>
        <p>
          {b.original_file_name} · {b.status.replace(/_/g, " ")} · {b.currency}
        </p>
        <p>
          Period {date(b.pay_period_start)} — {date(b.pay_period_end)} · Pay
          date {date(b.pay_date)}
        </p>
        {b.supersedes_batch_id && (
          <p>
            Correction of{" "}
            <Link href={`/admin/payroll/${b.supersedes_batch_id}`}>
              {b.supersedes_batch_id}
            </Link>
            . Only included employees will be replaced.
          </p>
        )}
      </div>
      {(rowError || employeeError) && (
        <p role="alert" className="alert-error">
          Some reconciliation details could not be loaded. Refresh before
          approving.
        </p>
      )}
      <section className="card space-y-3">
        <h2>Reconciliation summary</h2>
        <p>
          {b.total_rows} rows · {b.matched_rows} matched · {b.unmatched_rows}{" "}
          unmatched · {b.error_rows} invalid
        </p>
        {!comp && (
          <p>
            Valid imported net total: {money(b.total_net_amount, b.currency)}
          </p>
        )}
        <p>
          Confirm identifiers, period, currency, source earnings and deduction
          totals against the finalized payroll file. Missing breakdown values
          stay unknown. Amount or date errors require a corrected upload; this
          screen does not rewrite source figures.
        </p>
        <p>
          Compensation imports update contractual rates. Pay run imports do not
          change compensation, attendance, leave balances or timesheets. Review
          those records with HR before approving the external payroll result.
        </p>
        {!closed && <PayrollBatchActions batchId={id} status={b.status} />}
        {b.status === "ready_for_approval" && !rowError && !employeeError && (
          <ApproveBatchButton batchId={id} />
        )}
        {b.rejected_reason && <p>Rejection reason: {b.rejected_reason}</p>}
        {b.status === "approved" && !comp && (
          <Link className="btn-secondary" href={`/admin/payroll?correct=${id}`}>
            Upload a correction
          </Link>
        )}
      </section>
      <section className="card overflow-x-auto">
        <h2>Source rows</h2>
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th>Row / identifier</th>
              <th>Employee</th>
              <th>
                {comp
                  ? "Effective date / new rate"
                  : "Gross / tax / other deductions / net"}
              </th>
              <th>Validation</th>
              {!closed && <th>Reconcile match</th>}
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((r) => (
              <tr key={r.id}>
                <td>
                  {r.row_number} ·{" "}
                  {r.employee_number ??
                    r.external_employee_id ??
                    "No stable identifier"}
                </td>
                <td>
                  {employees?.find((e) => e.id === r.employee_id)
                    ?.employee_number ??
                    r.employee_id ??
                    "Unmatched"}
                </td>
                <td>
                  {comp ? (
                    <>
                      {date(r.effective_date)} ·{" "}
                      {money(r.new_amount, r.currency ?? b.currency)}
                    </>
                  ) : (
                    <>
                      {[r.gross_pay, r.tax, r.other_deductions, r.net_pay]
                        .map((v) => money(v, b.currency))
                        .join(" / ")}
                    </>
                  )}
                </td>
                <td>
                  {r.mapping_status} / {r.validation_status}
                  <p className="text-ruby-600">{r.error_message}</p>
                  {!comp &&
                    r.id &&
                    b.status !== "rejected" &&
                    closed &&
                    sessionCan(s, "payroll.read_org") && (
                      <Link href={`/payslips/${r.id}`}>Published payslip</Link>
                    )}
                </td>
                {!closed && (
                  <td>
                    <PayrollMatch
                      rowId={r.id}
                      employees={(employees ?? []).map((e) => ({
                        id: e.id,
                        name: `${e.employee_number} — ${e.first_name} ${e.last_name}`,
                      }))}
                      compensation={comp}
                      organizationId={b.organization_id}
                    />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows?.length && (
          <p>
            No source rows are available. Process the uploaded file or upload a
            corrected file if processing failed.
          </p>
        )}
        <nav className="flex gap-4">
          {page > 1 && (
            <Link href={`/admin/payroll/${id}?page=${page - 1}`}>
              Previous page
            </Link>
          )}
          {(count ?? 0) > page * 50 && (
            <Link href={`/admin/payroll/${id}?page=${page + 1}`}>
              Next page
            </Link>
          )}
        </nav>
      </section>
    </div>
  );
}
