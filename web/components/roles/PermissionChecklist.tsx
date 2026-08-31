"use client";

import { PERMISSION_GROUPS, permissionLabel } from "@/lib/permissions";
import type { AppPermission } from "@/lib/supabase/types";

export function PermissionChecklist({
  value,
  onChange,
  disabled,
}: {
  value: Set<AppPermission>;
  onChange: (next: Set<AppPermission>) => void;
  disabled?: boolean;
}) {
  function toggle(permission: AppPermission) {
    const next = new Set(value);
    if (next.has(permission)) next.delete(permission);
    else next.add(permission);
    onChange(next);
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {PERMISSION_GROUPS.map((group) => (
        <fieldset key={group.domain} className="rounded-xl border border-stone-200 p-3">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-stone-500">{group.label}</legend>
          <div className="space-y-1.5">
            {group.permissions.map((permission) => (
              <label key={permission} className="flex cursor-pointer items-center gap-2 text-sm text-stone-700">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={value.has(permission)}
                  disabled={disabled}
                  onChange={() => toggle(permission)}
                />
                {permissionLabel(permission)}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
