"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { resolveFunctionErrorMessage } from "@/lib/supabase/functions";
import { Icon } from "@/components/Icon";
import { PermissionChecklist } from "@/components/roles/PermissionChecklist";
import type { AppPermission } from "@/lib/supabase/types";

export function NewCustomRoleForm({ organizationId }: { organizationId: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<Set<AppPermission>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("create_organization_role", {
      p_organization_id: organizationId,
      p_name: name,
      p_description: description || null,
      p_permissions: Array.from(selected),
    });
    if (rpcError) {
      setError(await resolveFunctionErrorMessage(rpcError, "Could not create this role."));
      setLoading(false);
      return;
    }
    setOpen(false);
    setLoading(false);
    setName("");
    setDescription("");
    setSelected(new Set());
    router.refresh();
  }

  if (!open) {
    return <button type="button" className="btn-primary" onClick={() => setOpen(true)}><Icon name="spark" size={16} /> New role</button>;
  }

  return (
    <div className="modal-layer" role="presentation">
      <button type="button" className="modal-backdrop" aria-label="Close dialog" onClick={() => setOpen(false)} />
      <form onSubmit={handleSubmit} className="modal-card space-y-3" role="dialog" aria-modal="true" aria-labelledby="new-role-title">
        <div className="modal-head">
          <div><span className="eyebrow">Roles &amp; permissions</span><h3 id="new-role-title">New role</h3></div>
          <button type="button" className="icon-button" aria-label="Close dialog" onClick={() => setOpen(false)}><Icon name="x" size={18} /></button>
        </div>
        <div><label className="label" htmlFor="role-name">Name</label><input id="role-name" required className="input" placeholder="HR Manager" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div><label className="label" htmlFor="role-description">Description <span className="font-normal text-stone-500">(optional)</span></label><input id="role-description" className="input" placeholder="Manages people records without full Admin access" value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        <div>
          <p className="label">Permissions</p>
          <PermissionChecklist value={selected} onChange={setSelected} disabled={loading} />
        </div>
        {error && <p className="alert-error">{error}</p>}
        <div className="flex gap-2"><button type="submit" disabled={loading} className="btn-primary">{loading ? "Creating…" : "Create role"}</button><button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button></div>
      </form>
    </div>
  );
}
