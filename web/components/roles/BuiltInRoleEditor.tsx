"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { resolveFunctionErrorMessage } from "@/lib/supabase/functions";
import { PermissionChecklist } from "@/components/roles/PermissionChecklist";
import type { AppPermission } from "@/lib/supabase/types";

const ROLE_LABEL: Record<string, string> = { employee: "Employee", supervisor: "Supervisor", manager: "Manager", admin: "Admin" };

// Ref: set_default_role_permissions()/reset_default_role_permissions() in
// 20260831100000_custom_organization_roles.sql. A built-in role can't be
// saved with zero permissions — an empty override would fall straight
// through to the global default bundle rather than actually meaning
// "nothing" (see that migration's comment). Create a custom role instead
// for a role that needs to be reduced to nothing.
export function BuiltInRoleEditor({
  organizationId,
  role,
  initialPermissions,
  isOverridden,
  holderCount,
}: {
  organizationId: string;
  role: "employee" | "supervisor" | "manager" | "admin";
  initialPermissions: AppPermission[];
  isOverridden: boolean;
  holderCount: number;
}) {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<AppPermission>>(new Set(initialPermissions));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    if (selected.size === 0) {
      setError("A built-in role must keep at least one permission. Create a custom role instead if you need one with none.");
      return;
    }
    setLoading(true);
    setError(null);
    setSaved(false);
    const { error: rpcError } = await supabase.rpc("set_default_role_permissions", {
      p_organization_id: organizationId,
      p_role: role,
      p_permissions: Array.from(selected),
    });
    if (rpcError) {
      setError(await resolveFunctionErrorMessage(rpcError, "Could not update this role's permissions."));
      setLoading(false);
      return;
    }
    setSaved(true);
    setLoading(false);
    router.refresh();
  }

  async function resetToDefault() {
    setLoading(true);
    setError(null);
    setSaved(false);
    const { error: rpcError } = await supabase.rpc("reset_default_role_permissions", {
      p_organization_id: organizationId,
      p_role: role,
    });
    if (rpcError) {
      setError(await resolveFunctionErrorMessage(rpcError, "Could not reset this role to the Halomanage default."));
      setLoading(false);
      return;
    }
    setLoading(false);
    router.refresh();
  }

  return (
    <div className="rounded-2xl border border-stone-200 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-stone-900">{ROLE_LABEL[role]}</h3>
          <p className="text-xs text-stone-500">
            {holderCount} {holderCount === 1 ? "person holds" : "people hold"} this role
            {isOverridden ? " · customized for your organization" : " · using Halomanage's default permissions"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isOverridden && (
            <button type="button" className="btn-secondary" disabled={loading} onClick={resetToDefault}>Reset to default</button>
          )}
          <button type="button" className="btn-secondary" onClick={() => setOpen((v) => !v)}>{open ? "Close" : "Edit permissions"}</button>
        </div>
      </div>

      {open && (
        <div className="mt-4 space-y-3">
          <PermissionChecklist value={selected} onChange={setSelected} disabled={loading} />
          {error && <p className="alert-error" role="alert">{error}</p>}
          {saved && !error && <p className="text-xs text-emerald-700" role="status">Saved. Takes effect immediately for everyone with this role.</p>}
          <button type="button" className="btn-primary" disabled={loading} onClick={save}>{loading ? "Saving…" : "Save permissions"}</button>
        </div>
      )}
    </div>
  );
}
