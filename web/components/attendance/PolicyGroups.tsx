"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function PolicyGroups({ organizationId, policies, departments }: { organizationId: string; policies: { id: string; name: string }[]; departments: { id: string; name: string; policyId: string | null }[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null); const [message, setMessage] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [unit, setUnit] = useState(""); const [policy, setPolicy] = useState(""); const [name, setName] = useState("");
  async function save(create: boolean) {
    setBusy(true); setError(null); setMessage(null);
    const { error } = create
      ? await createClient().rpc("create_attendance_policy", { p_organization_id: organizationId, p_name: name })
      : await createClient().rpc("set_department_attendance_policy", { p_org_unit_id: unit, p_policy_id: policy || null });
    setBusy(false); if (error) setError(error.message); else { setMessage(create ? "Policy created. Configure its rules below before assigning it." : "Department policy saved. Existing attendance snapshots are preserved."); if (create) setName(""); router.refresh(); }
  }
  return <div className="space-y-4">
    <p className="field-help">An employee&apos;s compensation time-policy override takes priority, followed by their primary department&apos;s policy, then the organization default. Department changes apply to new clock-ins; existing attendance keeps its policy snapshot.</p>
    <form className="flex flex-wrap gap-3" onSubmit={e => { e.preventDefault(); save(true); }}><label className="label" htmlFor="new-policy-name">New attendance policy</label><input id="new-policy-name" className="input max-w-sm" value={name} required maxLength={120} onChange={e => setName(e.target.value)} placeholder="Customer service team" /><button className="btn-secondary" disabled={busy}>Create policy</button></form>
    <form className="flex flex-wrap gap-3" onSubmit={e => { e.preventDefault(); save(false); }}><select className="input max-w-sm" aria-label="Department" required value={unit} onChange={e => { setUnit(e.target.value); setPolicy(departments.find(d => d.id === e.target.value)?.policyId ?? ""); }}><option value="">Choose department</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select><select className="input max-w-sm" aria-label="Department attendance policy" value={policy} onChange={e => setPolicy(e.target.value)}><option value="">Use organization default</option>{policies.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select><button className="btn-primary" disabled={busy}>Assign policy</button></form>
    <ul className="text-sm space-y-1">{departments.map(d => <li key={d.id}>{d.name}: {policies.find(p => p.id === d.policyId)?.name ?? "Organization default"}</li>)}</ul>
    {error && <p className="alert-error" role="alert">{error}</p>}{message && <p className="alert-success" role="status">{message}</p>}
  </div>;
}
