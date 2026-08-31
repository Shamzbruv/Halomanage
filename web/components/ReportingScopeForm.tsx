"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { resolveFunctionErrorMessage } from "@/lib/supabase/functions";

type Candidate = {
  id: string;
  label: string;
  employeeNumber: string;
  supervisorEmployeeId: string | null;
  managerEmployeeId: string | null;
};

type Relationship = "supervisor" | "manager";

export function ReportingScopeForm({
  leaderEmployeeId,
  currentRole,
  canLead,
  candidates,
}: {
  leaderEmployeeId: string;
  currentRole: "employee" | "supervisor" | "manager" | "admin" | null;
  // Computed by the parent, which knows both the built-in role and whether
  // any currently-held custom role carries team-visibility permissions
  // (see set_employee_reporting_scope() in
  // 20260831100000_custom_organization_roles.sql for the matching
  // server-side check).
  canLead: boolean;
  candidates: Candidate[];
}) {
  const router = useRouter();
  const defaultRelationship: Relationship = currentRole === "supervisor" ? "supervisor" : "manager";
  const [relationship, setRelationship] = useState<Relationship>(defaultRelationship);
  const initialByRelationship = useMemo(() => ({
    supervisor: candidates.filter((candidate) => candidate.supervisorEmployeeId === leaderEmployeeId).map((candidate) => candidate.id),
    manager: candidates.filter((candidate) => candidate.managerEmployeeId === leaderEmployeeId).map((candidate) => candidate.id),
  }), [candidates, leaderEmployeeId]);
  const [selected, setSelected] = useState<string[]>(initialByRelationship[defaultRelationship]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  function changeRelationship(next: Relationship) {
    setRelationship(next);
    setSelected(initialByRelationship[next]);
    setError(null);
    setStatus(null);
  }

  function toggle(employeeId: string) {
    setSelected((current) => current.includes(employeeId)
      ? current.filter((id) => id !== employeeId)
      : [...current, employeeId]);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setStatus(null);

    const supabase = createClient();
    const { error: rpcError } = await supabase.rpc("set_employee_reporting_scope", {
      p_leader_employee_id: leaderEmployeeId,
      p_report_employee_ids: selected,
      p_relationship: relationship,
    });

    if (rpcError) {
      setError(await resolveFunctionErrorMessage(rpcError, "Could not update this reporting scope."));
      setLoading(false);
      return;
    }

    setStatus(`${selected.length} direct report${selected.length === 1 ? "" : "s"} assigned. Their records now appear in this person's Team hub.`);
    setLoading(false);
    router.refresh();
  }

  if (!canLead) {
    return <p className="text-sm text-stone-500">Assign a Supervisor or Manager role (or a custom role with team-visibility permissions) first, then return here to choose direct reports.</p>;
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <div>
        <label className="label" htmlFor="reporting-relationship">Reporting relationship</label>
        <select
          className="input"
          id="reporting-relationship"
          onChange={(event) => changeRelationship(event.target.value as Relationship)}
          value={relationship}
        >
          <option value="supervisor">Direct supervisor</option>
          <option value="manager">Direct manager</option>
        </select>
        <p className="field-help">This list controls data visibility for the selected relationship. It does not expose compensation unless a separate compensation permission is granted.</p>
      </div>

      <fieldset>
        <legend className="label">Direct reports</legend>
        <div className="max-h-72 space-y-1 overflow-y-auto rounded-xl border border-stone-200 p-2">
          {candidates.length === 0 && <p className="p-3 text-sm text-stone-500">There are no other active employees to assign.</p>}
          {candidates.map((candidate) => (
            <label className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-stone-50" key={candidate.id}>
              <input
                checked={selected.includes(candidate.id)}
                className="h-4 w-4"
                onChange={() => toggle(candidate.id)}
                type="checkbox"
              />
              <span className="min-w-0"><strong className="block text-sm font-medium text-stone-900">{candidate.label}</strong><small className="text-stone-500">{candidate.employeeNumber}</small></span>
            </label>
          ))}
        </div>
      </fieldset>

      {error && <p className="alert-error" role="alert">{error}</p>}
      {status && <p className="text-xs text-emerald-700" role="status">{status}</p>}
      <button className="btn-secondary" disabled={loading} type="submit">
        {loading ? "Saving…" : `Save ${relationship} scope`}
      </button>
    </form>
  );
}

