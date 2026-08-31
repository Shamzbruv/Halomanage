"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { resolveFunctionErrorMessage } from "@/lib/supabase/functions";
import { PermissionChecklist } from "@/components/roles/PermissionChecklist";
import { Icon } from "@/components/Icon";
import type { AppPermission } from "@/lib/supabase/types";

export function CustomRoleCard({
  roleId,
  name,
  description,
  isActive,
  holderCount,
  initialPermissions,
}: {
  roleId: string;
  name: string;
  description: string | null;
  isActive: boolean;
  holderCount: number;
  initialPermissions: AppPermission[];
}) {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [roleName, setRoleName] = useState(name);
  const [roleDescription, setRoleDescription] = useState(description ?? "");
  const [selected, setSelected] = useState<Set<AppPermission>>(new Set(initialPermissions));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function saveDetailsAndPermissions() {
    setLoading(true);
    setError(null);
    setSaved(false);

    const { error: renameError } = await supabase.rpc("update_organization_role", {
      p_role_id: roleId,
      p_name: roleName,
      p_description: roleDescription || null,
    });
    if (renameError) {
      setError(await resolveFunctionErrorMessage(renameError, "Could not update this role."));
      setLoading(false);
      return;
    }

    const { error: permissionsError } = await supabase.rpc("set_organization_role_permissions", {
      p_role_id: roleId,
      p_permissions: Array.from(selected),
    });
    if (permissionsError) {
      setError(await resolveFunctionErrorMessage(permissionsError, "Could not update this role's permissions."));
      setLoading(false);
      return;
    }

    setSaved(true);
    setLoading(false);
    router.refresh();
  }

  async function toggleActive() {
    setLoading(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("set_organization_role_active", { p_role_id: roleId, p_is_active: !isActive });
    if (rpcError) {
      setError(await resolveFunctionErrorMessage(rpcError, "Could not update this role."));
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
          <h3 className="flex items-center gap-2 text-sm font-semibold text-stone-900">
            {name}
            {!isActive && <span className="badge badge-neutral">Deactivated</span>}
          </h3>
          <p className="text-xs text-stone-500">
            {description || "No description"} · {holderCount} {holderCount === 1 ? "person holds" : "people hold"} this role
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="btn-secondary" disabled={loading} onClick={toggleActive}>
            {isActive ? "Deactivate" : "Reactivate"}
          </button>
          <button type="button" className="btn-secondary" onClick={() => setOpen((v) => !v)}>{open ? "Close" : "Edit"}</button>
        </div>
      </div>

      {open && (
        <div className="mt-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor={`role-name-${roleId}`}>Name</label>
              <input id={`role-name-${roleId}`} className="input" value={roleName} onChange={(e) => setRoleName(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor={`role-desc-${roleId}`}>Description</label>
              <input id={`role-desc-${roleId}`} className="input" value={roleDescription} onChange={(e) => setRoleDescription(e.target.value)} />
            </div>
          </div>
          <PermissionChecklist value={selected} onChange={setSelected} disabled={loading} />
          {error && <p className="alert-error" role="alert">{error}</p>}
          {saved && !error && <p className="text-xs text-emerald-700" role="status">Saved. Takes effect immediately for everyone with this role.</p>}
          <button type="button" className="btn-primary" disabled={loading} onClick={saveDetailsAndPermissions}>
            {loading ? "Saving…" : "Save role"}
          </button>
        </div>
      )}
      {!open && (
        <button type="button" className="mt-2 inline-flex items-center gap-1 text-xs text-royal-700 hover:text-royal-800" onClick={() => setOpen(true)}>
          <Icon name="spark" size={13} /> {selected.size} permission{selected.size === 1 ? "" : "s"} granted
        </button>
      )}
    </div>
  );
}
