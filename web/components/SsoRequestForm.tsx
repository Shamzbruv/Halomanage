"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function SsoRequestForm({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const [domain, setDomain] = useState("");
  const [metadataUrl, setMetadataUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);
    const supabase = createClient();
    const { error: requestError } = await supabase.rpc("request_organization_sso", {
      p_organization_id: organizationId,
      p_domain: domain,
      p_metadata_url: metadataUrl || null,
    });

    if (requestError) {
      setError(requestError.message);
      setLoading(false);
      return;
    }

    setDomain("");
    setMetadataUrl("");
    setMessage("SSO connection request saved. A platform operator can now complete the trusted provider setup.");
    setLoading(false);
    router.refresh();
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <div>
        <label className="label" htmlFor="sso-domain">Verified company domain</label>
        <input
          id="sso-domain"
          className="input"
          type="text"
          required
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          placeholder="example.com"
          value={domain}
          onChange={(event) => setDomain(event.target.value.trim().toLowerCase())}
          aria-describedby="sso-domain-help"
        />
        <p id="sso-domain-help" className="field-help">Employees with this email domain will be routed to your identity provider.</p>
      </div>
      <div>
        <label className="label" htmlFor="sso-metadata-url">SAML metadata URL <span className="font-normal text-stone-500">(optional)</span></label>
        <input
          id="sso-metadata-url"
          className="input"
          type="url"
          inputMode="url"
          placeholder="https://idp.example.com/metadata"
          value={metadataUrl}
          onChange={(event) => setMetadataUrl(event.target.value)}
        />
      </div>
      {error && <p className="alert-error" role="alert">{error}</p>}
      {message && <p className="alert-success" role="status">{message}</p>}
      <button className="btn-primary" type="submit" disabled={loading}>
        {loading ? "Saving request…" : "Request SSO connection"}
      </button>
    </form>
  );
}
