"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const TYPES = [
  { key: "hr", label: "HR steps", help: "e.g. verify identification, upload the contract, assign training." },
  { key: "it", label: "IT steps", help: "e.g. prepare equipment and system access." },
] as const;

// Who owns HR and IT onboarding steps by default
// (set_onboarding_responsible()). A step can still name its own person in
// the template, and HR can reassign one task on one run. Saving also hands
// any open, unowned steps of that kind to the new owner.
export function OnboardingResponsibilitiesForm({
  organizationId,
  people,
  current,
}: {
  organizationId: string;
  people: { id: string; label: string }[];
  current: Partial<Record<"hr" | "it", string>>;
}) {
  const supabase = createClient();
  const router = useRouter();
  const [values, setValues] = useState<Record<"hr" | "it", string>>({ hr: current.hr ?? "", it: current.it ?? "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(type: "hr" | "it") {
    setBusy(type);
    setError(null);
    setMessage(null);
    const { data, error: rpcError } = await supabase.rpc("set_onboarding_responsible", {
      p_organization_id: organizationId,
      p_assignee_type: type,
      p_employee_id: values[type] || null,
    });
    if (rpcError) {
      setError(rpcError.message);
    } else {
      const assigned = Number(data ?? 0);
      setMessage(values[type]
        ? `Saved.${assigned > 0 ? ` ${assigned} open step${assigned === 1 ? " was" : "s were"} assigned to them.` : ""}`
        : "Cleared — these steps can be completed by anyone who manages onboarding.");
      router.refresh();
    }
    setBusy(null);
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {TYPES.map((type) => (
          <div key={type.key}>
            <label className="label" htmlFor={`responsible-${type.key}`}>{type.label}</label>
            <div className="flex gap-2">
              <select id={`responsible-${type.key}`} className="input" value={values[type.key]} onChange={(e) => setValues({ ...values, [type.key]: e.target.value })}>
                <option value="">Anyone who manages onboarding</option>
                {people.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              <button type="button" className="btn-secondary shrink-0" disabled={busy !== null || values[type.key] === (current[type.key] ?? "")} onClick={() => save(type.key)}>
                {busy === type.key ? "Saving…" : "Save"}
              </button>
            </div>
            <p className="field-help">{type.help}</p>
          </div>
        ))}
      </div>
      {error && <p role="alert" className="alert-error">{error}</p>}
      {message && !error && <p role="status" className="text-xs text-emerald-700">{message}</p>}
    </div>
  );
}

// Per-task reassignment on a run record (reassign_onboarding_task()).
export function ReassignOnboardingTask({ taskId, people, currentEmployeeId }: { taskId: string; people: { id: string; label: string }[]; currentEmployeeId: string | null }) {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(currentEmployeeId ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!value) return;
    setLoading(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("reassign_onboarding_task", { p_task_id: taskId, p_employee_id: value });
    if (rpcError) {
      setError(rpcError.message);
      setLoading(false);
      return;
    }
    setLoading(false);
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => setOpen(true)}>Reassign</button>;
  }
  return (
    <div className="flex w-full max-w-sm flex-wrap items-center gap-1.5">
      <select className="input flex-1" aria-label="Assign this step to" value={value} onChange={(e) => setValue(e.target.value)}>
        <option value="">Choose a person…</option>
        {people.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
      <button type="button" className="btn-primary px-2.5 py-1 text-xs" disabled={loading || !value} onClick={save}>{loading ? "Saving…" : "Assign"}</button>
      <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => setOpen(false)}>Cancel</button>
      {error && <p role="alert" className="w-full text-xs text-ruby-600">{error}</p>}
    </div>
  );
}
