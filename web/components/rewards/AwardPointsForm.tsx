"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { resolveFunctionErrorMessage } from "@/lib/supabase/functions";
import { Icon } from "@/components/Icon";

export type EmployeeOption = { id: string; label: string };

export function AwardPointsForm({ employees }: { employees: EmployeeOption[] }) {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? "");
  const [amount, setAmount] = useState("500");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("award_employee_points", {
      p_employee_id: employeeId,
      p_amount: Number(amount),
      p_reason: reason || null,
    });
    if (rpcError) {
      setError(await resolveFunctionErrorMessage(rpcError, "Could not award points."));
      setLoading(false);
      return;
    }
    setOpen(false);
    setLoading(false);
    setReason("");
    router.refresh();
  }

  if (!open) {
    return <button type="button" className="btn-primary" onClick={() => setOpen(true)}><Icon name="spark" size={16} /> Award points</button>;
  }

  return (
    <div className="modal-layer" role="presentation">
      <button type="button" className="modal-backdrop" aria-label="Close dialog" onClick={() => setOpen(false)} />
      <form onSubmit={handleSubmit} className="modal-card space-y-3" role="dialog" aria-modal="true" aria-labelledby="award-points-title">
        <div className="modal-head"><div><span className="eyebrow">Recognition</span><h3 id="award-points-title">Award points</h3></div><button type="button" className="icon-button" aria-label="Close dialog" onClick={() => setOpen(false)}><Icon name="x" size={18} /></button></div>
        <div>
          <label className="label" htmlFor="award-employee">Employee</label>
          <select id="award-employee" className="input" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
          </select>
        </div>
        <div><label className="label" htmlFor="award-amount">Points</label><input id="award-amount" type="number" min="1" required className="input" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        <div><label className="label" htmlFor="award-reason">Reason <span className="font-normal text-stone-500">(shown to the employee)</span></label><input id="award-reason" className="input" placeholder="Employee of the month" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        {error && <p className="alert-error">{error}</p>}
        <div className="flex gap-2"><button type="submit" disabled={loading} className="btn-primary">{loading ? "Awarding…" : "Award points"}</button><button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button></div>
      </form>
    </div>
  );
}
