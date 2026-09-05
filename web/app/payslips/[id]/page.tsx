import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Icon } from "@/components/Icon";
import { PrintPayslipButton } from "@/components/PrintPayslipButton";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";

type PayrollRecord = {
  id: string;
  employee_id: string;
  organization_id: string;
  pay_period_start: string | null;
  pay_period_end: string | null;
  pay_date: string | null;
  currency: string;
  gross_pay: number | string | null;
  regular_pay: number | string | null;
  overtime_pay: number | string | null;
  allowances: number | string | null;
  bonus: number | string | null;
  tax: number | string | null;
  other_deductions: number | string | null;
  net_pay: number | string | null;
  batch_status: string;
};

function formatMoney(value: number | string | null | undefined, currency = "USD") {
  if (value === null || value === undefined) return "—";
  const safeCurrency = /^[A-Z]{3}$/.test(currency) ? currency : "USD";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: safeCurrency, maximumFractionDigits: 2 }).format(Number(value));
}

// Plain `date` columns (pay_period_start/end, pay_date) — the noon-UTC
// trick avoids the day shifting when rendered, same as pay/page.tsx.
function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function fullName(person: { first_name?: string | null; last_name?: string | null; preferred_name?: string | null } | null | undefined) {
  if (!person) return "Employee";
  const first = person.preferred_name || person.first_name;
  return [first, person.last_name].filter(Boolean).join(" ") || "Employee";
}

// Halomanage never calculates payroll — this page only ever formats a row
// that already exists in current_payroll_records (an approved, matched
// import from the organization's own payroll provider). See
// ARCHITECTURE.md "Payroll import architecture" and
// 20260818001200_payroll_import.sql. RLS on the underlying table already
// covers both the employee viewing their own record and an HR/admin with
// payroll.read_org viewing someone else's — this page adds no access
// rule of its own, matching the pattern used by team/[id].
//
// Deliberately outside the (portal) route group (see network-restricted's
// precedent) so it renders without the portal shell's sidebar/topbar —
// a payslip should be one clean, printable sheet.
export default async function PayslipPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee) redirect("/signup/complete?repair=1");

  const supabase = await createClient();
  const { data: record } = await supabase
    .from("current_payroll_records")
    .select("id, employee_id, organization_id, pay_period_start, pay_period_end, pay_date, currency, gross_pay, regular_pay, overtime_pay, allowances, bonus, tax, other_deductions, net_pay, batch_status")
    .eq("id", id)
    .maybeSingle();

  if (!record) notFound();
  const payroll = record as PayrollRecord;

  const isOwnPayslip = payroll.employee_id === session.employee.id;
  const [{ data: employee }, { data: assignment }] = await Promise.all([
    isOwnPayslip
      ? Promise.resolve({ data: session.employee })
      : supabase.from("employees").select("first_name, last_name, preferred_name, employee_number").eq("id", payroll.employee_id).maybeSingle(),
    supabase.from("employee_assignments").select("positions(title)").eq("employee_id", payroll.employee_id).is("end_date", null).maybeSingle(),
  ]);

  const embeddedPosition = assignment?.positions as { title: string } | { title: string }[] | null | undefined;
  const positionTitle = (Array.isArray(embeddedPosition) ? embeddedPosition[0]?.title : embeddedPosition?.title) ?? null;
  const otherEarnings = Number(payroll.allowances ?? 0) + Number(payroll.bonus ?? 0);
  const deductions = Number(payroll.tax ?? 0) + Number(payroll.other_deductions ?? 0);
  const backHref = isOwnPayslip ? "/pay" : "/admin/reports";

  return (
    <div className="payslip-page">
      <div className="payslip-toolbar no-print">
        <Link href={backHref} className="text-xs text-royal-700 hover:text-royal-800">← Back</Link>
        <PrintPayslipButton />
      </div>

      <article className="card payslip-sheet">
        <header className="payslip-letterhead">
          <div>
            <span className="eyebrow">Payslip</span>
            <h1 className="font-display text-xl font-bold text-stone-900">{session.organization?.name ?? "Organization"}</h1>
          </div>
          <div className="text-right text-sm text-stone-500">
            <p>Pay period</p>
            <p className="font-medium text-stone-900">{formatDate(payroll.pay_period_start)} – {formatDate(payroll.pay_period_end)}</p>
            <p className="mt-1">Pay date</p>
            <p className="font-medium text-stone-900">{formatDate(payroll.pay_date)}</p>
          </div>
        </header>

        <dl className="payslip-employee-grid">
          <div><dt>Employee</dt><dd>{fullName(employee)}</dd></div>
          <div><dt>Employee number</dt><dd>{employee?.employee_number ?? "—"}</dd></div>
          <div><dt>Position</dt><dd>{positionTitle ?? "Not recorded"}</dd></div>
          <div><dt>Currency</dt><dd>{payroll.currency}</dd></div>
        </dl>

        <div className="payslip-columns">
          <section>
            <h2>Earnings</h2>
            <table className="payslip-table">
              <tbody>
                <tr><td>Regular pay</td><td>{formatMoney(payroll.regular_pay, payroll.currency)}</td></tr>
                <tr><td>Overtime pay</td><td>{formatMoney(payroll.overtime_pay, payroll.currency)}</td></tr>
                <tr><td>Allowances</td><td>{formatMoney(payroll.allowances, payroll.currency)}</td></tr>
                <tr><td>Bonus</td><td>{formatMoney(payroll.bonus, payroll.currency)}</td></tr>
                <tr className="payslip-total-row"><td>Gross pay</td><td>{formatMoney(payroll.gross_pay, payroll.currency)}</td></tr>
              </tbody>
            </table>
          </section>
          <section>
            <h2>Deductions</h2>
            <table className="payslip-table">
              <tbody>
                <tr><td>Tax</td><td>{formatMoney(payroll.tax, payroll.currency)}</td></tr>
                <tr><td>Other deductions</td><td>{formatMoney(payroll.other_deductions, payroll.currency)}</td></tr>
                <tr className="payslip-total-row"><td>Total deductions</td><td>{formatMoney(deductions, payroll.currency)}</td></tr>
              </tbody>
            </table>
          </section>
        </div>

        <div className="payslip-net">
          <span>Net pay</span>
          <strong>{formatMoney(payroll.net_pay, payroll.currency)}</strong>
        </div>

        <footer className="payslip-footer">
          <p>
            <Icon name="shield" size={13} /> Status: {payroll.batch_status === "approved" ? "Approved" : payroll.batch_status}. Other earnings shown
            elsewhere as one figure ({formatMoney(otherEarnings, payroll.currency)}) are allowances and bonus combined, itemized above.
          </p>
          <p>
            Halomanage does not calculate tax, statutory deductions, or net pay — these figures are imported as-is from an approved payroll batch
            processed by {session.organization?.name ?? "your organization"}&apos;s payroll provider. Contact HR with questions about this payslip.
          </p>
        </footer>
      </article>
    </div>
  );
}
