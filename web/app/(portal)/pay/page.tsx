import { redirect } from "next/navigation";
import { Icon } from "@/components/Icon";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { statusBadgeClass } from "@/lib/ui";

type CompensationRecord = {
  id: string;
  amount: number | string;
  currency: string;
  pay_type: string | null;
  pay_type_other_label: string | null;
  rate_unit: string | null;
  pay_frequency: string | null;
  standard_weekly_hours: number | string | null;
  fte: number | string | null;
  overtime_eligible: boolean | null;
  pay_group_id: string | null;
  pay_grade_id: string | null;
  change_notes: string | null;
  source: string;
  start_date: string;
  end_date: string | null;
  needs_review: boolean;
  compensation_change_reasons: { name: string } | null;
};

type ComponentAssignment = {
  id: string;
  amount: number | string | null;
  percentage: number | string | null;
  currency: string;
  start_date: string;
  end_date: string | null;
  compensation_components: {
    name: string;
    component_type: string;
    recurrence: string;
    value_type: string;
  } | null;
};

type PayPeriod = {
  id: string;
  period_start: string;
  period_end: string;
  timesheet_cutoff_at: string | null;
  approval_deadline_at: string | null;
  pay_date: string;
  status: string;
};

type PayrollRecord = {
  id: string;
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
};

function formatMoney(value: number | string | null | undefined, currency = "USD") {
  if (value === null || value === undefined) return "—";
  const safeCurrency = /^[A-Z]{3}$/.test(currency) ? currency : "USD";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: safeCurrency,
    maximumFractionDigits: 2,
  }).format(Number(value));
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = value.length === 10 ? new Date(`${value}T12:00:00`) : new Date(value);
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function titleCase(value: string | null | undefined) {
  return value ? value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Not recorded";
}

function isEffective(record: { start_date: string; end_date: string | null }, today: string) {
  return record.start_date <= today && (!record.end_date || record.end_date >= today);
}

export default async function PayPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee) redirect("/signup/complete?repair=1");
  if (!sessionCan(session, "compensation.read_self")) redirect("/dashboard");

  const supabase = await createClient();
  const employeeId = session.employee.id;
  const today = new Date().toISOString().slice(0, 10);

  const [compensationResult, componentResult, payrollResult] = await Promise.all([
    supabase
      .from("employee_compensation")
      .select("*, compensation_change_reasons(name)")
      .eq("employee_id", employeeId)
      .order("start_date", { ascending: false }),
    supabase
      .from("employee_compensation_components")
      .select("id, amount, percentage, currency, start_date, end_date, compensation_components(name, component_type, recurrence, value_type)")
      .eq("employee_id", employeeId)
      .order("start_date", { ascending: false }),
    supabase
      .from("current_payroll_records")
      .select("id, pay_period_start, pay_period_end, pay_date, currency, gross_pay, regular_pay, overtime_pay, allowances, bonus, tax, other_deductions, net_pay")
      .eq("employee_id", employeeId)
      .order("pay_date", { ascending: false })
      .limit(24),
  ]);

  const compensationHistory = (compensationResult.data ?? []) as CompensationRecord[];
  const componentHistory = (componentResult.data ?? []) as unknown as ComponentAssignment[];
  const payrollHistory = (payrollResult.data ?? []) as PayrollRecord[];
  const currentCompensation = compensationHistory.find((record) => isEffective(record, today)) ?? null;
  const upcomingCompensation = [...compensationHistory]
    .filter((record) => record.start_date > today)
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
  const activeComponents = componentHistory.filter((record) => isEffective(record, today));

  let payGroup: { id: string; name: string; currency: string; pay_frequency: string; pay_calendar_id: string | null } | null = null;
  let payGrade: { name: string; code: string | null } | null = null;
  let payCalendar: { id: string; name: string; pay_frequency: string } | null = null;
  let futurePeriods: PayPeriod[] = [];
  let relatedDataError = false;

  const [payGroupResult, payGradeResult] = await Promise.all([
    currentCompensation?.pay_group_id
      ? supabase.from("pay_groups").select("id, name, currency, pay_frequency, pay_calendar_id").eq("id", currentCompensation.pay_group_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    currentCompensation?.pay_grade_id
      ? supabase.from("pay_grades").select("name, code").eq("id", currentCompensation.pay_grade_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  payGroup = payGroupResult.data;
  payGrade = payGradeResult.data;
  relatedDataError = Boolean(payGroupResult.error || payGradeResult.error);

  if (payGroup?.pay_calendar_id) {
    const [calendarResult, periodsResult] = await Promise.all([
      supabase.from("pay_calendars").select("id, name, pay_frequency").eq("id", payGroup.pay_calendar_id).maybeSingle(),
      supabase
        .from("pay_periods")
        .select("id, period_start, period_end, timesheet_cutoff_at, approval_deadline_at, pay_date, status")
        .eq("pay_calendar_id", payGroup.pay_calendar_id)
        .gte("pay_date", today)
        .order("pay_date", { ascending: true })
        .limit(8),
    ]);
    payCalendar = calendarResult.data;
    futurePeriods = (periodsResult.data ?? []) as PayPeriod[];
    relatedDataError = relatedDataError || Boolean(calendarResult.error || periodsResult.error);
  }

  const loadError = Boolean(compensationResult.error || componentResult.error || payrollResult.error || relatedDataError);
  const nextPayDate = futurePeriods[0]?.pay_date ?? null;
  const payType = currentCompensation?.pay_type === "other"
    ? currentCompensation.pay_type_other_label
    : currentCompensation?.pay_type;

  return (
    <div className="space-y-6">
      <div className="page-intro">
        <span className="eyebrow">Your compensation</span>
        <h1>My pay &amp; compensation.</h1>
        <p>See your current gross rate, effective-dated changes, pay schedule, recurring components, and approved records imported from your payroll provider.</p>
      </div>

      {loadError && (
        <p className="alert-error">
          Some pay details could not be loaded. Your administrator should confirm the latest compensation migration and Data API grants are deployed.
        </p>
      )}

      {currentCompensation ? (
        <>
          {currentCompensation.needs_review && (
            <p className="alert-error">
              Your HR team still needs to confirm the pay type or rate unit carried over from an older record.
            </p>
          )}

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div className="metric-card">
              <span className="metric-icon mint"><Icon name="payroll" /></span>
              <div><small>Current gross rate</small><strong>{formatMoney(currentCompensation.amount, currentCompensation.currency)}</strong><em>{currentCompensation.rate_unit ? `per ${currentCompensation.rate_unit}` : "rate unit not recorded"}</em></div>
            </div>
            <div className="metric-card">
              <span className="metric-icon sun"><Icon name="calendar" /></span>
              <div><small>Next scheduled pay date</small><strong>{nextPayDate ? formatDate(nextPayDate) : "—"}</strong><em>{payCalendar?.name ?? "calendar not assigned"}</em></div>
            </div>
            <div className="metric-card">
              <span className="metric-icon coral"><Icon name="clock" /></span>
              <div><small>Standard weekly hours</small><strong>{currentCompensation.standard_weekly_hours ?? "—"}</strong><em>{currentCompensation.fte ? `${currentCompensation.fte} FTE` : "FTE not recorded"}</em></div>
            </div>
            <div className="metric-card">
              <span className="metric-icon"><Icon name="reports" /></span>
              <div><small>Pay basis</small><strong>{titleCase(payType)}</strong><em>{titleCase(currentCompensation.pay_frequency ?? payGroup?.pay_frequency)}</em></div>
            </div>
          </div>

          <section className="card">
            <div className="panel-heading">
              <div><span className="panel-icon"><Icon name="payroll" /></span><div><h3>Current compensation details</h3><p>Effective since {formatDate(currentCompensation.start_date)}.</p></div></div>
              <span className="badge badge-emerald">Current</span>
            </div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm md:grid-cols-3 xl:grid-cols-4">
              <div><dt className="text-xs uppercase text-stone-400">Pay type</dt><dd className="mt-1 font-medium text-stone-900">{titleCase(payType)}</dd></div>
              <div><dt className="text-xs uppercase text-stone-400">Rate unit</dt><dd className="mt-1 font-medium text-stone-900">{titleCase(currentCompensation.rate_unit)}</dd></div>
              <div><dt className="text-xs uppercase text-stone-400">Pay frequency</dt><dd className="mt-1 font-medium text-stone-900">{titleCase(currentCompensation.pay_frequency ?? payGroup?.pay_frequency)}</dd></div>
              <div><dt className="text-xs uppercase text-stone-400">Pay group</dt><dd className="mt-1 font-medium text-stone-900">{payGroup?.name ?? "Not assigned"}</dd></div>
              <div><dt className="text-xs uppercase text-stone-400">Pay grade</dt><dd className="mt-1 font-medium text-stone-900">{payGrade?.name ?? "Not assigned"}{payGrade?.code ? ` (${payGrade.code})` : ""}</dd></div>
              <div><dt className="text-xs uppercase text-stone-400">Overtime eligible</dt><dd className="mt-1 font-medium text-stone-900">{currentCompensation.overtime_eligible === null ? "Not recorded" : currentCompensation.overtime_eligible ? "Yes" : "No"}</dd></div>
              <div><dt className="text-xs uppercase text-stone-400">Source</dt><dd className="mt-1 font-medium text-stone-900">{titleCase(currentCompensation.source)}</dd></div>
              <div><dt className="text-xs uppercase text-stone-400">Currency</dt><dd className="mt-1 font-medium text-stone-900">{currentCompensation.currency}</dd></div>
            </dl>
            <p className="mt-5 border-t border-stone-100 pt-4 text-xs text-stone-500">
              This is your contractual gross rate. Halomanage does not calculate taxes, statutory deductions, or take-home pay; approved pay-run figures below come from your connected payroll provider.
            </p>
          </section>
        </>
      ) : (
        <div className="context-empty card">
          <span><Icon name="payroll" size={22} /></span>
          <div><strong>No compensation record yet</strong><p>Ask HR to add your pay type, rate, effective date, and pay group. Once recorded, your pay calendar and history will appear here automatically.</p></div>
        </div>
      )}

      {upcomingCompensation.length > 0 && (
        <section className="card">
          <div className="panel-heading"><div><span className="panel-icon"><Icon name="calendar" /></span><div><h3>Upcoming changes</h3><p>Approved changes that have not taken effect yet.</p></div></div></div>
          <div className="resource-list">
            {upcomingCompensation.map((record) => (
              <article key={record.id}>
                <span className="metric-icon sun small"><Icon name="calendar" size={16} /></span>
                <div><strong>{formatMoney(record.amount, record.currency)}{record.rate_unit ? ` per ${record.rate_unit}` : ""}</strong><p>{titleCase(record.pay_type)} · effective {formatDate(record.start_date)}</p><small>{record.compensation_change_reasons?.name ?? record.change_notes ?? "Approved compensation change"}</small></div>
                <span className="badge badge-gold">Upcoming</span>
              </article>
            ))}
          </div>
        </section>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="card">
          <div className="panel-heading"><div><span className="panel-icon"><Icon name="spark" /></span><div><h3>Compensation components</h3><p>Allowances, premiums, bonuses, or commission currently assigned to you.</p></div></div></div>
          <div className="resource-list">
            {activeComponents.length === 0 && <div className="context-empty"><span><Icon name="spark" /></span><div><strong>No active components</strong><p>No additional compensation components are currently assigned.</p></div></div>}
            {activeComponents.map((assignment) => {
              const embedded = assignment.compensation_components;
              const component = Array.isArray(embedded) ? embedded[0] : embedded;
              const value = assignment.percentage !== null
                ? `${Number(assignment.percentage).toLocaleString()}%`
                : formatMoney(assignment.amount, assignment.currency);
              return (
                <article key={assignment.id}>
                  <span className="metric-icon mint small"><Icon name="spark" size={16} /></span>
                  <div><strong>{component?.name ?? "Compensation component"}</strong><p>{titleCase(component?.component_type)} · {titleCase(component?.recurrence)}</p><small>Effective {formatDate(assignment.start_date)}</small></div>
                  <span className="badge badge-neutral">{value}</span>
                </article>
              );
            })}
          </div>
        </section>

        <section className="card overflow-x-auto">
          <div className="panel-heading"><div><span className="panel-icon"><Icon name="calendar" /></span><div><h3>Compensation calendar</h3><p>{payCalendar ? `${payCalendar.name} · ${titleCase(payCalendar.pay_frequency)}` : "Future pay periods tied to your pay group."}</p></div></div></div>
          <table className="w-full text-sm">
            <thead><tr className="border-b border-stone-100 text-left"><th className="pb-3">Pay period</th><th className="pb-3">Cutoff</th><th className="pb-3">Pay date</th><th className="pb-3">Status</th></tr></thead>
            <tbody className="divide-y divide-stone-100">
              {futurePeriods.length === 0 && <tr><td colSpan={4} className="py-8 text-center text-stone-400">No future pay periods are scheduled yet.</td></tr>}
              {futurePeriods.map((period) => (
                <tr key={period.id}>
                  <td className="py-3 font-medium text-stone-900">{formatDate(period.period_start)} – {formatDate(period.period_end)}</td>
                  <td className="py-3 text-stone-500">{formatDate(period.timesheet_cutoff_at)}</td>
                  <td className="py-3 font-medium text-stone-900">{formatDate(period.pay_date)}</td>
                  <td className="py-3"><span className={`badge ${statusBadgeClass(period.status)}`}>{titleCase(period.status)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <section className="card overflow-x-auto">
        <div className="panel-heading"><div><span className="panel-icon"><Icon name="document" /></span><div><h3>Approved pay records</h3><p>Pay-run results imported from your payroll provider. Newest pay date first.</p></div></div></div>
        <table className="w-full text-sm">
          <thead><tr className="border-b border-stone-100 text-left"><th className="pb-3">Pay date</th><th className="pb-3">Period</th><th className="pb-3 text-right">Regular</th><th className="pb-3 text-right">Overtime</th><th className="pb-3 text-right">Other earnings</th><th className="pb-3 text-right">Gross</th><th className="pb-3 text-right">Deductions</th><th className="pb-3 text-right">Net</th></tr></thead>
          <tbody className="divide-y divide-stone-100">
            {payrollHistory.length === 0 && <tr><td colSpan={8} className="py-8 text-center text-stone-400">No approved payroll records have been imported for you yet.</td></tr>}
            {payrollHistory.map((record) => {
              const otherEarnings = Number(record.allowances ?? 0) + Number(record.bonus ?? 0);
              const deductions = Number(record.tax ?? 0) + Number(record.other_deductions ?? 0);
              return (
                <tr key={record.id}>
                  <td className="py-3 font-medium text-stone-900">{formatDate(record.pay_date)}</td>
                  <td className="py-3 text-stone-500">{formatDate(record.pay_period_start)} – {formatDate(record.pay_period_end)}</td>
                  <td className="py-3 text-right">{formatMoney(record.regular_pay, record.currency)}</td>
                  <td className="py-3 text-right">{formatMoney(record.overtime_pay, record.currency)}</td>
                  <td className="py-3 text-right">{formatMoney(otherEarnings, record.currency)}</td>
                  <td className="py-3 text-right font-medium text-stone-900">{formatMoney(record.gross_pay, record.currency)}</td>
                  <td className="py-3 text-right">{formatMoney(deductions, record.currency)}</td>
                  <td className="py-3 text-right font-semibold text-stone-900">{formatMoney(record.net_pay, record.currency)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="card overflow-x-auto">
        <div className="panel-heading"><div><span className="panel-icon"><Icon name="reports" /></span><div><h3>Compensation history</h3><p>Every effective-dated rate on your employee record.</p></div></div></div>
        <table className="w-full text-sm">
          <thead><tr className="border-b border-stone-100 text-left"><th className="pb-3">Effective dates</th><th className="pb-3">Pay type</th><th className="pb-3">Gross rate</th><th className="pb-3">Cadence</th><th className="pb-3">Reason</th><th className="pb-3">Status</th></tr></thead>
          <tbody className="divide-y divide-stone-100">
            {compensationHistory.length === 0 && <tr><td colSpan={6} className="py-8 text-center text-stone-400">No compensation history is recorded yet.</td></tr>}
            {compensationHistory.map((record) => {
              const current = isEffective(record, today);
              const upcoming = record.start_date > today;
              return (
                <tr key={record.id}>
                  <td className="py-3 font-medium text-stone-900">{formatDate(record.start_date)} – {record.end_date ? formatDate(record.end_date) : "Open"}</td>
                  <td className="py-3">{titleCase(record.pay_type === "other" ? record.pay_type_other_label : record.pay_type)}</td>
                  <td className="py-3">{formatMoney(record.amount, record.currency)}{record.rate_unit ? ` / ${record.rate_unit}` : ""}</td>
                  <td className="py-3">{titleCase(record.pay_frequency)}</td>
                  <td className="py-3 text-stone-500">{record.compensation_change_reasons?.name ?? record.change_notes ?? "—"}</td>
                  <td className="py-3"><span className={`badge ${current ? "badge-emerald" : upcoming ? "badge-gold" : "badge-neutral"}`}>{current ? "Current" : upcoming ? "Upcoming" : "Previous"}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
