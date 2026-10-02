import Link from "next/link";
import { CsvDownloadButton } from "@/components/reports/CsvDownloadButton";
import { createClient } from "@/lib/supabase/server";
import { addDaysToDate, formatDate, formatMinutes, todayIn } from "@/lib/timezone";

type Row = {
  employee_id: string; employee_name: string; employee_number: string | null; department: string | null;
  days_worked: number; worked_minutes: number; late_count: number; absent_count: number;
  missing_clock_out_count: number; early_departure_count: number; overtime_minutes: number; overtime_pending_minutes: number;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const label = (date: string) => formatDate(`${date}T12:00:00Z`, "UTC", { month: "short", day: "numeric", year: "numeric" });

// Organization-wide attendance for a period (attendance_report()): worked
// time, lateness, absences, missing clock-outs, early departures and
// overtime per person. Patterns only — no scores or rankings.
export async function AttendanceReport({ organizationId, timezone, params }: { organizationId: string; timezone: string | null | undefined; params: Record<string, string | string[] | undefined> }) {
  const supabase = await createClient();
  const today = todayIn(timezone);
  const pick = (key: string) => (typeof params[key] === "string" && ISO_DATE.test(params[key] as string) ? (params[key] as string) : null);
  let to = pick("att_to") ?? today;
  let from = pick("att_from") ?? `${today.slice(0, 8)}01`;
  if (from > to) [from, to] = [to, from];
  if (addDaysToDate(from, 62) < to) from = addDaysToDate(to, -62);
  const unit = typeof params.att_unit === "string" && /^[0-9a-f-]{36}$/i.test(params.att_unit) ? params.att_unit : null;

  const [{ data, error }, { data: units }] = await Promise.all([
    supabase.rpc("attendance_report", { p_organization_id: organizationId, p_from: from, p_to: to, p_org_unit_id: unit }),
    supabase.from("org_units").select("id, name").eq("organization_id", organizationId).order("name"),
  ]);
  const rows = (data ?? []) as Row[];
  const total = (key: keyof Row) => rows.reduce((sum, r) => sum + Number(r[key] ?? 0), 0);

  const monthStart = `${today.slice(0, 8)}01`;
  const lastMonthEnd = addDaysToDate(monthStart, -1);
  const presets = [
    { label: "This month", from: monthStart, to: today },
    { label: "Last month", from: `${lastMonthEnd.slice(0, 8)}01`, to: lastMonthEnd },
    { label: "Last 14 days", from: addDaysToDate(today, -13), to: today },
  ];
  const presetHref = (p: { from: string; to: string }) => `/admin/reports?att_from=${p.from}&att_to=${p.to}${unit ? `&att_unit=${unit}` : ""}#attendance`;

  return (
    <section className="card overflow-x-auto" id="attendance">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-stone-900">Attendance · {label(from)} – {label(to)}</h2>
          <p className="text-xs text-stone-500">Worked time is after breaks. Absences exclude approved leave and holidays. Overtime counts approved and pending time. For the day-by-day picture, use Team attendance.</p>
        </div>
        <CsvDownloadButton
          filename={`attendance-${from}-to-${to}.csv`}
          headers={["Employee", "Employee number", "Department", "Days worked", "Hours worked", "Late", "No clock-in", "Missing clock-out", "Early departures", "Overtime hours", "Overtime awaiting approval (hours)"]}
          rows={rows.map((r) => [r.employee_name, r.employee_number, r.department, r.days_worked, (r.worked_minutes / 60).toFixed(2), r.late_count, r.absent_count, r.missing_clock_out_count, r.early_departure_count, (r.overtime_minutes / 60).toFixed(2), (r.overtime_pending_minutes / 60).toFixed(2)])}
        />
      </div>
      <div className="filter-chips mb-3">{presets.map((p) => <Link key={p.label} className={p.from === from && p.to === to ? "active" : ""} href={presetHref(p)}>{p.label}</Link>)}</div>
      <form className="attendance-toolbar" method="get" action="/admin/reports#attendance">
        <div><label className="label" htmlFor="att-from">From</label><input id="att-from" className="input" type="date" name="att_from" defaultValue={from} max={today} /></div>
        <div><label className="label" htmlFor="att-to">To</label><input id="att-to" className="input" type="date" name="att_to" defaultValue={to} max={today} /></div>
        <div><label className="label" htmlFor="att-unit">Department</label><select id="att-unit" className="input" name="att_unit" defaultValue={unit ?? ""}><option value="">All departments</option>{(units ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
        <button className="btn-secondary" type="submit">Update</button>
      </form>
      {error && <p className="alert-error" role="alert">{error.message}</p>}
      <table className="w-full text-sm">
        <thead><tr className="border-b border-stone-100 text-left text-xs uppercase text-stone-400"><th className="pb-2">Employee</th><th className="pb-2">Department</th><th className="pb-2">Days</th><th className="pb-2">Worked</th><th className="pb-2">Late</th><th className="pb-2">No clock-in</th><th className="pb-2">Missing out</th><th className="pb-2">Left early</th><th className="pb-2">Overtime</th></tr></thead>
        <tbody className="divide-y divide-stone-100">
          {rows.length === 0 && !error && <tr><td colSpan={9} className="py-4 text-stone-400">No one matches this filter.</td></tr>}
          {rows.map((r) => (
            <tr key={r.employee_id}>
              <td className="py-2 font-medium text-stone-900">{r.employee_name}<small className="block text-stone-500">{r.employee_number ?? ""}</small></td>
              <td className="py-2 text-stone-600">{r.department ?? "—"}</td>
              <td className="py-2">{r.days_worked}</td>
              <td className="py-2">{formatMinutes(r.worked_minutes)}</td>
              <td className="py-2">{r.late_count || "—"}</td>
              <td className="py-2">{r.absent_count || "—"}</td>
              <td className="py-2">{r.missing_clock_out_count || "—"}</td>
              <td className="py-2">{r.early_departure_count || "—"}</td>
              <td className="py-2">{r.overtime_minutes ? formatMinutes(r.overtime_minutes) : "—"}{r.overtime_pending_minutes > 0 && <small className="block text-stone-500">{formatMinutes(r.overtime_pending_minutes)} pending</small>}</td>
            </tr>
          ))}
        </tbody>
        {rows.length > 0 && (
          <tfoot><tr className="border-t border-stone-200 font-medium"><td className="pt-2">Total</td><td /><td className="pt-2">{total("days_worked")}</td><td className="pt-2">{formatMinutes(total("worked_minutes"))}</td><td className="pt-2">{total("late_count")}</td><td className="pt-2">{total("absent_count")}</td><td className="pt-2">{total("missing_clock_out_count")}</td><td className="pt-2">{total("early_departure_count")}</td><td className="pt-2">{formatMinutes(total("overtime_minutes"))}</td></tr></tfoot>
        )}
      </table>
    </section>
  );
}
