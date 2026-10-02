"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { NOTIFICATION_GROUPS, type RequiredState } from "@/lib/notifications";

// The organization's in-app notification policy
// (set_notification_requirement()): which groups employees may switch off.
// HaloManage's system-critical record notices are always required and are
// shown locked. Policy is per channel; only in-app delivery is live today.
export function NotificationPolicyForm({ organizationId, requirements }: { organizationId: string; requirements: Record<string, RequiredState> }) {
  const supabase = createClient();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(groupKey: string, types: string[], required: boolean) {
    setBusy(groupKey);
    setError(null);
    const { error: rpcError } = await supabase.rpc("set_notification_requirement", {
      p_organization_id: organizationId, p_notification_types: types, p_channel: "in_app", p_required: required,
    });
    if (rpcError) setError(rpcError.message);
    setBusy(null);
    router.refresh();
  }

  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {NOTIFICATION_GROUPS.map((group) => {
          const state = requirements[group.key] ?? { required: false, system: false };
          return (
            <li key={group.key} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-cream-100 px-3 py-2.5">
              <div>
                <p className="text-sm font-medium text-stone-900">{group.label}</p>
                <p className="text-xs text-stone-500">{group.description}</p>
              </div>
              {state.system ? (
                <span className="badge badge-neutral" title="Required for every HaloManage organization">Always required</span>
              ) : (
                <label className="flex items-center gap-2 text-xs text-stone-600">
                  <input type="checkbox" checked={state.required} disabled={busy === group.key} onChange={(e) => toggle(group.key, group.types, e.target.checked)} />
                  Required — employees can&apos;t turn it off
                </label>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p role="alert" className="alert-error">{error}</p>}
    </div>
  );
}
