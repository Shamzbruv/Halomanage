"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const BUILT_IN_ROLES = [
  { value: "employee", label: "Employee", help: "Their own record, time, leave, onboarding, and documents." },
  { value: "supervisor", label: "Supervisor", help: "Adds visibility of, and approvals for, direct reports." },
  { value: "manager", label: "Manager", help: "Supervisor access plus wider team management." },
  { value: "admin", label: "Administrator", help: "Full HR administration. Grant sparingly." },
] as const;

// Portal access for someone who doesn't have a sign-in account yet.
// role_assignments needs an Auth user_id, so the choice is stored by
// prepare_employee_access() and applied by the invitation in the same
// transaction that creates the account — the employee never holds an
// accidental default role in between. Anything above Employee requires
// roles.manage (checked in the database).
export function EmployeeAccessSetup({
  employeeId,
  pendingRole,
  pendingCustomRoleId,
  configuredAt,
  customRoles,
}: {
  employeeId: string;
  pendingRole: string | null;
  pendingCustomRoleId: string | null;
  configuredAt: string | null;
  customRoles: { id: string; name: string }[];
}) {
  const supabase = createClient();
  const router = useRouter();
  const [value, setValue] = useState(pendingCustomRoleId ? `custom:${pendingCustomRoleId}` : `built-in:${pendingRole ?? "employee"}`);
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const isCustom = value.startsWith("custom:");
    const { error: rpcError } = await supabase.rpc("prepare_employee_access", {
      p_employee_id: employeeId,
      p_role: isCustom ? null : value.slice("built-in:".length),
      p_custom_role_id: isCustom ? value.slice("custom:".length) : null,
    });
    if (rpcError) {
      setError(rpcError.message);
      setLoading(false);
      return;
    }
    setSaved(true);
    setLoading(false);
    router.refresh();
  }

  const selectedBuiltIn = BUILT_IN_ROLES.find((role) => `built-in:${role.value}` === value);

  return (
    <form onSubmit={handleSubmit} className="space-y-3" id="portal_access">
      <div>
        <label className="label" htmlFor="pending-role">Access level when they accept the invitation</label>
        <select id="pending-role" className="input" value={value} onChange={(event) => { setValue(event.target.value); setSaved(false); }}>
          <optgroup label="Built-in roles">
            {BUILT_IN_ROLES.map((role) => <option key={role.value} value={`built-in:${role.value}`}>{role.label}</option>)}
          </optgroup>
          {customRoles.length > 0 && (
            <optgroup label="Custom roles">
              {customRoles.map((role) => <option key={role.id} value={`custom:${role.id}`}>{role.name}</option>)}
            </optgroup>
          )}
        </select>
        <p className="field-help">{selectedBuiltIn?.help ?? "A custom role your organization defined under Roles & permissions."}</p>
      </div>
      {configuredAt
        ? <p className="text-xs text-emerald-700">Access confirmed {configuredAt.slice(0, 10)} — applied automatically when the invitation is accepted.</p>
        : <p className="text-xs text-amber-700">Not confirmed yet. Save to confirm this employee&apos;s access level — required before inviting.</p>}
      {error && <p role="alert" className="alert-error">{error}</p>}
      {saved && !error && <p role="status" className="text-xs text-emerald-700">Access saved.</p>}
      <button type="submit" disabled={loading} className="btn-primary">{loading ? "Saving…" : configuredAt ? "Update access" : "Confirm access"}</button>
    </form>
  );
}
