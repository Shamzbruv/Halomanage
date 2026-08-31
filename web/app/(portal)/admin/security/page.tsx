import { redirect } from "next/navigation";
import { Icon } from "@/components/Icon";
import { SsoRequestForm } from "@/components/SsoRequestForm";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

type IdentityProvider = {
  id: string;
  domain: string;
  metadata_url: string | null;
  status: "requested" | "configuring" | "active" | "error" | "disabled";
  enforce_sso: boolean;
  requested_at: string;
  activated_at: string | null;
  last_error: string | null;
};

const statusStyles: Record<IdentityProvider["status"], string> = {
  requested: "badge-neutral",
  configuring: "badge-gold",
  active: "badge-emerald",
  error: "badge-ruby",
  disabled: "badge-neutral",
};

export default async function SecurityAdminPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!sessionCan(session, "organization.manage") || !session.organizationId) redirect("/dashboard");

  const supabase = await createClient();
  const [{ data }, { data: ssoEnabled }] = await Promise.all([
    supabase
      .from("organization_identity_providers")
      .select("id, domain, metadata_url, status, enforce_sso, requested_at, activated_at, last_error")
      .eq("organization_id", session.organizationId)
      .order("requested_at", { ascending: false }),
    supabase.rpc("organization_has_feature", { p_org_id: session.organizationId, p_feature_key: "sso" }),
  ]);
  const providers = (data ?? []) as IdentityProvider[];
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://YOUR_PROJECT.supabase.co";

  return (
    <div className="space-y-6">
      <div className="page-intro">
        <span className="eyebrow">Identity &amp; access</span>
        <h1>Connect the way your organization signs in.</h1>
        <p>Request a SAML connection for Microsoft Entra ID, Okta, Google Workspace, or another compatible identity provider. Halomanage keeps activation and enforcement behind a trusted platform-operator boundary.</p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <section className="card space-y-5" aria-labelledby="sso-connections-title">
          <div>
            <span className="eyebrow">Enterprise SSO</span>
            <h2 id="sso-connections-title" className="mt-1 text-lg font-semibold text-stone-900">SAML connections</h2>
          </div>
          {providers.length === 0 ? (
            <div className="empty-state compact">
              <span className="empty-state-icon"><Icon name="shield" size={22} /></span>
              <h3>No identity provider requested yet</h3>
              <p>Save your company domain and optional metadata URL to begin the secure setup.</p>
            </div>
          ) : (
            <ul className="space-y-3">
              {providers.map((provider) => (
                <li key={provider.id} className="rounded-2xl border border-stone-200 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong className="text-sm text-stone-900">{provider.domain}</strong>
                    <span className={`badge ${statusStyles[provider.status]}`}>{provider.status}</span>
                  </div>
                  <p className="mt-2 text-xs text-stone-500">
                    Requested {new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(provider.requested_at))}
                    {provider.enforce_sso ? " · SSO required" : " · Password sign-in remains available"}
                  </p>
                  {provider.last_error && <p className="mt-2 text-xs text-red-700">Setup note: {provider.last_error}</p>}
                </li>
              ))}
            </ul>
          )}
          {ssoEnabled ? (
            <SsoRequestForm organizationId={session.organizationId} />
          ) : (
            <div className="empty-state compact">
              <span className="empty-state-icon"><Icon name="shield" size={22} /></span>
              <h3>SSO isn&apos;t enabled for your organization yet</h3>
              <p>Contact your Halomanage account team to turn on single sign-on.</p>
            </div>
          )}
        </section>

        <aside className="card space-y-4" aria-labelledby="sso-provider-values-title">
          <div>
            <span className="eyebrow">Provider configuration</span>
            <h2 id="sso-provider-values-title" className="mt-1 text-lg font-semibold text-stone-900">Share these values with IT</h2>
          </div>
          <dl className="space-y-3 text-sm">
            <div><dt className="text-xs font-semibold uppercase tracking-wide text-stone-500">Entity ID / metadata</dt><dd className="mt-1 break-all rounded-lg bg-stone-50 p-2 font-mono text-xs">{supabaseUrl}/auth/v1/sso/saml/metadata</dd></div>
            <div><dt className="text-xs font-semibold uppercase tracking-wide text-stone-500">ACS / reply URL</dt><dd className="mt-1 break-all rounded-lg bg-stone-50 p-2 font-mono text-xs">{supabaseUrl}/auth/v1/sso/saml/acs</dd></div>
          </dl>
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            SSO activation requires a Supabase plan with SAML support and a trusted operator to verify the domain and provider metadata. Tenant administrators cannot self-activate or forge a provider ID.
          </div>
        </aside>
      </div>
    </div>
  );
}
