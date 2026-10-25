import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { todayIn } from "@/lib/timezone";
import { AttendancePeriodControls, AttendancePeriodCreate, TimesheetActions } from "@/components/attendance/TimesheetActions";

type Snapshot = { regular_minutes: number; overtime_minutes: number; paid_leave_minutes: number; unpaid_leave_minutes: number; deducted_minutes: number; makeup_minutes: number; issues: number;
  sessions: { id: string; date: string; worked: number; overtime: number; overtime_status: string }[];
  leave: { id: string; date: string; minutes: number; paid: boolean }[] };
type Sheet = { id: string; employee_id: string; employee_name: string; employee_number: string; status: string; revision: number; snapshot: Snapshot | null; decision_note: string | null };
const hours = (n: number | undefined) => ((n ?? 0) / 60).toFixed(2);

export default async function TimesheetsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.organizationId || !session.employee) redirect("/dashboard");
  const params = await searchParams;
  const manage = sessionCan(session, "attendance.adjust_org");
  const review = manage || sessionCan(session, "attendance.adjust_team");
  const canExport = sessionCan(session, "payroll.export");
  const canViewTeam = canExport || review || sessionCan(session, "attendance.read_org") || sessionCan(session, "attendance.read_team");
  const team = params.view === "team" && canViewTeam;
  const client = await createClient();
  const { data: periods, error: periodError } = await client.from("attendance_periods").select("id, name, period_start, period_end, status").eq("organization_id", session.organizationId).order("period_start", { ascending: false });
  const period = (periods ?? []).find(p => p.id === params.period) ?? periods?.[0];
  let query = client.from("attendance_timesheets").select("id, employee_id, employee_name, employee_number, status, revision, snapshot, decision_note").eq("period_id", period?.id ?? "00000000-0000-0000-0000-000000000000").order("employee_name");
  if (!team) query = query.eq("employee_id", session.employee.id);
  const { data, error: sheetError } = await query;
  const sheets = (data ?? []) as Sheet[];
  const selected = sheets.find(s => s.id === params.sheet) ?? sheets[0];
  const preview = selected ? await client.rpc("preview_attendance_timesheet", { p_timesheet_id: selected.id }) : null;
  const live = preview?.data as Snapshot | null;
  const reviewCheck = selected && review ? await client.rpc("can_review_attendance_timesheet", { p_timesheet_id: selected.id }) : null;
  const employees = manage && team ? await client.from("employees").select("id, first_name, last_name, employee_number").eq("organization_id", session.organizationId).order("last_name") : null;
  const error = periodError?.message ?? sheetError?.message ?? preview?.error?.message ?? reviewCheck?.error?.message ?? employees?.error?.message;
  const href = (p: string, s?: string) => `/time/timesheets?period=${p}${team ? "&view=team" : ""}${s ? `&sheet=${s}` : ""}`;
  return <div className="space-y-6">
    <div className="page-intro"><span className="eyebrow">Time &amp; attendance</span><h1>Timesheet review</h1><p>Confirm hours for a completed period, obtain an independent approval, then lock and export the approved hours for your external payroll process.</p><div className="flex flex-wrap gap-3 mt-3"><Link className="table-action" href="/time">My attendance</Link>{canViewTeam && <><Link className="table-action" href="/time/timesheets">My timesheets</Link><Link className="table-action" href="/time/timesheets?view=team">Team review</Link><Link className="table-action" href="/team/attendance">Resolve attendance issues</Link></>}</div></div>
    {error && <div className="alert-error" role="alert">Timesheet information could not be loaded: {error}</div>}
    {manage && team && <section className="card"><h2 className="mb-3">Create a review period</h2><p className="field-help mb-3">Use the dates of your pay period (maximum 62 days). Review periods cannot overlap. The initial roster includes employees employed during those dates and anyone with recorded attendance.</p><AttendancePeriodCreate organizationId={session.organizationId} /></section>}
    {!period ? <section className="card"><p>No review periods have been created. HR creates periods before employees can sign their hours.</p></section> : <>
      <section className="card space-y-3"><form method="get" action="/time/timesheets" className="flex flex-wrap gap-3">{team && <input type="hidden" name="view" value="team" />}<label className="label" htmlFor="review-period">Review period</label><select id="review-period" className="input max-w-lg" name="period" defaultValue={period.id}>{periods?.map(p => <option key={p.id} value={p.id}>{p.name} · {p.period_start} to {p.period_end} · {p.status}</option>)}</select><button className="btn-secondary">View period</button></form><p><strong>{period.name}</strong> · {period.period_start} to {period.period_end} · <span className="badge badge-neutral">{period.status}</span></p>
        {team && <AttendancePeriodControls id={period.id} locked={period.status === "locked"} canManage={manage} canExport={canExport} employees={(employees?.data ?? []).map(e => ({ id: e.id, name: `${e.first_name} ${e.last_name} · ${e.employee_number}` }))} />}
      </section>
      <section className="card overflow-x-auto"><h2 className="mb-3">{team ? "Employee sign-offs" : "Your timesheet"}</h2><table className="w-full text-sm"><thead><tr className="text-left border-b"><th className="p-2">Employee</th><th>Status</th><th>Revision</th><th>Regular hours</th><th>Approved OT</th><th>Review</th></tr></thead><tbody>{sheets.map(s => <tr key={s.id} className="border-b"><td className="p-2">{s.employee_name}<small className="block">{s.employee_number}</small></td><td>{s.status}</td><td>{s.revision}</td><td>{s.snapshot ? hours(s.snapshot.regular_minutes) : "—"}</td><td>{s.snapshot ? hours(s.snapshot.overtime_minutes) : "—"}</td><td><Link className="table-action" href={href(period.id, s.id)}>View hours</Link></td></tr>)}</tbody></table>{!sheets.length && <p className="list-empty">No timesheets are visible for you in this period. HR can check the roster.</p>}<p className="field-help mt-3">Hours in this table are the last signed snapshot. Open a timesheet to compare its current attendance before approving.</p></section>
      {selected && live && <section className="card space-y-4"><h2>{selected.employee_name} — hours to review</h2>{selected.decision_note && <p className="alert-warning">Review note: {selected.decision_note}</p>}
        {live.issues > 0 && <p className="alert-warning" role="status">{live.issues} unresolved attendance or leave issues. Resolve them before employee sign-off.</p>}
        {selected.snapshot && JSON.stringify(selected.snapshot) !== JSON.stringify(live) && <p className="alert-warning">Attendance changed since the last signature. Withdraw or return this timesheet, then obtain a new employee signature.</p>}
        <dl className="grid gap-4 md:grid-cols-3">{[["Regular hours", live.regular_minutes], ["Approved overtime", live.overtime_minutes], ["Paid leave", live.paid_leave_minutes], ["Unpaid leave", live.unpaid_leave_minutes], ["Deduction reference", live.deducted_minutes], ["Make-up credit", live.makeup_minutes]].map(([label, value]) => <div key={label as string}><dt>{label}</dt><dd className="text-xl font-semibold">{hours(value as number)} h</dd></div>)}</dl>
        <p className="field-help">Regular time excludes overtime and separately reported make-up credit. Deduction reference minutes are already reflected in worked time where applicable; do not deduct them twice. No pay, tax or statutory deductions are calculated here.</p>
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left border-b"><th>Date</th><th>Worked hours</th><th>Overtime hours</th><th>OT decision</th></tr></thead><tbody>{live.sessions.map(s => <tr key={s.id} className="border-b"><td className="py-2">{s.date}</td><td>{hours(s.worked)}</td><td>{hours(s.overtime)}</td><td>{s.overtime_status}</td></tr>)}</tbody></table></div>
        {live.leave.length > 0 && <div><h3>Approved leave</h3>{live.leave.map(l => <p key={l.id}>{l.date} · {hours(l.minutes)} h · {l.paid ? "paid" : "unpaid"}</p>)}</div>}
        {period.status !== "locked" && <TimesheetActions id={selected.id} status={selected.status} own={selected.employee_id === session.employee.id} review={reviewCheck?.data === true} ended={period.period_end < todayIn(session.organization?.timezone)} />}
      </section>}
    </>}
  </div>;
}
