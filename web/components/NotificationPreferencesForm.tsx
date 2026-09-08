"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

// One friendly toggle can cover several raw notification_type strings (see
// private.create_notification()'s call sites across the migrations for the
// authoritative list) — nobody thinks in terms of "rewards.redemption_
// cancelled" as a distinct concept from "rewards.points_awarded". Only the
// in_app channel is wired to notification_preferences today
// (create_notification() is the only reader, and only checks channel =
// 'in_app'); email/SMS/push delivery isn't live yet (see ROADMAP.md), so
// this only controls what shows up in-app, not a promise about email you
// aren't receiving anyway.
const CATEGORIES: { key: string; label: string; description: string; types: string[] }[] = [
  {
    key: "leave",
    label: "Leave requests & decisions",
    description: "A team member requests leave you can approve, or your own request is decided.",
    types: ["leave.requested", "leave.approved", "leave.rejected"],
  },
  {
    key: "onboarding",
    label: "Onboarding tasks",
    description: "A new onboarding task is assigned to you.",
    types: ["onboarding.task_assigned"],
  },
  {
    key: "rewards",
    label: "Rewards & recognition",
    description: "Points awarded to you, a redemption's status, or a coworker recognizing you.",
    types: ["rewards.points_awarded", "rewards.redemption_fulfilled", "rewards.redemption_cancelled", "rewards.redemption_failed", "recognition.received"],
  },
  {
    key: "documents",
    label: "Document requests",
    description: "A document you requested from HR is ready or declined.",
    types: ["document_request.fulfilled", "document_request.rejected"],
  },
];

export function NotificationPreferencesForm({
  userId,
  organizationId,
  disabledTypes,
}: {
  userId: string;
  organizationId: string;
  // notification_type values that already have an explicit enabled=false
  // row for this user (channel='in_app'). No row for a type means enabled
  // — the preferences table is opt-out, not opt-in.
  disabledTypes: string[];
}) {
  const supabase = createClient();
  const disabled = new Set(disabledTypes);
  const [state, setState] = useState<Record<string, boolean>>(
    Object.fromEntries(CATEGORIES.map((c) => [c.key, !c.types.every((t) => disabled.has(t))])),
  );
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleToggle(category: (typeof CATEGORIES)[number], nextEnabled: boolean) {
    setPending(category.key);
    setError(null);
    const result = nextEnabled
      ? await supabase
          .from("notification_preferences")
          .delete()
          .eq("user_id", userId)
          .eq("organization_id", organizationId)
          .eq("channel", "in_app")
          .in("notification_type", category.types)
      : await supabase
          .from("notification_preferences")
          .upsert(
            category.types.map((notification_type) => ({
              user_id: userId,
              organization_id: organizationId,
              notification_type,
              channel: "in_app",
              enabled: false,
            })),
            { onConflict: "user_id,organization_id,notification_type,channel" },
          );
    setPending(null);
    if (result.error) {
      setError(result.error.message);
      return;
    }
    setState((s) => ({ ...s, [category.key]: nextEnabled }));
  }

  return (
    <ul className="space-y-3">
      {CATEGORIES.map((category) => (
        <li key={category.key} className="flex items-start justify-between gap-4 rounded-lg bg-cream-100 px-3 py-2.5">
          <div>
            <p className="text-sm font-medium text-stone-900">{category.label}</p>
            <p className="text-xs text-stone-500">{category.description}</p>
          </div>
          <label className="flex shrink-0 items-center gap-2 pt-0.5 text-xs text-stone-500">
            <input
              type="checkbox"
              checked={state[category.key]}
              disabled={pending === category.key}
              onChange={(e) => handleToggle(category, e.target.checked)}
            />
            Notify me
          </label>
        </li>
      ))}
      {error && <p className="alert-error">{error}</p>}
    </ul>
  );
}
