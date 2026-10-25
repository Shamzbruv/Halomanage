import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { PrintPayslipButton } from "@/components/PrintPayslipButton";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";
import {
  formatPayMoney as money,
  formatPayDate as date,
  payItems,
  sumPayAmounts,
  type PublishedPay,
} from "@/lib/pay";

export const dynamic = "force-dynamic";
export const metadata = {
  robots: { index: false, follow: false },
  title: "Private payslip | HaloManage",
};
export default async function PayslipPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee) redirect("/signup/complete?repair=1");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    notFound();
  const supabase = await createClient();
  const { data: policy, error: policyError } = await supabase.rpc(
    "get_my_security_policy",
  );
  if (policyError)
    throw new Error("Could not verify payslip access. Please try again.");
  if (policy?.mfa_required && policy.current_aal !== "aal2") redirect("/mfa");
  const { data, error } = await supabase.rpc("get_payslip", { p_id: id });
  if (error?.code === "42501") notFound();
  if (error)
    throw new Error("The payslip could not be loaded. Please try again.");
  if (!data) notFound();
  const record = data as PublishedPay,
    p = record.snapshot,
    own = p.employee_id === session.employee.id;
  const earnings = payItems(p.earnings),
    taxes = payItems(p.taxes),
    deductions = payItems(p.deductions),
    employer = payItems(p.employer_values);
  const totalDeductions = sumPayAmounts(p.tax, p.other_deductions);
  return (
    <div className="payslip-page">
      <div className="payslip-toolbar no-print">
        <Link href={own ? "/pay" : "/admin/payroll"}>← Back</Link>
        <div className="flex gap-4">
          {own && (
            <Link href={`/pay/queries?payslip=${id}`}>
              Ask HR about this payslip
            </Link>
          )}
          <PrintPayslipButton />
        </div>
      </div>
      <article className="card payslip-sheet">
        {record.replaced_by && (
          <p className="alert-error">
            This payslip has been replaced.{" "}
            <Link href={`/payslips/${record.replaced_by}`}>
              Open its replacement
            </Link>
            . Use the current version when reviewing totals.
          </p>
        )}
        {record.replaces_id && (
          <p>
            This is a correction of{" "}
            <Link href={`/payslips/${record.replaces_id}`}>
              an earlier payslip
            </Link>
            .
          </p>
        )}
        <header className="payslip-letterhead">
          <div>
            <span className="eyebrow">Published payslip</span>
            <h1>{p.employer_name}</h1>
          </div>
          <div>
            <p>Pay period</p>
            <strong>
              {date(p.pay_period_start)} — {date(p.pay_period_end)}
            </strong>
            <p>Pay date: {date(p.pay_date)}</p>
          </div>
        </header>
        <dl className="payslip-employee-grid">
          <div>
            <dt>Employee</dt>
            <dd>{p.employee_name}</dd>
          </div>
          <div>
            <dt>Employee number</dt>
            <dd>{p.employee_number}</dd>
          </div>
          <div>
            <dt>Position at period end</dt>
            <dd>{p.position_title ?? "Not recorded"}</dd>
          </div>
          <div>
            <dt>Currency</dt>
            <dd>{p.currency}</dd>
          </div>
        </dl>
        <div className="payslip-columns">
          <section>
            <h2>Earnings</h2>
            <table className="payslip-table">
              <tbody>
                {earnings
                  ? earnings.map((x, i) => (
                      <tr key={i}>
                        <td>{x.label}</td>
                        <td>{money(x.amount, p.currency)}</td>
                      </tr>
                    ))
                  : [
                      ["Regular pay", p.regular_pay],
                      ["Overtime pay", p.overtime_pay],
                      ["Allowances", p.allowances],
                      ["Bonus", p.bonus],
                    ].map(([label, amount]) => (
                      <tr key={label}>
                        <td>{label}</td>
                        <td>{money(amount, p.currency)}</td>
                      </tr>
                    ))}
                <tr className="payslip-total-row">
                  <td>Gross pay</td>
                  <td>{money(p.gross_pay, p.currency)}</td>
                </tr>
              </tbody>
            </table>
          </section>
          <section>
            <h2>Deductions</h2>
            <table className="payslip-table">
              <tbody>
                {taxes?.map((x, i) => (
                  <tr key={`tax-${i}`}>
                    <td>{x.label}</td>
                    <td>{money(x.amount, p.currency)}</td>
                  </tr>
                ))}
                <tr>
                  <td>{taxes ? "Total tax" : "Tax (imported total)"}</td>
                  <td>{money(p.tax, p.currency)}</td>
                </tr>
                {deductions?.map((x, i) => (
                  <tr key={`deduction-${i}`}>
                    <td>{x.label}</td>
                    <td>{money(x.amount, p.currency)}</td>
                  </tr>
                ))}
                <tr>
                  <td>
                    {deductions
                      ? "Total other deductions"
                      : "Other deductions (imported total)"}
                  </td>
                  <td>{money(p.other_deductions, p.currency)}</td>
                </tr>
                <tr className="payslip-total-row">
                  <td>Total deductions</td>
                  <td>{money(totalDeductions, p.currency)}</td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>
        {employer && (
          <section>
            <h2>Employer contributions (not deducted from net pay)</h2>
            <table className="payslip-table">
              <tbody>
                {employer.map((x, i) => (
                  <tr key={i}>
                    <td>{x.label}</td>
                    <td>{money(x.amount, p.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        <div className="payslip-net">
          <span>Net pay</span>
          <strong>{money(p.net_pay, p.currency)}</strong>
        </div>
        <footer className="payslip-footer">
          <p>
            Record reference: {id}. Published:{" "}
            {record.published_at
              ? new Date(record.published_at).toISOString()
              : "Not recorded"}
            .
          </p>
          {record.legacy_capture && (
            <p>
              Legacy record: employer and employee details were captured when
              historical pay records were migrated; they may differ from the
              original payroll document.
            </p>
          )}
          <p>
            “Not supplied” means that value was absent from the imported source.
            It does not mean zero. Itemized deductions are shown only when
            supplied in a supported format.
          </p>
          <p>
            Figures are imported from approved external payroll results.
            HaloManage does not calculate payroll, tax or statutory
            contributions. This record is not proof of a bank transfer. Ask HR
            if the figures, payment date or receipt of payment do not match your
            records.
          </p>
        </footer>
      </article>
    </div>
  );
}
