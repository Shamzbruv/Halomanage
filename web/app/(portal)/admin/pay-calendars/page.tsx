import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { NewPayCalendarForm } from "@/components/compensation/NewPayCalendarForm";
import { GeneratePayPeriodsForm } from "@/components/compensation/GeneratePayPeriodsForm";

export default async function PayCalendarsPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.organizationId) redirect("/dashboard");
  const canRead = sessionCan(session, "pay_calendar.read") || sessionCan(session, "pay_calendar.manage");
  const canManage = sessionCan(session, "pay_calendar.manage");
  if (!canRead) redirect("/dashboard");

  const supabase = await createClient();
  const orgId = session.organizationId;

  const [{ data: calendars }, { data: payGroups }, { data: periods }] = await Promise.all([
    supabase.from("pay_calendars").select("*, pay_groups(name)").eq("organization_id", orgId).order("name"),
    supabase.from("pay_groups").select("id, name, pay_frequency").eq("organization_id", orgId).eq("is_active", true).order("name"),
    supabase.from("pay_periods").select("*").eq("organization_id", orgId).order("period_start", { ascending: false }),
  ]);

  return (
    <div className="space-y-6">
      <div className="admin-page-head">
        <div className="page-intro">
          <span className="eyebrow">Scheduling</span>
          <h1>Pay calendars &amp; periods.</h1>
          <p>Weekly, biweekly, semimonthly, monthly, or custom — generating periods is pure date scheduling, never a payroll calculation.</p>
        </div>
        {canManage && <NewPayCalendarForm organizationId={orgId} payGroups={payGroups ?? []} />}
      </div>

      {(calendars ?? []).length === 0 && (
        <div className="card"><p className="text-sm text-stone-400">No pay calendars yet.</p></div>
      )}

      {(calendars ?? []).map((calendar) => {
        const calendarPeriods = (periods ?? []).filter((p) => p.pay_calendar_id === calendar.id);
        return (
          <section key={calendar.id} className="card overflow-x-auto">
            <div className="mb-1 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-stone-900">{calendar.name}</h2>
                <p className="text-xs text-stone-500">{calendar.pay_frequency} · {calendar.pay_groups?.name ?? "no pay group assigned"}</p>
              </div>
              {canManage && <GeneratePayPeriodsForm calendarId={calendar.id} />}
            </div>

            {calendarPeriods.length === 0 && (
              <div className="mt-4 rounded-xl border border-dashed border-stone-200 bg-cream-50 p-4 text-sm text-stone-500">
                This calendar has no pay periods yet — nothing will show on anyone&apos;s pay page until some exist.
                {canManage ? " Use “Generate periods” above to build its schedule." : " Ask an administrator to generate its schedule."}
              </div>
            )}

            {calendarPeriods.length > 0 && (
              <table className="mt-4 w-full text-sm">
                <thead>
                  <tr className="border-b border-stone-100 text-left text-xs uppercase text-stone-400">
                    <th className="pb-2">Period</th><th className="pb-2">Timesheet cutoff</th><th className="pb-2">Approval deadline</th><th className="pb-2">Export deadline</th><th className="pb-2">Pay date</th><th className="pb-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {calendarPeriods.map((p) => (
                    <tr key={p.id}>
                      <td className="py-2">{p.period_start} → {p.period_end}</td>
                      <td className="py-2 text-xs text-stone-500">{p.timesheet_cutoff_at ? new Date(p.timesheet_cutoff_at).toLocaleDateString() : "—"}</td>
                      <td className="py-2 text-xs text-stone-500">{p.approval_deadline_at ? new Date(p.approval_deadline_at).toLocaleDateString() : "—"}</td>
                      <td className="py-2 text-xs text-stone-500">{p.payroll_export_deadline_at ? new Date(p.payroll_export_deadline_at).toLocaleDateString() : "—"}</td>
                      <td className="py-2 font-medium text-stone-900">{p.pay_date}</td>
                      <td className="py-2 text-xs">{p.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}
    </div>
  );
}
