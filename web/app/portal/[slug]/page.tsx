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

  return (
    <main className="employee-portal-shell">
      <section className="employee-portal-brand-panel">
        <Brand inverse />
        <div className="employee-portal-company">
          <span className="organization-avatar large">{portal.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase()}</span>
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
          <LoginForm portal={{ name: portal.name, slug: portal.slug }} />
          <p className="auth-form-footer">Need an account? Ask your HR administrator to invite you from the People directory.</p>
        </div>
      </section>
    </main>
  );
}
