"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function AssignAssetForm({
  organizationId,
  employeeId,
  availableAssets,
}: {
  organizationId: string;
  employeeId: string;
  // Pre-filtered by the server to active assets with no current open
  // assignment — employee_asset_assignments enforces at most one open
  // assignment per asset at the database level (a partial unique index),
  // this is just presenting that same rule before someone hits the error.
  availableAssets: { id: string; name: string; serial_number: string | null }[];
}) {
  const supabase = createClient();
  const router = useRouter();
  const [assetId, setAssetId] = useState(availableAssets[0]?.id ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.from("employee_asset_assignments").insert({
      organization_id: organizationId,
      employee_id: employeeId,
      asset_id: assetId,
    });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    setLoading(false);
    router.refresh();
  }

  if (availableAssets.length === 0) return <p className="text-xs text-stone-400">Nothing available to assign — every active asset is already with someone, or the pool is empty.</p>;

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2">
      <div>
        <label className="label">Asset</label>
        <select className="input" value={assetId} onChange={(e) => setAssetId(e.target.value)}>
          {availableAssets.map((a) => <option key={a.id} value={a.id}>{a.name}{a.serial_number ? ` (${a.serial_number})` : ""}</option>)}
        </select>
      </div>
      {error && <p className="alert-error">{error}</p>}
      <button type="submit" disabled={loading || !assetId} className="btn-secondary">{loading ? "…" : "Assign"}</button>
    </form>
  );
}
