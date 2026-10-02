import Link from "next/link";
import { redirect } from "next/navigation";
import { DecideRecordRequest } from "@/components/DecideRecordRequest";
import { CORRECTABLE_FIELDS, REQUEST_STATUS_LABELS, type RecordRequest } from "@/lib/recordRequests";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime } from "@/lib/timezone";

// HR's queue of employee record requests: corrections ("my date of birth
// is wrong") and formal requests for a copy of their information.
export default async function EmployeeRecordRequestsPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!sessionCan(session, "employee.manage")) redirect("/dashboard");
  if (!session.organizationId) redirect("/dashboard");
  const timezone = session.organization?.timezone;

  const supabase = await createClient();
  const [{ data: requests }, { data: employees }] = await Promise.all([
    supabase.from("employee_record_requests").select("*").eq("organization_id", session.organizationId).order("requested_at", { ascending: false }).limit(200),
    supabase.from("employees").select("id, first_name, last_name, preferred_name, employee_number").eq("organization_id", session.organizationId),
  ]);
  const personById = new Map((employees ?? []).map((e) => [e.id, e]));
  const all = (requests ?? []) as (RecordRequest & { employee_id: string })[];
  const pending = all.filter((r) => r.status === "pending");
  const decided = all.filter((r) => r.status !== "pending").slice(0, 50);

  function row(r: RecordRequest & { employee_id: string }, actionable: boolean) {
    const person = personById.get(r.employee_id);
    const autoApplies = CORRECTABLE_FIELDS.find((f) => f.key === r.field_key)?.applied ?? false;
    return (
      <li key={r.id} className="flex flex-wrap items-start justify-between gap-4 py-3 text-sm">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-stone-900">
            {person ? <Link className="text-royal-700 hover:underline" href={`/admin/employees/${person.id}`}>{person.preferred_name || person.first_name} {person.last_name}</Link> : "Employee"}
            <span className="ml-2 font-mono text-xs text-stone-400">{person?.employee_number}</span>
          </p>
          <p className="text-stone-700">{r.kind === "data_access" ? "Requests a copy of their personal information" : `Correct ${r.field_label?.toLowerCase()}`}</p>
          {r.kind === "correction" && (
            <p className="text-xs text-stone-600">On file: <strong>{r.current_value ?? "—"}</strong> → Requested: <strong>{r.requested_value}</strong></p>
          )}
          {r.reason && <p className="text-xs text-stone-500">“{r.reason}”</p>}
          <p className="text-xs text-stone-400">{formatDateTime(r.requested_at, timezone, { dateStyle: "medium", timeStyle: "short" })}</p>
          {!actionable && <p className="text-xs text-stone-500">{REQUEST_STATUS_LABELS[r.status]}{r.applied ? " · applied to record" : ""}{r.decision_note ? ` · “${r.decision_note}”` : ""}</p>}
          {actionable && r.kind === "correction" && !autoApplies && person && (
            <p className="mt-1 text-xs text-amber-700">Make this change in the <Link className="underline" href={`/admin/employees/${person.id}?tab=employment`}>employee&apos;s record</Link> first, then mark it corrected.</p>
          )}
        </div>
        {actionable ? <DecideRecordRequest requestId={r.id} autoApplies={autoApplies} kind={r.kind} /> : <span className={`badge ${r.status === "approved" ? "badge-emerald" : r.status === "rejected" ? "badge-ruby" : "badge-neutral"}`}>{REQUEST_STATUS_LABELS[r.status]}</span>}
      </li>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/employees" className="text-xs text-royal-700 hover:text-royal-800">← People</Link>
        <div className="page-intro mt-2"><span className="eyebrow">Employee requests</span><h1>Corrections and information requests.</h1><p>Employees ask here instead of by message or email, so every change to the official record has a reason, a decision, and an audit trail.</p></div>
      </div>
      <section className="card">
        <h2 className="mb-2 text-sm font-semibold text-stone-900">Waiting for HR ({pending.length})</h2>
        {pending.length === 0 ? <p className="text-sm text-stone-400">Nothing waiting.</p> : <ul className="divide-y divide-stone-100">{pending.map((r) => row(r, true))}</ul>}
      </section>
      <section className="card">
        <h2 className="mb-2 text-sm font-semibold text-stone-900">Recently handled</h2>
        {decided.length === 0 ? <p className="text-sm text-stone-400">None yet.</p> : <ul className="divide-y divide-stone-100">{decided.map((r) => row(r, false))}</ul>}
      </section>
    </div>
  );
}
