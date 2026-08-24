import { redirect } from "next/navigation";
import { PortalShell } from "@/components/PortalShell";
import { getCurrentSession, highestRole } from "@/lib/session";
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
  const canSeeTeam = session.roles.some((item) => item === "supervisor" || item === "manager" || item === "admin");
  const canSeeAdmin = session.roles.includes("admin");
  const name = session.employee
    ? `${session.employee.preferred_name || session.employee.first_name} ${session.employee.last_name}`
    : session.email?.split("@")[0] || "Team member";

  return (
    <PortalShell
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
