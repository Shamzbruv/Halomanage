"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function GrantLeaveBalanceForm({
  organizationId,
  employeeId,
  leaveTypes,
}: {
  organizationId: string;
  employeeId: string;
  leaveTypes: { id: string; name: string }[];
}) {
  const supabase = createClient();
  const router = useRouter();
  const [leaveTypeId, setLeaveTypeId] = useState(leaveTypes[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.from("leave_ledger").insert({
      organization_id: organizationId,
      employee_id: employeeId,
      leave_type_id: leaveTypeId,
      entry_type: "adjustment",
      amount: Number(amount),
      note: note || "Manual grant",
    });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    setAmount("");
    setNote("");
    setLoading(false);
    router.refresh();
  }

  if (leaveTypes.length === 0) return null;

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2">
      <div>
        <label className="label">Leave type</label>
        <select className="input" value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)}>
          {leaveTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>
      <div>
        <label className="label">Days (+/-)</label>
        <input required type="number" step="0.5" className="input w-28" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </div>
      <div className="flex-1">
        <label className="label">Note</label>
        <input className="input" placeholder="Annual grant" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {error && <p className="alert-error">{error}</p>}
      <button type="submit" disabled={loading || !amount} className="btn-secondary">
        {loading ? "…" : "Apply"}
      </button>
    </form>
  );
}
