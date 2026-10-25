import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { addDaysToDate, todayIn } from "@/lib/timezone";
import { CsvDownloadButton } from "@/components/reports/CsvDownloadButton";

type Row = { id: string; employee_name: string; employee_id: string; leave_type_name: string; start_date: string; end_date: string; total_days: number; status: string; can_decide: boolean; can_cancel_review: boolean; cancellation_requested_at: string | null; cancellation_decided_at: string | null; paid: boolean; day_part: string };
export default async function LeaveReview({ searchParams }: { searchParams: Promise<Record<string,string | string[] | undefined>> }) {
  const session = await getCurrentSession(); if (!session) redirect("/login");
  if (!session.organizationId || !["leave.approve_unit","leave.approve_direct_reports","leave.manage_policies"].some(p => session.permissions.includes(p as typeof session.permissions[number]))) redirect("/leave");
  const q = await searchParams; const today = todayIn(session.organization?.timezone);
  const date = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  const from = date(q.from) ?? addDaysToDate(today,-90); const to = date(q.to) ?? addDaysToDate(today,365);
  const { data, error } = await (await createClient()).rpc("list_leave_requests", { p_organization_id: session.organizationId, p_from: from, p_to: to });
  const rows = (data ?? []) as Row[];
  const waiting = rows.filter(r => r.can_decide || r.can_cancel_review);
  const approved = rows.filter(r => r.status === "approved" && r.end_date >= today).sort((a,b) => a.start_date.localeCompare(b.start_date));
  return <div className="space-y-6"><div className="page-intro"><span className="eyebrow">Leave management</span><h1>Review leave and plan coverage.</h1><p>Only employees in your authorized scope are shown. Pending leave is not confirmed time off. Medical evidence and reasons stay on the private request detail screen.</p><div className="flex gap-3 mt-3"><Link className="table-action" href="/leave">My leave</Link>{sessionCan(session,"leave.manage_policies") && <Link className="table-action" href="/admin/leave-types">Leave rules</Link>}</div></div>
    <form method="get" className="card flex flex-wrap items-end gap-3"><label><span className="label">From</span><input className="input" name="from" type="date" required defaultValue={from} /></label><label><span className="label">To</span><input className="input" name="to" type="date" required defaultValue={to} /></label><button className="btn-secondary">Filter dates</button></form>
    {error && <p className="alert-error" role="alert">Leave records could not load: {error.message}</p>}
    <section className="card"><h2 className="font-semibold mb-3">Needs review · {waiting.length}</h2>{waiting.map(r => <div key={r.id} className="flex flex-wrap justify-between gap-3 border-b py-3"><div><strong>{r.employee_name} · {r.leave_type_name}</strong><p>{r.start_date} → {r.end_date} · {r.total_days} days</p><small>{r.cancellation_requested_at && !r.cancellation_decided_at ? "Cancellation requested" : "Current approval step"}</small></div><Link className="btn-secondary" href={`/leave/${r.id}`}>Review request</Link></div>)}{!waiting.length && <p className="list-empty">No review items in the selected range.</p>}</section>
    <section className="card"><h2 className="font-semibold mb-3">Approved absence calendar</h2>{approved.map(r => <div key={r.id} className="border-b py-3"><Link className="table-action" href={`/leave/${r.id}`}>{r.start_date} → {r.end_date} · {r.employee_name}</Link><p>{r.leave_type_name} · {r.day_part === "full" ? "Full days" : r.day_part === "am" ? "First half shifts" : "Second half shifts"}</p></div>)}{!approved.length && <p className="list-empty">No current or upcoming approved absences in this range.</p>}</section>
    <section className="card overflow-x-auto"><div className="flex flex-wrap justify-between gap-3 mb-3"><h2 className="font-semibold">Leave register</h2><CsvDownloadButton filename={`leave-${from}-${to}.csv`} headers={["Employee","Leave type","Start","End","Days","Part","Status","Paid"]} rows={rows.map(r => [r.employee_name,r.leave_type_name,r.start_date,r.end_date,r.total_days,r.day_part,r.status,r.paid ? "Yes" : "No"])} /></div><table className="w-full text-sm"><thead><tr className="text-left border-b"><th>Employee</th><th>Type</th><th>Dates</th><th>Days</th><th>Status</th></tr></thead><tbody>{rows.map(r => <tr key={r.id} className="border-b"><td className="py-3"><Link className="table-action" href={`/leave/${r.id}`}>{r.employee_name}</Link></td><td>{r.leave_type_name}</td><td>{r.start_date} → {r.end_date}</td><td>{r.total_days}</td><td>{r.status.replaceAll("_"," ")}</td></tr>)}</tbody></table></section>
  </div>;
}
