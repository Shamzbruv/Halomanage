import Link from "next/link";
import { notFound } from "next/navigation";
import { Brand } from "@/components/Brand";
import { Icon } from "@/components/Icon";
import { LoginForm } from "@/components/LoginForm";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type PortalDetails = {
  name: string;
  slug: string;
  portal_title: string;
  portal_message: string;
  logo_path: string | null;
  primary_color: string;
  accent_color: string;
};

type IdentityOptions = {
  sso_available: boolean;
  sso_enforced: boolean;
  sso_domain: string | null;
};

export default async function EmployeePortalPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!/^[a-z0-9][a-z0-9-]{1,49}$/.test(slug)) notFound();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_organization_portal", { p_slug: slug });
  if (error) {
    console.error("employee portal: organization lookup failed", { code: error.code });
    notFound();
  }

  const portal = (Array.isArray(data) ? data[0] : data) as PortalDetails | undefined;
  if (!portal) notFound();
  const { data: identityData } = await supabase.rpc("get_portal_identity_options", { p_slug: slug });
  const identity = (Array.isArray(identityData) ? identityData[0] : identityData) as IdentityOptions | undefined;
  const logoUrl = portal.logo_path
    ? supabase.storage.from("organization-branding").getPublicUrl(portal.logo_path).data.publicUrl
    : null;

  return (
    <main
      className="employee-portal-shell"
      id="main-content"
      tabIndex={-1}
      style={{ "--portal-primary": portal.primary_color, "--portal-accent": portal.accent_color } as React.CSSProperties}
    >
      <section className="employee-portal-brand-panel" style={{ background: portal.primary_color }}>
        <Brand inverse tagline />
        <div className="employee-portal-company">
          {logoUrl ? (
            <img className="organization-avatar large employee-portal-logo" src={logoUrl} alt={`${portal.name} logo`} />
          ) : (
            <span className="organization-avatar large">{portal.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase()}</span>
          )}
          <span className="eyebrow">Employee workspace</span>
          <h1>{portal.portal_title}</h1>
          <p>{portal.portal_message}</p>
        </div>
        <div className="employee-portal-features">
          <span><Icon name="clock" size={18} /><strong>Start and end your shift</strong><small>Trusted server-recorded time</small></span>
          <span><Icon name="leave" size={18} /><strong>Request time away</strong><small>Balances and approvals together</small></span>
          <span><Icon name="document" size={18} /><strong>Manage your employee record</strong><small>Documents, onboarding, and growth</small></span>
        </div>
      </section>
      <section className="employee-portal-login-panel">
        <div className="employee-portal-login-top"><Brand /><Link href="/">Halomanage home</Link></div>
        <div className="auth-card employee-portal-login-card">
          <div className="auth-card-header"><span className="eyebrow">{portal.name}</span><h2>Employee sign in</h2><p>Use the work email address connected to your employee account.</p></div>
          <LoginForm portal={{
            name: portal.name,
            slug: portal.slug,
            ssoAvailable: identity?.sso_available ?? false,
            ssoEnforced: identity?.sso_enforced ?? false,
            ssoDomain: identity?.sso_domain ?? null,
          }} />
          <p className="auth-form-footer">Need an account? Ask your HR administrator to invite you from the People directory.</p>
        </div>
      </section>
    </main>
  );
}
