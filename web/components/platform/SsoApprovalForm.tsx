"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { resolveFunctionErrorMessage } from "@/lib/supabase/functions";

export type SsoRequestRow = {
  id: string;
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  domain: string;
  metadata_url: string | null;
  sso_provider_id: string | null;
  status: string;
  enforce_sso: boolean;
  requested_at: string;
  activated_at: string | null;
  last_error: string | null;
};

// This replaces the raw-SQL-against-production step the SSO admin page's
// own copy warns tenants about ("a trusted platform operator" — see
// web/app/(portal)/admin/security/page.tsx). The actual SAML metadata
// exchange with the identity provider still happens outside Halomanage;
// this just records the outcome.
export function SsoApprovalForm({ request }: { request: SsoRequestRow }) {
  const supabase = createClient();
  const router = useRouter();
  const [status, setStatus] = useState(request.status);
  const [providerId, setProviderId] = useState(request.sso_provider_id ?? "");
  const [enforceSso, setEnforceSso] = useState(request.enforce_sso);
  const [lastError, setLastError] = useState(request.last_error ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setLoading(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("platform_update_identity_provider", {
      p_id: request.id,
      p_status: status,
      p_sso_provider_id: providerId.trim() || null,
      p_enforce_sso: enforceSso,
      p_last_error: lastError.trim() || null,
    });
    if (rpcError) {
      setError(await resolveFunctionErrorMessage(rpcError, "Could not update this connection."));
      setLoading(false);
      return;
    }
    setLoading(false);
    router.refresh();
  }

  return (
    <div className="platform-card">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.5rem" }}>
        <div>
          <strong>{request.organization_name}</strong>
          <span style={{ marginLeft: "0.5rem", color: "var(--p-text-muted)", fontSize: "0.78rem" }}>{request.domain}</span>
        </div>
        <span className="platform-badge accent">{request.status}</span>
      </div>
      {request.metadata_url && (
        <p style={{ fontSize: "0.78rem", color: "var(--p-text-muted)", wordBreak: "break-all", marginBottom: "0.75rem" }}>
          Metadata: {request.metadata_url}
        </p>
      )}
      <div style={{ display: "grid", gap: "0.75rem", gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
        <div>
          <label className="platform-label" htmlFor={`status-${request.id}`}>Status</label>
          <select id={`status-${request.id}`} className="platform-select" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="requested">requested</option>
            <option value="configuring">configuring</option>
            <option value="active">active</option>
            <option value="error">error</option>
            <option value="disabled">disabled</option>
          </select>
        </div>
        <div>
          <label className="platform-label" htmlFor={`provider-${request.id}`}>SSO provider ID</label>
          <input id={`provider-${request.id}`} className="platform-input" value={providerId} onChange={(event) => setProviderId(event.target.value)} placeholder="okta|acme-corp" />
        </div>
        <div>
          <label className="platform-label" htmlFor={`enforce-${request.id}`} style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
            <input id={`enforce-${request.id}`} type="checkbox" checked={enforceSso} onChange={(event) => setEnforceSso(event.target.checked)} />
            Require SSO (disable password sign-in)
          </label>
        </div>
        <div>
          <label className="platform-label" htmlFor={`error-${request.id}`}>Setup note / error</label>
          <input id={`error-${request.id}`} className="platform-input" value={lastError} onChange={(event) => setLastError(event.target.value)} />
        </div>
      </div>
      {error && <p className="platform-alert-error" style={{ marginTop: "0.75rem" }}>{error}</p>}
      <div style={{ marginTop: "0.9rem" }}>
        <button type="button" disabled={loading} className="platform-btn platform-btn-primary" onClick={() => void handleSave()}>
          {loading ? "Saving…" : "Save connection"}
        </button>
      </div>
    </div>
  );
}
