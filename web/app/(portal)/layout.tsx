import { redirect } from "next/navigation";
import { PortalShell } from "@/components/PortalShell";
import { getCurrentSession, highestRole } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const session = await getCurrentSession();
  if (!session) redirect("/login");

  const role = highestRole(session.roles);
  const canSeeTeam = session.roles.some((item) => item === "supervisor" || item === "manager" || item === "admin");
  const canSeeAdmin = session.roles.includes("admin");
  const name = session.employee
    ? `${session.employee.preferred_name || session.employee.first_name} ${session.employee.last_name}`
    : session.email?.split("@")[0] || "Team member";

  let organizationName = "Your organization";
  if (session.organizationId) {
    const supabase = await createClient();
    const { data: organization } = await supabase
      .from("organizations")
      .select("name")
      .eq("id", session.organizationId)
      .maybeSingle();
    if (organization?.name) organizationName = organization.name;
  }

  return (
    <PortalShell
      canSeeAdmin={canSeeAdmin}
      canSeeTeam={canSeeTeam}
      email={session.email}
      name={name}
      organizationName={organizationName}
      role={role}
    >
      {children}
    </PortalShell>
  );
}
