"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { resolveFunctionErrorMessage } from "@/lib/supabase/functions";

const BUILT_IN_ROLES = ["employee", "supervisor", "manager", "admin"] as const;
type AppRole = (typeof BUILT_IN_ROLES)[number];

type CustomRole = { id: string; name: string };

// A select option's value is either "built-in:<role>" or "custom:<uuid>" so
// one dropdown can offer both kinds without conflating a built-in role's
// literal name with a custom role that happens to share it.
function encode(role: AppRole | null, customRoleId: string | null) {
  if (customRoleId) return `custom:${customRoleId}`;
  return `built-in:${role ?? "employee"}`;
}
function decode(value: string): { role: AppRole | null; customRoleId: string | null } {
  if (value.startsWith("custom:")) return { role: null, customRoleId: value.slice("custom:".length) };
  return { role: value.slice("built-in:".length) as AppRole, customRoleId: null };
}

// Ref: supabase/migrations/20260828110000_lifecycle_rbac_hardening.sql and
// 20260831100000_custom_organization_roles.sql — role_assignments is
// select-only under RLS now; every mutation goes through set_member_role(),
// which enforces the invariants a direct insert/update could otherwise
// skip: the employee must have a linked account, can't be terminated,
// can't hold an active role in a second organization, and the last person
// able to manage roles can never be demoted or scheduled to expire out
// from under an organization — whether that's the built-in Admin role or a
// custom role an org granted roles.manage to.
export function RoleAssignmentForm({
  employeeId,
  currentRole,
  currentCustomRoleId,
  customRoles,
  isSelf,
}: {
  employeeId: string;
  currentRole: AppRole | null;
  currentCustomRoleId: string | null;
  customRoles: CustomRole[];
  isSelf: boolean;
}) {
  const supabase = createClient();
  const router = useRouter();
  const [value, setValue] = useState(encode(currentRole ?? "employee", currentCustomRoleId));
  const [expiresOn, setExpiresOn] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setSaved(false);

    const { role, customRoleId } = decode(value);
    const { error: rpcError } = await supabase.rpc("set_member_role", {
      p_employee_id: employeeId,
      p_role: role,
      p_valid_until: expiresOn ? new Date(`${expiresOn}T23:59:59`).toISOString() : null,
      p_custom_role_id: customRoleId,
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

  const { role: selectedRole } = decode(value);

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="label" htmlFor="member-role">Role</label>
        <select
          id="member-role"
          className="input"
          value={value}
          disabled={isSelf}
          onChange={(event) => setValue(event.target.value)}
        >
          <optgroup label="Built-in roles">
            {BUILT_IN_ROLES.map((role) => (
              <option key={role} value={encode(role, null)}>{role.charAt(0).toUpperCase() + role.slice(1)}</option>
            ))}
          </optgroup>
          {customRoles.length > 0 && (
            <optgroup label="Custom roles">
              {customRoles.map((role) => (
                <option key={role.id} value={encode(null, role.id)}>{role.name}</option>
              ))}
            </optgroup>
          )}
        </select>
        <p className="field-help">
          A role controls permissions — built-in or a custom role your organization defined under Roles &amp; permissions.
          Supervisor and manager visibility also requires employees to name this person in their current reporting assignment.
        </p>
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
      {saved && !error && (
        <p className="text-xs text-emerald-700" role="status">
          Role updated. The employee will see the new workspace after refreshing or signing in again
          {selectedRole === "manager" || selectedRole === "supervisor" ? "; assign their direct reports below to populate the Team hub." : "."}
        </p>
      )}
      <button type="submit" className="btn-secondary" disabled={loading || isSelf}>
        {loading ? "Saving…" : "Update role"}
      </button>
    </form>
  );
}
