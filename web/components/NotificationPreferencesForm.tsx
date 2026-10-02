"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { NOTIFICATION_GROUPS, type NotificationGroup, type RequiredState } from "@/lib/notifications";

// In-app preferences (notification_preferences, channel 'in_app'). Which
// groups are required comes from the database — HaloManage's system-critical
// notices plus the organization's own policy — and the database also
// refuses an opt-out of a required notification, so this is only the
// friendly face of a rule enforced underneath. Email/SMS aren't live yet,
// so no channel choices are offered.
export function NotificationPreferencesForm({
  userId,
  organizationId,
  disabledTypes,
  requirements,
}: {
  userId: string;
  organizationId: string;
  // notification_type values with an explicit enabled=false row for this
  // user (in_app). No row means enabled — the table is opt-out.
  disabledTypes: string[];
  requirements: Record<string, RequiredState>;
}) {
  const supabase = createClient();
  const disabled = new Set(disabledTypes);
  const [state, setState] = useState<Record<string, boolean>>(
    Object.fromEntries(NOTIFICATION_GROUPS.map((g) => [g.key, !g.types.every((t) => disabled.has(t))])),
  );
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleToggle(group: NotificationGroup, nextEnabled: boolean) {
    setPending(group.key);
    setError(null);
    const result = nextEnabled
      ? await supabase
          .from("notification_preferences")
          .delete()
          .eq("user_id", userId)
          .eq("organization_id", organizationId)
          .eq("channel", "in_app")
          .in("notification_type", group.types)
      : await supabase
          .from("notification_preferences")
          .upsert(
            group.types.map((notification_type) => ({ user_id: userId, organization_id: organizationId, notification_type, channel: "in_app", enabled: false })),
            { onConflict: "user_id,organization_id,notification_type,channel" },
          );
    setPending(null);
    if (result.error) {
      setError(result.error.message);
      return;
    }
    setState((s) => ({ ...s, [group.key]: nextEnabled }));
  }

  return (
    <ul className="space-y-3">
      {NOTIFICATION_GROUPS.map((group) => {
        const requirement = requirements[group.key] ?? { required: false, system: false };
        return (
          <li key={group.key} className="flex items-start justify-between gap-4 rounded-lg bg-cream-100 px-3 py-2.5">
            <div>
              <p className="text-sm font-medium text-stone-900">{group.label}</p>
              <p className="text-xs text-stone-500">{group.description}</p>
            </div>
            {requirement.required ? (
              <span className="badge badge-neutral shrink-0" title={requirement.system ? "Required for every HaloManage organization" : "Required by your organization"}>
                {requirement.system ? "Always on" : "Required by your organization"}
              </span>
            ) : (
              <label className="flex shrink-0 items-center gap-2 pt-0.5 text-xs text-stone-500">
                <input type="checkbox" checked={state[group.key]} disabled={pending === group.key} onChange={(e) => handleToggle(group, e.target.checked)} />
                Notify me
              </label>
            )}
          </li>
        );
      })}
      {error && <p className="alert-error">{error}</p>}
    </ul>
  );
}
