import { redirect } from "next/navigation";
import { PortalShell } from "@/components/PortalShell";
import { getCurrentSession, highestRole, sessionCan } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { Brand } from "@/components/Brand";
import { Icon } from "@/components/Icon";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (session.dataError) {
    return (
      <div className="workspace-repair-shell">
        <Brand />
        <div className="card workspace-repair-card">
          <span className="empty-state-icon"><Icon name="shield" size={25} /></span>
          <span className="eyebrow">Workspace connection</span>
          <h1>We couldn&apos;t load your organization data.</h1>
          <p>Your account is signed in, but the database did not return its employee or role details. No information has been lost.</p>
          <div className="workspace-repair-actions"><a className="btn-primary" href="/dashboard">Try again</a><a className="btn-secondary" href="/signup/complete">Repair workspace setup</a></div>
        </div>
      </div>
    );
  }
  if (!session.employee || !session.organizationId || session.roles.length === 0 || !session.organization) {
    redirect("/signup/complete?repair=1");
  }

  const role = highestRole(session.roles);
  // Navigation follows the same effective permission bundle as RLS. This
  // keeps custom role bundles and effective-dated promotions/demotions from
  // disagreeing with what the database actually allows.
  const canSeeTeam = sessionCan(session, "employee.read_team") || sessionCan(session, "employee.read_org");
  const canSeeAdmin = sessionCan(session, "organization.manage");
  const name = session.employee
    ? `${session.employee.preferred_name || session.employee.first_name} ${session.employee.last_name}`
    : session.email?.split("@")[0] || "Team member";

  let avatarUrl: string | null = null;
  if (session.employee?.avatar_url) {
    const supabase = await createClient();
    const { data } = await supabase.storage
      .from("employee-avatars")
      .createSignedUrl(session.employee.avatar_url, 3600);
    avatarUrl = data?.signedUrl ?? null;
  }

  return (
    <PortalShell
      avatarUrl={avatarUrl}
      canSeeAdmin={canSeeAdmin}
      canSeeTeam={canSeeTeam}
      email={session.email}
      name={name}
      organizationName={session.organization.name}
      role={role}
    >
      {children}
    </PortalShell>
  );
}
