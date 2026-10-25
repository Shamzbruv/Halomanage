import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession } from "@/lib/session";
import { LeaveDecisionButtons, LeaveRequestActions } from "@/components/LeaveDecisionButtons";
import { formatDateTime } from "@/lib/timezone";

type Context = { request: { id: string; employee_id: string; status: string; start_date: string; end_date: string; total_days: number; day_part: string; reason: string | null; submitted_at: string; policy_snapshot: { is_paid: boolean; day_count_basis: string } | null; cancellation_requested_at: string | null; cancellation_reason: string | null; cancellation_decided_at: string | null; cancellation_decision_note: string | null };
 employee_name: string; leave_type: { name: string; is_paid: boolean; day_count_basis: string }; permissions: { can_decide: boolean; can_cancel_review: boolean; can_reroute: boolean }; attachment: { path: string; name: string } | null;
 days: { work_date: string; day_fraction: number; scheduled_minutes: number | null }[]; approvals: { id: string; sequence: number; approver_name: string; status: string; decided_at: string | null; note: string | null }[]; ledger: { entry_type: string; amount: number; effective_date: string }[] };
export default async function LeaveRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession(); if (!session) redirect("/login");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return <section className="card">Leave request unavailable. <Link href="/leave">Back to Leave</Link></section>;
  const { data, error } = await (await createClient()).rpc("get_leave_request", { p_request_id: id });
  const ctx = data as Context | null;
  if (error || !ctx) return <section className="card"><p role="alert">This leave request is unavailable or outside your authorized scope.</p><Link className="table-action" href="/leave">Back to Leave</Link></section>;
  const r = ctx.request; const own = r.employee_id === session.employee?.id; const pendingCancel = !!r.cancellation_requested_at && !r.cancellation_decided_at;
  const policy = r.policy_snapshot ?? ctx.leave_type;
  return <div className="space-y-6"><div className="page-intro"><span className="eyebrow">Leave request</span><h1>{ctx.employee_name} · {ctx.leave_type.name}</h1><p>{r.start_date} → {r.end_date} · {r.total_days} day(s) · {r.status.replaceAll("_"," ")}</p><div className="flex gap-4 mt-3"><Link className="table-action" href="/leave">My leave</Link><Link className="table-action" href="/leave/review">Team leave</Link></div></div>
    <section className="card space-y-3"><h2 className="font-semibold">Request facts</h2><p>{policy.is_paid ? "Paid" : "Unpaid"} · {policy.day_count_basis === "calendar_days" ? "Calendar days" : "Scheduled working days"} · {r.day_part === "full" ? "Full days" : r.day_part === "am" ? "First half of shift" : "Second half of shift"}</p><p>Submitted {formatDateTime(r.submitted_at, session.organization?.timezone)}</p>{r.reason && <p>Employee reason: {r.reason}</p>}<p className="field-help">Requests retain the policy and charged-day facts from submission. Approval is independent; approved cancellations restore only days actually deducted.</p>
      <table className="w-full text-sm"><thead><tr className="text-left border-b"><th>Charged date</th><th>Day fraction</th><th>Scheduled hours of leave</th></tr></thead><tbody>{ctx.days.map(d => <tr key={d.work_date} className="border-b"><td className="py-2">{d.work_date}</td><td>{d.day_fraction}</td><td>{d.scheduled_minutes == null ? "Legacy record" : ((d.day_fraction === 0.5 ? (r.day_part === "am" ? Math.floor(d.scheduled_minutes/2) : Math.ceil(d.scheduled_minutes/2)) : d.scheduled_minutes)/60).toFixed(2)}</td></tr>)}</tbody></table>
    </section>
    <section className="card space-y-3"><h2 className="font-semibold">Approval history</h2>{ctx.approvals.map(a => <div key={a.id} className="rounded-lg border p-3"><strong>Step {a.sequence}: {a.approver_name}</strong><p>{a.status}{a.decided_at ? ` · ${formatDateTime(a.decided_at, session.organization?.timezone)}` : ""}</p>{a.note && <p>Review note: {a.note}</p>}</div>)}{ctx.approvals.length === 0 && <p>This type is configured for automatic approval.</p>}{ctx.permissions.can_decide && <LeaveDecisionButtons leaveRequestId={id} />}
      {!own && ctx.permissions.can_reroute && r.status.startsWith("pending") && <LeaveRequestActions id={id} status={r.status} cancellationPending={false} canReroute={true} />}
    </section>
    {pendingCancel && <section className="card space-y-3"><h2 className="font-semibold">Cancellation awaiting review</h2><p>{r.cancellation_reason}</p><p>The leave remains approved while this decision is pending.</p>{ctx.permissions.can_cancel_review && <LeaveDecisionButtons leaveRequestId={id} cancellation />}</section>}
    {r.cancellation_decided_at && <section className="card"><h2 className="font-semibold">Cancellation {r.status === "cancelled" ? "approved" : "declined"}</h2><p>{r.cancellation_decision_note}</p><small>{formatDateTime(r.cancellation_decided_at, session.organization?.timezone)}</small></section>}
    {(own || ctx.attachment) && <section className="card"><h2 className="font-semibold mb-3">{own ? "Manage this request" : "Supporting evidence"}</h2><LeaveRequestActions id={id} status={own ? r.status : "read_only"} cancellationPending={pendingCancel} canReroute={false} attachment={ctx.attachment} /></section>}
    <section className="card"><h2 className="font-semibold mb-3">Linked balance entries</h2>{ctx.ledger.map((l,i) => <p key={i}>{l.effective_date} · {l.entry_type.replaceAll("_"," ")} · {l.amount} days</p>)}{ctx.ledger.length === 0 && <p>No balance deduction has been posted for this request.</p>}</section>
  </div>;
}
