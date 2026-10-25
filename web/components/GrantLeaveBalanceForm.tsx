"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
export function GrantLeaveBalanceForm({ employeeId, leaveTypes, today }: { organizationId: string; employeeId: string; leaveTypes: { id: string; name: string }[]; today: string }) {
  const router = useRouter(); const [type, setType] = useState(leaveTypes[0]?.id ?? ""); const [amount, setAmount] = useState(""); const [note, setNote] = useState("");
  const [date, setDate] = useState(today); const [key, setKey] = useState(() => crypto.randomUUID()); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  if (!leaveTypes.length) return null;
  return <form className="grid gap-3 md:grid-cols-2" onSubmit={async e => { e.preventDefault(); setBusy(true); setError(null);
    const { error } = await createClient().rpc("adjust_leave_balance", { p_employee_id: employeeId, p_leave_type_id: type, p_amount: Number(amount), p_note: note, p_effective_date: date, p_key: key });
    setBusy(false); if (error) setError(error.message); else { setKey(crypto.randomUUID()); setAmount(""); setNote(""); router.refresh(); }
  }}>
    <label><span className="label">Leave type</span><select className="input" value={type} onChange={e => { setType(e.target.value); setKey(crypto.randomUUID()); }}>{leaveTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
    <label><span className="label">Adjustment days (+/−)</span><input className="input" required type="number" step="0.01" min={-9999} max={9999} value={amount} onChange={e => { setAmount(e.target.value); setKey(crypto.randomUUID()); }} /></label>
    <label><span className="label">Effective date</span><input className="input" required type="date" value={date} onChange={e => { setDate(e.target.value); setKey(crypto.randomUUID()); }} /></label>
    <label><span className="label">Adjustment reason</span><input className="input" required maxLength={1000} value={note} onChange={e => { setNote(e.target.value); setKey(crypto.randomUUID()); }} /></label>
    <p className="field-help md:col-span-2">Adjustments are audited, retry-safe and never overwrite earlier entries. Future credits are not available until their effective date. Review pending reservations before reducing a balance.</p>
    {error && <p className="alert-error md:col-span-2" role="alert">{error}</p>}<button className="btn-secondary" disabled={busy || !amount || !note.trim()}>{busy ? "Saving…" : "Apply balance adjustment"}</button>
  </form>;
}
