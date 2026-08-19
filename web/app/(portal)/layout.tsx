import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentSession, highestRole } from "@/lib/session";
import { SignOutButton } from "@/components/SignOutButton";
import { NavDropdown } from "@/components/NavDropdown";
import { roleBadgeClass } from "@/lib/ui";

// One shell for all four portals (PRODUCT_BLUEPRINT.md: "Recommended
// portal design" / ARCHITECTURE.md: "Portals, RBAC and RLS authorization").
// Which nav links render is a UX convenience computed from the roles this
// person actually holds — it is NOT the security boundary. Every page and
// every query behind these links is independently protected by RLS, so a
// hidden link is not what stops unauthorized access; the database is.
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const session = await getCurrentSession();
  if (!session) redirect("/login");

  const role = highestRole(session.roles);
  const canSeeTeam = session.roles.some((r) => r === "supervisor" || r === "manager" || r === "admin");
  const canSeeAdmin = session.roles.includes("admin");

  return (
    <div className="min-h-screen">
      <header className="app-header sticky top-0 z-20 mb-3">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-7">
            <Link href="/dashboard" className="flex items-center gap-2.5">
              <span className="crest">H</span>
              <span className="font-display text-lg font-bold text-cream-50" style={{ textShadow: "0 1px 2px rgba(0,0,0,0.35)" }}>
                Halomanage
              </span>
            </Link>
            <nav className="hidden items-center gap-5 text-sm font-medium text-royal-100/85 md:flex">
              <Link href="/dashboard" className="transition-colors hover:text-gold-200">Dashboard</Link>
              <Link href="/leave" className="transition-colors hover:text-gold-200">Leave</Link>
              <Link href="/onboarding" className="transition-colors hover:text-gold-200">Onboarding</Link>
              <Link href="/appraisals" className="transition-colors hover:text-gold-200">Appraisals</Link>
              <Link href="/documents" className="transition-colors hover:text-gold-200">Documents</Link>
              <Link href="/profile" className="transition-colors hover:text-gold-200">Profile</Link>
              {canSeeTeam && <Link href="/team" className="transition-colors hover:text-gold-200">Team</Link>}
              {canSeeAdmin && (
                <NavDropdown label="Admin ▾">
                  <Link href="/admin/employees">Employees</Link>
                  <Link href="/admin/organization">Organization</Link>
                  <Link href="/admin/leave-types">Leave types</Link>
                  <Link href="/admin/onboarding">Onboarding setup</Link>
                  <Link href="/admin/appraisals">Appraisals setup</Link>
                  <Link href="/admin/documents">Documents</Link>
                  <Link href="/admin/payroll">Payroll</Link>
                  <Link href="/admin/reports">Reports</Link>
                </NavDropdown>
              )}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className={`badge ${roleBadgeClass(role)}`}>{role ?? "no role"}</span>
            <Link href="/profile" className="hidden text-sm font-medium text-royal-100/85 transition-colors hover:text-gold-200 sm:inline">
              {session.email}
            </Link>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
