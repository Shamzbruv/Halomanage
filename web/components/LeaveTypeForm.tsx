"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Rule = { excluded_weekdays: number[]; id: string; name: string; code: string; is_paid: boolean; requires_approval: boolean; balance_tracked: boolean; requires_attachment: boolean; attachment_after_days: number | null; requires_manager_approval_over_days: number | null; allow_half_day: boolean; allow_negative_balance: boolean; minimum_notice_days: number; maximum_consecutive_days: number | null; day_count_basis: string; allow_backdated_requests: boolean; backdate_limit_days: number; minimum_service_days: number; is_active: boolean };
export function LeaveTypeForm({ organizationId, initial }: { organizationId: string; initial?: Rule }) {
  const router = useRouter(); const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ excluded_weekdays: initial?.excluded_weekdays ?? [] as number[], name: initial?.name ?? "", code: initial?.code ?? "", is_paid: initial?.is_paid ?? true, requires_approval: initial?.requires_approval ?? true,
    balance_tracked: initial?.balance_tracked ?? true, requires_attachment: initial?.requires_attachment ?? false, attachment_after_days: String(initial?.attachment_after_days ?? ""),
    requires_manager_approval_over_days: String(initial?.requires_manager_approval_over_days ?? ""), allow_half_day: initial?.allow_half_day ?? true, allow_negative_balance: initial?.allow_negative_balance ?? false,
    minimum_notice_days: String(initial?.minimum_notice_days ?? 0), maximum_consecutive_days: String(initial?.maximum_consecutive_days ?? ""), day_count_basis: initial?.day_count_basis ?? "working_days",
    allow_backdated_requests: initial?.allow_backdated_requests ?? true, backdate_limit_days: String(initial?.backdate_limit_days ?? 30), minimum_service_days: String(initial?.minimum_service_days ?? 0), is_active: initial?.is_active ?? true });
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) { setForm(f => ({ ...f, [k]: v })); }
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    const values = { ...form, organization_id: organizationId, name: form.name.trim(), code: form.code.trim().toUpperCase(),
      minimum_notice_days: Number(form.minimum_notice_days), backdate_limit_days: Number(form.backdate_limit_days), minimum_service_days: Number(form.minimum_service_days),
      maximum_consecutive_days: form.maximum_consecutive_days ? Number(form.maximum_consecutive_days) : null,
      attachment_after_days: form.attachment_after_days ? Number(form.attachment_after_days) : null,
      requires_manager_approval_over_days: form.requires_manager_approval_over_days ? Number(form.requires_manager_approval_over_days) : null };
    const q = createClient().from("leave_types");
    const { error } = initial ? await q.update(values).eq("id", initial.id).select("id").single() : await q.insert(values);
    setBusy(false); if (error) setError(error.message); else { setOpen(false); router.refresh(); }
  }
  if (!open) return <button className="btn-secondary" onClick={() => setOpen(true)}>{initial ? "Edit leave rules" : "New leave type"}</button>;
  const text = (key: "name" | "code", label: string, max: number) => <label className="block"><span className="label">{label}</span><input className="input" required maxLength={max} value={form[key]} onChange={e => set(key, e.target.value)} /></label>;
  const number = (key: "minimum_notice_days" | "maximum_consecutive_days" | "attachment_after_days" | "requires_manager_approval_over_days" | "backdate_limit_days" | "minimum_service_days", label: string, help: string, optional = false) => <label className="block"><span className="label">{label}</span><input className="input" type="number" min={key === "maximum_consecutive_days" ? 1 : 0} max={key === "minimum_service_days" ? 36500 : 366} step={key === "requires_manager_approval_over_days" || key === "attachment_after_days" ? 0.5 : 1} required={!optional} value={form[key]} onChange={e => set(key, e.target.value)} /><span className="field-help">{help}</span></label>;
  const check = (key: "is_paid" | "requires_approval" | "balance_tracked" | "requires_attachment" | "allow_half_day" | "allow_negative_balance" | "allow_backdated_requests" | "is_active", label: string) => <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form[key]} onChange={e => set(key, e.target.checked)} />{label}</label>;
  return <form onSubmit={save} className="card space-y-4 w-full">
    <h3 className="font-semibold">{initial ? `Edit ${initial.name}` : "Create leave type"}</h3><div className="grid gap-3 md:grid-cols-2">{text("name", "Name", 120)}{text("code", "Code (letters, numbers, hyphens, underscores)", 30)}<label><span className="label">How days are counted</span><select className="input" value={form.day_count_basis} onChange={e => set("day_count_basis", e.target.value)}><option value="working_days">Employee&apos;s scheduled working days, excluding applicable holidays</option><option value="calendar_days">Calendar days, including weekends and holidays</option></select></label>
    {number("minimum_notice_days", "Minimum notice (calendar days)", "Use 0 for leave that may be unexpected, such as illness.")}
    {number("maximum_consecutive_days", "Maximum days per request", "Blank means no type-specific limit; counted using the chosen basis.", true)}
    {number("requires_manager_approval_over_days", "Second approval above (days)", "Blank means no extra paid-leave threshold. Unpaid leave always uses two independent steps.", true)}
    {number("attachment_after_days", "Supporting document above (days)", "When documents are required, blank requires one for every request.", true)}
    {number("backdate_limit_days", "Backdated request limit (days)", "Used only when backdated requests are allowed. A reason is required.")}
    {number("minimum_service_days", "Minimum service before leave starts (days)", "Employer eligibility setting; review exceptions with HR rather than treating this as a universal legal rule.")}
    </div>{form.day_count_basis === "working_days" && <fieldset className="space-y-2"><legend className="label">Weekdays never charged (optional employer rule)</legend><div className="flex flex-wrap gap-3">{["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].map((label,i) => <label className="flex gap-2 text-sm" key={label}><input type="checkbox" checked={form.excluded_weekdays.includes(i)} onChange={e => set("excluded_weekdays",e.target.checked ? [...form.excluded_weekdays,i] : form.excluded_weekdays.filter(d => d!==i))} />{label}</label>)}</div><p className="field-help">For working-day policies only. Applicable holidays are excluded separately. Set exclusions from the employer policy; flexible work may include weekends. Calendar-day leave ignores these exclusions.</p></fieldset>}<div className="grid gap-3 sm:grid-cols-2">{check("is_paid", "Paid leave")}{check("balance_tracked", "Track and enforce a day balance")}{check("requires_approval", "Require independent approval")}{check("requires_attachment", "Require supporting documents")}{check("allow_half_day", "Allow first/second half shifts")}{check("allow_negative_balance", "Permit requests beyond the balance")}{check("allow_backdated_requests", "Allow backdated requests")}{check("is_active", "Available for new requests")}</div>
    <p className="field-help">These rules apply to new requests. Submitted requests retain their policy snapshot. Deactivate a type to stop new requests while preserving history. Define separate paid and unpaid types when a leave entitlement has different pay phases.</p>
    {error && <p className="alert-error" role="alert">{error}</p>}<div className="flex gap-3"><button className="btn-primary" disabled={busy}>{busy ? "Saving…" : "Save rules"}</button><button className="btn-secondary" type="button" onClick={() => setOpen(false)}>Close</button></div>
  </form>;
}
