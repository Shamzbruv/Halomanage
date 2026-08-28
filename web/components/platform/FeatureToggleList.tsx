"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { resolveFunctionErrorMessage } from "@/lib/supabase/functions";

export type FeatureRow = {
  key: string;
  name: string;
  description: string | null;
  enabled: boolean;
  hasOverride: boolean;
  note: string | null;
};

// Every toggle here is organization_feature_overrides, one row per
// (organization, feature). There is deliberately no plan-bundle fallback
// yet (see supabase/migrations/20260828160000_platform_console.sql) — a
// feature is on for an org only because platform staff turned it on here.
export function FeatureToggleList({ organizationId, features }: { organizationId: string; features: FeatureRow[] }) {
  const supabase = createClient();
  const router = useRouter();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(feature: FeatureRow) {
    setPendingKey(feature.key);
    setError(null);
    const { error: rpcError } = await supabase.rpc("platform_set_feature_override", {
      p_org_id: organizationId,
      p_feature_key: feature.key,
      p_enabled: !feature.enabled,
      p_note: null,
    });
    if (rpcError) {
      setError(await resolveFunctionErrorMessage(rpcError, "Could not update this feature."));
      setPendingKey(null);
      return;
    }
    setPendingKey(null);
    router.refresh();
  }

  async function clearOverride(feature: FeatureRow) {
    setPendingKey(feature.key);
    setError(null);
    const { error: rpcError } = await supabase.rpc("platform_clear_feature_override", {
      p_org_id: organizationId,
      p_feature_key: feature.key,
    });
    if (rpcError) {
      setError(await resolveFunctionErrorMessage(rpcError, "Could not clear this override."));
      setPendingKey(null);
      return;
    }
    setPendingKey(null);
    router.refresh();
  }

  return (
    <div>
      {error && <p className="platform-alert-error" style={{ marginBottom: "0.75rem" }}>{error}</p>}
      <ul style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
        {features.map((feature) => (
          <li key={feature.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", padding: "0.6rem 0", borderBottom: "1px solid var(--p-border)" }}>
            <div>
              <strong style={{ fontSize: "0.85rem" }}>{feature.name}</strong>
              {feature.description && <p style={{ margin: 0, color: "var(--p-text-muted)", fontSize: "0.76rem" }}>{feature.description}</p>}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <span className={`platform-badge ${feature.enabled ? "success" : "neutral"}`}>{feature.enabled ? "ON" : "OFF"}</span>
              <button
                type="button"
                disabled={pendingKey === feature.key}
                className="platform-btn platform-btn-secondary"
                onClick={() => void toggle(feature)}
              >
                {pendingKey === feature.key ? "…" : feature.enabled ? "Turn off" : "Turn on"}
              </button>
              {feature.hasOverride && (
                <button
                  type="button"
                  disabled={pendingKey === feature.key}
                  className="platform-btn platform-btn-secondary"
                  onClick={() => void clearOverride(feature)}
                  title="Remove the override entirely"
                >
                  Reset
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
