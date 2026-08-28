"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { resolveFunctionErrorMessage } from "@/lib/supabase/functions";

const ROLES = ["employee", "supervisor", "manager", "admin"] as const;
type AppRole = (typeof ROLES)[number];

// Ref: supabase/migrations/20260828110000_lifecycle_rbac_hardening.sql —
// role_assignments is select-only under RLS now; every mutation goes
// through set_member_role(), which enforces the invariants a direct
// insert/update could otherwise skip: the employee must have a linked
// account, can't be terminated, can't hold an active role in a second
// organization, and the last active admin can never be demoted or
// scheduled to expire out from under an organization.
export function RoleAssignmentForm({
  employeeId,
  currentRole,
  isSelf,
}: {
  employeeId: string;
  currentRole: AppRole | null;
  isSelf: boolean;
}) {
  const supabase = createClient();
  const router = useRouter();
  const [role, setRole] = useState<AppRole>(currentRole ?? "employee");
  const [expiresOn, setExpiresOn] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setSaved(false);

    const { error: rpcError } = await supabase.rpc("set_member_role", {
      p_employee_id: employeeId,
      p_role: role,
      p_valid_until: expiresOn ? new Date(`${expiresOn}T23:59:59`).toISOString() : null,
    });

    if (rpcError) {
      setError(await resolveFunctionErrorMessage(rpcError, "Could not update this person's role."));
      setLoading(false);
      return;
    }

    setSaved(true);
    setLoading(false);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="label" htmlFor="member-role">Role</label>
        <select
          id="member-role"
          className="input"
          value={role}
          disabled={isSelf}
          onChange={(event) => setRole(event.target.value as AppRole)}
        >
          {ROLES.map((value) => (
            <option key={value} value={value}>{value.charAt(0).toUpperCase() + value.slice(1)}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="member-role-expires">Expires on <span className="font-normal text-stone-500">(optional)</span></label>
        <input
          id="member-role-expires"
          type="date"
          className="input"
          value={expiresOn}
          disabled={isSelf}
          onChange={(event) => setExpiresOn(event.target.value)}
        />
        <p className="field-help">Leave blank for a standing role. Set a date for a temporary grant that reverts automatically.</p>
      </div>
      {isSelf && <p className="text-xs text-stone-500">You cannot change your own role. Ask another administrator.</p>}
      {error && <p className="alert-error" role="alert">{error}</p>}
      {saved && !error && <p className="text-xs text-emerald-700" role="status">Role updated.</p>}
      <button type="submit" className="btn-secondary" disabled={loading || isSelf}>
        {loading ? "Saving…" : "Update role"}
      </button>
    </form>
  );
}
