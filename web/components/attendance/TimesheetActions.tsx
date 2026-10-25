"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Choice = { id: string; name: string };
export function TimesheetActions({ id, status, own, review, ended }: { id: string; status: string; own: boolean; review: boolean; ended: boolean }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function act(action: string) {
    setBusy(true); setError(null);
    const { error } = await createClient().rpc("act_on_attendance_timesheet", { p_timesheet_id: id, p_action: action, p_note: note || null });
    setBusy(false);
    if (error) setError(error.message); else { setNote(""); router.refresh(); }
  }
  return <div className="space-y-3">
    {own && ["draft", "rejected"].includes(status) && <><p className="field-help">By signing, you confirm that the hours shown are accurate. Resolve any issues in Team attendance before signing.</p><button className="btn-primary" disabled={busy || !ended} onClick={() => act("submit")}>Confirm hours &amp; submit</button>{!ended && <p className="field-help">Sign-off opens the day after this period ends.</p>}</>}
    {own && status === "submitted" && <button className="btn-secondary" disabled={busy} onClick={() => act("withdraw")}>Withdraw for changes</button>}
    {review && ["submitted", "approved"].includes(status) && <div className="flex flex-wrap gap-3"><input className="input" aria-label="Review reason" placeholder="Reason (required to return)" maxLength={500} value={note} onChange={e => setNote(e.target.value)} />{status === "submitted" && <button className="btn-primary" disabled={busy} onClick={() => act("approve")}>Approve signed hours</button>}<button className="btn-secondary" disabled={busy || !note.trim()} onClick={() => act("reject")}>Return to employee</button></div>}
    {error && <p className="alert-error" role="alert">{error}</p>}
  </div>;
}

export function AttendancePeriodCreate({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <form className="grid gap-3 md:grid-cols-4" onSubmit={async e => {
    e.preventDefault(); const f = new FormData(e.currentTarget); setBusy(true); setError(null);
    const { data, error } = await createClient().rpc("create_attendance_period", { p_organization_id: organizationId, p_name: f.get("name"), p_from: f.get("from"), p_to: f.get("to") });
    setBusy(false); if (error) setError(error.message); else { router.push(`/time/timesheets?view=team&period=${data.id}`); router.refresh(); }
  }}>
    <div><label className="label" htmlFor="period-name">Period name</label><input className="input" id="period-name" name="name" required maxLength={120} placeholder="October — first half" /></div>
    <div><label className="label" htmlFor="period-from">First day</label><input className="input" id="period-from" type="date" name="from" required /></div>
    <div><label className="label" htmlFor="period-to">Last day</label><input className="input" id="period-to" type="date" name="to" required /></div>
    <button className="btn-primary self-end" disabled={busy}>Create review period</button>
    {error && <p className="alert-error md:col-span-4" role="alert">{error}</p>}
  </form>;
}

export function AttendancePeriodControls({ id, locked, canManage, canExport, employees }: { id: string; locked: boolean; canManage: boolean; canExport: boolean; employees: Choice[] }) {
  const router = useRouter();
  const [note, setNote] = useState(""); const [employee, setEmployee] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  async function run(kind: "lock" | "reopen" | "add" | "remove" | "export") {
    setBusy(true); setError(null);
    try {
      const client = createClient();
      if (kind === "export") {
        const { data, error } = await client.rpc("export_attendance_period", { p_period_id: id });
        if (error) throw error;
        const keys = ["employee_number", "employee_name", "period_start", "period_end", "revision", "regular_minutes", "overtime_minutes", "paid_leave_minutes", "unpaid_leave_minutes", "deducted_minutes", "makeup_minutes"];
        // Exact integer minutes and 4-decimal hour counterparts; no money or taxes.
        const columns = [...keys, ...keys.slice(5).map(k => k.replace("_minutes", "_hours"))];
        const escape = (value: unknown) => { const s = String(value ?? ""); return `"${(/^[\s]*[=+@-]/.test(s) ? "'" + s : s).replace(/"/g, '""')}"`; };
        const lines = [columns, ...(data as Record<string, unknown>[]).map(r => [...keys.map(k => r[k]), ...keys.slice(5).map(k => (Number(r[k]) / 60).toFixed(4))])];
        const url = URL.createObjectURL(new Blob(["\uFEFF" + lines.map(r => r.map(escape).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
        const a = document.createElement("a"); a.href = url; a.download = `approved-attendance-${id}.csv`; a.click(); URL.revokeObjectURL(url);
      } else {
        const { error } = kind === "add" || kind === "remove"
          ? await client.rpc("update_attendance_period_roster", { p_period_id: id, p_employee_id: employee, p_include: kind === "add", p_reason: note })
          : await client.rpc("set_attendance_period_lock", { p_period_id: id, p_locked: kind === "lock", p_note: note || null });
        if (error) throw error;
        setNote(""); router.refresh();
      }
    } catch (e) { setError(e instanceof Error ? e.message : (e as { message?: string }).message ?? "Unable to complete this action."); }
    finally { setBusy(false); }
  }
  return <div className="space-y-3">
    {canManage && <><label className="label" htmlFor="period-reason">Reason for reopening or changing the roster</label><input id="period-reason" className="input" value={note} maxLength={500} onChange={e => setNote(e.target.value)} />
      <div className="flex flex-wrap gap-3"><button className="btn-secondary" disabled={busy || (locked && !note.trim())} onClick={() => run(locked ? "reopen" : "lock")}>{locked ? "Reopen & require new signatures" : "Lock approved period"}</button>
      {!locked && <><select className="input max-w-xs" aria-label="Employee for roster change" value={employee} onChange={e => setEmployee(e.target.value)}><option value="">Choose employee</option>{employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select><button className="btn-secondary" disabled={busy || !employee || !note.trim()} onClick={() => run("add")}>Add to roster</button><button className="btn-secondary" disabled={busy || !employee || !note.trim()} onClick={() => run("remove")}>Exclude from roster</button></>}
      </div><p className="field-help">Exclusions require a reason and are allowed only for unsigned employees without attendance or approved leave. Reopening invalidates all signatures and approvals; previous versions remain in the audit history.</p></>}
    {canExport && <button className="btn-primary" disabled={busy || !locked} onClick={() => run("export")}>Download approved hours CSV</button>}
    {error && <p className="alert-error" role="alert">{error}</p>}
  </div>;
}
