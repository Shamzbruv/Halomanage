import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { todayIn, formatDate } from "@/lib/timezone";
import {
  formatPayMoney as money,
  formatPayDate as date,
  type PayOverview,
} from "@/lib/pay";

export const dynamic = "force-dynamic";
const label = (v: string | null) => (v ? v.replace(/_/g, " ") : "Not recorded");
export default async function PayPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; currency?: string; page?: string }>;
}) {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee) redirect("/signup/complete?repair=1");
  const canComp = sessionCan(session, "compensation.read_self"),
    canPay = sessionCan(session, "payroll.read_self");
  if (!canComp && !canPay) redirect("/dashboard");
  const filters = await searchParams,
    supabase = await createClient(),
    today = todayIn(session.organization?.timezone);
  const year =
    filters.year === "all"
      ? 0
      : /^\d{4}$/.test(filters.year ?? "")
        ? Number(filters.year)
        : Number(today.slice(0, 4));
  const page = Math.max(
    1,
    Math.min(100000, Math.trunc(Number(filters.page)) || 1),
  );
  const currency = /^[A-Z]{3}$/.test(filters.currency ?? "")
    ? filters.currency!
    : null;
  const [compResult, componentResult, payResult] = await Promise.all([
    canComp
      ? supabase
          .from("employee_compensation")
          .select(
            "id,amount,currency,pay_type,pay_type_other_label,rate_unit,pay_frequency,standard_weekly_hours,fte,overtime_eligible,pay_group_id,pay_grade_id,source,start_date,end_date,needs_review,compensation_change_reasons(name)",
          )
          .eq("employee_id", session.employee.id)
          .order("start_date", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    canComp
      ? supabase
          .from("employee_compensation_components")
          .select(
            "id,amount,percentage,currency,start_date,end_date,compensation_components(name,component_type,recurrence,value_type)",
          )
          .eq("employee_id", session.employee.id)
          .order("start_date", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    canPay
      ? supabase.rpc("get_my_pay", {
          p_year: year,
          p_currency: currency,
          p_page: page,
        })
      : Promise.resolve({ data: null, error: null }),
  ]);
  const history = compResult.data ?? [],
    current = history.find(
      (c) => c.start_date <= today && (!c.end_date || c.end_date >= today),
    );
  const overview = payResult.data as PayOverview | null;
  const activeComponents = (componentResult.data ?? []).filter(
    (c) => c.start_date <= today && (!c.end_date || c.end_date >= today),
  );
  const groupResult = current?.pay_group_id
    ? await supabase
        .from("pay_groups")
        .select("name,pay_frequency,pay_calendar_id")
        .eq("id", current.pay_group_id)
        .maybeSingle()
    : { data: null, error: null };
  const group = groupResult.data;
  const gradeResult = current?.pay_grade_id
    ? await supabase
        .from("pay_grades")
        .select("name")
        .eq("id", current.pay_grade_id)
        .maybeSingle()
    : { data: null, error: null };
  const periodResult = group?.pay_calendar_id
    ? await supabase
        .from("pay_periods")
        .select(
          "id,period_start,period_end,pay_date,status,timesheet_cutoff_at,approval_deadline_at",
        )
        .eq("pay_calendar_id", group.pay_calendar_id)
        .neq("status", "canceled")
        .gte("pay_date", today)
        .order("pay_date")
        .limit(8)
    : { data: [], error: null };
  const periods = periodResult.data ?? [];
  const error =
    compResult.error ||
    componentResult.error ||
    payResult.error ||
    groupResult.error ||
    gradeResult.error ||
    periodResult.error;
  const href = (n: number) =>
    `/pay?year=${year || "all"}${currency ? `&currency=${currency}` : ""}&page=${n}`;
  return (
    <div className="pay-workspace space-y-6">
      <div className="page-intro">
        <span className="eyebrow">Your pay</span>
        <h1>My pay &amp; compensation</h1>
        <p>
          Review your agreed gross rate, scheduled pay dates and published pay
          records. Pay records show figures imported from your employer’s
          payroll system; they do not confirm a bank transfer.
        </p>
        <Link className="btn-secondary mt-3" href="/pay/queries">
          Ask HR about my pay
        </Link>
      </div>
      {error && (
        <p role="alert" className="alert-error">
          Some pay details could not be loaded. Refresh this page or contact HR
          if this continues.
        </p>
      )}
      {canComp && (
        <>
          <section className="card space-y-4">
            <h2>Current compensation</h2>
            {current ? (
              <>
                <div className="grid gap-4 md:grid-cols-3">
                  <div>
                    <small>Contractual gross rate</small>
                    <h3>{money(current.amount, current.currency)}</h3>
                    <p>
                      {current.rate_unit
                        ? `Per ${current.rate_unit}`
                        : "Rate unit not recorded"}
                    </p>
                  </div>
                  <div>
                    <small>Pay basis</small>
                    <h3>
                      {label(
                        current.pay_type === "other"
                          ? current.pay_type_other_label
                          : current.pay_type,
                      )}
                    </h3>
                    <p>
                      {label(current.pay_frequency ?? group?.pay_frequency)}
                    </p>
                  </div>
                  <div>
                    <small>Next scheduled pay date</small>
                    <h3>{date(periods[0]?.pay_date)}</h3>
                    <p>Planned date; subject to HR confirmation.</p>
                  </div>
                </div>
                {current.needs_review && (
                  <p className="alert-error">
                    HR needs to confirm the pay basis carried over from an older
                    record.
                  </p>
                )}
                <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
                  <div>
                    <dt>Effective from</dt>
                    <dd>{date(current.start_date)}</dd>
                  </div>
                  <div>
                    <dt>Pay group</dt>
                    <dd>{group?.name ?? "Not assigned"}</dd>
                  </div>
                  <div>
                    <dt>Pay grade</dt>
                    <dd>{gradeResult.data?.name ?? "Not assigned"}</dd>
                  </div>
                  <div>
                    <dt>Standard weekly hours</dt>
                    <dd>{current.standard_weekly_hours ?? "Not recorded"}</dd>
                  </div>
                  <div>
                    <dt>FTE</dt>
                    <dd>{current.fte ?? "Not recorded"}</dd>
                  </div>
                  <div>
                    <dt>Overtime eligibility</dt>
                    <dd>
                      {current.overtime_eligible === null
                        ? "Not recorded"
                        : current.overtime_eligible
                          ? "Eligible under assigned policy"
                          : "Not eligible"}
                    </dd>
                  </div>
                </dl>
                <p className="text-sm text-stone-500">
                  This rate and any component assignments describe your
                  compensation terms. They are separate from a pay run’s
                  earnings, deductions and net pay. Approved leave and
                  attendance remain subject to payroll review.
                </p>
              </>
            ) : (
              <p>
                No effective compensation record is available. Contact HR if
                your agreed rate is missing.
              </p>
            )}
          </section>
          <section className="card">
            <h2>Current compensation components</h2>
            <p className="text-sm text-stone-500">
              Assignments may be recurring or one-off. Actual payment appears in
              the published pay record.
            </p>
            <ul className="divide-y">
              {activeComponents.map((c) => {
                const detail = Array.isArray(c.compensation_components)
                  ? c.compensation_components[0]
                  : c.compensation_components;
                return (
                  <li className="py-3" key={c.id}>
                    <strong>{detail?.name ?? "Component"}</strong> ·{" "}
                    {c.percentage !== null
                      ? `${c.percentage}%`
                      : money(c.amount, c.currency)}{" "}
                    · {label(detail?.component_type ?? null)} ·{" "}
                    {label(detail?.recurrence ?? null)}
                    <p className="text-sm">
                      {date(c.start_date)} —{" "}
                      {c.end_date ? date(c.end_date) : "Ongoing"}
                    </p>
                  </li>
                );
              })}
            </ul>
            {!activeComponents.length && (
              <p>No current component assignments.</p>
            )}
          </section>
          <section className="card overflow-x-auto">
            <h2>Scheduled pay periods</h2>
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Timesheet cutoff</th>
                  <th>Approval deadline</th>
                  <th>Pay date</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {periods.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {date(p.period_start)} — {date(p.period_end)}
                    </td>
                    <td>
                      {p.timesheet_cutoff_at
                        ? formatDate(
                            p.timesheet_cutoff_at,
                            session.organization?.timezone,
                          )
                        : "Not set"}
                    </td>
                    <td>
                      {p.approval_deadline_at
                        ? formatDate(
                            p.approval_deadline_at,
                            session.organization?.timezone,
                          )
                        : "Not set"}
                    </td>
                    <td>{date(p.pay_date)}</td>
                    <td>{label(p.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!periods.length && (
              <p>
                No upcoming pay periods have been scheduled for your current pay
                group.
              </p>
            )}
          </section>
        </>
      )}
      {canPay && (
        <section className="card space-y-4 overflow-x-auto">
          <h2>Published pay records</h2>
          <p>
            Open a payslip to print or save it as PDF. “Not supplied” means the
            imported source did not include that amount.
          </p>
          <form className="flex flex-wrap items-end gap-3" method="get">
            <label>
              Pay-date year
              <select
                name="year"
                className="input"
                defaultValue={year || "all"}
              >
                <option value="all">All pay dates</option>
                {(overview?.years ?? [year])
                  .filter((y) => y !== 0)
                  .map((y) => (
                    <option key={y}>{y}</option>
                  ))}
              </select>
            </label>
            <label>
              Currency
              <select
                name="currency"
                className="input"
                defaultValue={currency ?? ""}
              >
                <option value="">All currencies</option>
                {(overview?.currencies ?? []).map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <button className="btn-secondary">Apply filters</button>
          </form>
          {!!overview?.totals.length && (
            <>
              <h3>{year || "All pay dates"} totals for available records</h3>
              <p className="text-sm text-stone-500">
                Grouped by currency and pay date. Corrections replace earlier
                amounts. These totals cover records available in HaloManage and
                are not a tax certificate or a complete employment earnings
                statement.
              </p>
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th>Currency</th>
                    <th>Records</th>
                    <th>Gross</th>
                    <th>Tax</th>
                    <th>Other deductions</th>
                    <th>Net</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.totals.map((t) => (
                    <tr key={t.currency}>
                      <td>{t.currency}</td>
                      <td>{t.records}</td>
                      <td>{money(t.gross, t.currency)}</td>
                      <td>{money(t.tax, t.currency)}</td>
                      <td>{money(t.other_deductions, t.currency)}</td>
                      <td>{money(t.net, t.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th>Pay date</th>
                <th>Period</th>
                <th>Gross</th>
                <th>Tax</th>
                <th>Other deductions</th>
                <th>Net</th>
                <th>Payslip</th>
              </tr>
            </thead>
            <tbody>
              {overview?.records.map((r) => (
                <tr key={r.id}>
                  <td>{date(r.snapshot.pay_date)}</td>
                  <td>
                    {date(r.snapshot.pay_period_start)} —{" "}
                    {date(r.snapshot.pay_period_end)}
                  </td>
                  <td>{money(r.snapshot.gross_pay, r.snapshot.currency)}</td>
                  <td>{money(r.snapshot.tax, r.snapshot.currency)}</td>
                  <td>
                    {money(r.snapshot.other_deductions, r.snapshot.currency)}
                  </td>
                  <td>{money(r.snapshot.net_pay, r.snapshot.currency)}</td>
                  <td>
                    <Link className="text-royal-700" href={`/payslips/${r.id}`}>
                      View{r.replaces_id ? " correction" : ""}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!overview?.records.length && (
            <p>
              No published pay records match these filters. If a payment or an
              earlier record is missing, ask HR through a pay query.
            </p>
          )}
          {overview && overview.total > 24 && (
            <nav className="flex gap-4" aria-label="Pay record pages">
              {page > 1 && <Link href={href(page - 1)}>Previous page</Link>}
              <span>
                Page {page} · {overview.total} records
              </span>
              {page * 24 < overview.total && (
                <Link href={href(page + 1)}>Next page</Link>
              )}
            </nav>
          )}
        </section>
      )}
      {canComp && (
        <section className="card overflow-x-auto">
          <h2>Compensation history and planned changes</h2>
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th>Effective dates</th>
                <th>Basis / frequency</th>
                <th>Gross rate</th>
                <th>Reason</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {history.map((c) => {
                const reason = Array.isArray(c.compensation_change_reasons)
                  ? c.compensation_change_reasons[0]
                  : c.compensation_change_reasons;
                return (
                  <tr key={c.id}>
                    <td>
                      {date(c.start_date)} —{" "}
                      {c.end_date ? date(c.end_date) : "Ongoing"}
                    </td>
                    <td>
                      {label(
                        c.pay_type === "other"
                          ? c.pay_type_other_label
                          : c.pay_type,
                      )}{" "}
                      / {label(c.pay_frequency)}
                    </td>
                    <td>
                      {money(c.amount, c.currency)}
                      {c.rate_unit ? ` per ${c.rate_unit}` : ""}
                    </td>
                    <td>{reason?.name ?? "Not recorded"}</td>
                    <td>
                      {c.start_date > today
                        ? "Planned"
                        : c.end_date && c.end_date < today
                          ? "Previous"
                          : "Current"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!history.length && <p>No compensation history is recorded.</p>}
        </section>
      )}
    </div>
  );
}
