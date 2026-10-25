import Link from "next/link";
import { redirect } from "next/navigation";
import { LeaveRequestForm } from "@/components/LeaveRequestForm";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { statusBadgeClass } from "@/lib/ui";
import { todayIn } from "@/lib/timezone";
import type { LeaveType } from "@/lib/supabase/types";

export default async function LeavePage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.employee || !session.organizationId) redirect("/signup/complete?repair=1");
  const client = await createClient(); const org = session.organizationId; const emp = session.employee.id; const today = todayIn(session.organization?.timezone);
  const results = await Promise.all([
    client.from("leave_types").select("*").eq("organization_id", org).eq("is_active", true).order("name"),
    client.from("leave_requests").select("id, leave_type_id, start_date, end_date, total_days, day_part, status, submitted_at, cancellation_requested_at, cancellation_decided_at, leave_types(name)").eq("employee_id", emp).order("submitted_at", { ascending: false }),
    client.from("leave_balance_v").select("balance, reserved, available_balance, leave_type_id, leave_type_name").eq("employee_id", emp),
    client.from("leave_ledger").select("id, leave_type_id, entry_type, amount, effective_date, note, created_at").eq("employee_id", emp).order("created_at", { ascending: false }).limit(100),
  ]);
  const [types, requests, balances, ledger] = results;
  const errors = results.flatMap(r => r.error ? [r.error.message] : []);
  const pending = (requests.data ?? []).filter(r => r.status.startsWith("pending") || r.status === "submitted");
  const names = new Map((types.data ?? []).map(t => [t.id, t.name]));
  const canReview = sessionCan(session,"leave.approve_direct_reports") || sessionCan(session,"leave.approve_unit") || sessionCan(session,"leave.manage_policies");
  return <div className="space-y-6">
    <div className="page-intro"><span className="eyebrow">Time away</span><h1>Your leave, clearly recorded.</h1><p>Review days and balances, request time away, follow approvals and keep a record of each change. Dates follow your organization&apos;s timezone ({session.organization?.timezone}).</p><div className="flex flex-wrap gap-3 mt-3">{canReview && <Link className="btn-secondary" href="/leave/review">Review team leave &amp; calendar</Link>}{sessionCan(session,"leave.manage_policies") && <Link className="btn-secondary" href="/admin/leave-types">Configure leave rules</Link>}</div></div>
    {errors.length > 0 && <p className="alert-error" role="alert">Some leave information could not load: {errors.join(" · ")}</p>}
    <div className="leave-balance-grid">{(types.data ?? []).map(t => { const b = (balances.data ?? []).find(b => b.leave_type_id === t.id); return <div className="metric-card" key={t.id}><div><small>{t.name}</small><strong>{t.balance_tracked ? Number(b?.available_balance ?? 0).toLocaleString(undefined,{ maximumFractionDigits: 2 }) : "Untracked"}</strong><em>{t.balance_tracked ? `days available · ${b?.reserved ?? 0} pending` : "Approval and policy rules still apply"}</em>{t.balance_tracked && <p className="field-help">Booked balance: {b?.balance ?? 0} days</p>}</div></div>; })}<div className="metric-card"><div><small>Pending requests</small><strong>{pending.length}</strong><em>not yet confirmed time off</em></div></div></div>
    <p className="field-help">Available = effective ledger balance minus pending reservations. Approved leave has already been deducted. Future-dated credits become usable on their effective date.</p>
    <div className="grid gap-6 xl:grid-cols-[390px_minmax(0,1fr)]"><div>{!sessionCan(session,"leave.request_self") ? <section className="card">Your current role cannot submit leave. Ask HR to review your access.</section> : (types.data ?? []).length ? <LeaveRequestForm leaveTypes={types.data as LeaveType[]} organizationId={org} employeeId={emp} /> : <section className="card">No active leave types are configured. HR can set these up under Leave rules.</section>}</div>
    <section className="card overflow-x-auto"><h2 className="mb-4 font-semibold">Request history</h2><table className="w-full text-sm"><thead><tr className="text-left border-b"><th className="p-2">Type</th><th>Dates</th><th>Days</th><th>Status</th><th>Details</th></tr></thead><tbody>{(requests.data ?? []).map(r => <tr key={r.id} className="border-b"><td className="p-2">{(r.leave_types as unknown as { name: string })?.name ?? names.get(r.leave_type_id) ?? "Leave"}</td><td>{r.start_date} → {r.end_date}{r.day_part !== "full" && <small className="block">{r.day_part === "am" ? "First half shift" : "Second half shift"}</small>}</td><td>{r.total_days}</td><td><span className={`badge ${statusBadgeClass(r.status)}`}>{r.status.replaceAll("_"," ")}</span>{r.cancellation_requested_at && !r.cancellation_decided_at && <small className="block">Cancellation awaiting review</small>}</td><td><Link className="table-action" href={`/leave/${r.id}`}>View request</Link></td></tr>)}</tbody></table>{!requests.data?.length && !requests.error && <p className="list-empty">No leave requests yet. Review dates before submitting your first request.</p>}</section></div>
    <section className="card overflow-x-auto"><h2 className="font-semibold mb-3">Balance activity</h2><p className="field-help mb-3">The latest 100 entries, including opening grants, adjustments, deductions and approved reversals. Inactive leave types retain their history.</p><table className="w-full text-sm"><thead><tr className="text-left border-b"><th className="p-2">Effective date</th><th>Type</th><th>Entry</th><th>Days</th><th>Reference</th></tr></thead><tbody>{(ledger.data ?? []).map(l => <tr key={l.id} className="border-b"><td className="p-2">{l.effective_date}{l.effective_date > today && " (future)"}</td><td>{names.get(l.leave_type_id) ?? "Archived leave type"}</td><td>{l.entry_type.replaceAll("_"," ")}</td><td>{Number(l.amount)>0 ? "+" : ""}{l.amount}</td><td>{l.note ?? "Recorded by the leave workflow"}</td></tr>)}</tbody></table>{!ledger.data?.length && <p className="list-empty">No ledger entries recorded.</p>}</section>
  </div>;
}
