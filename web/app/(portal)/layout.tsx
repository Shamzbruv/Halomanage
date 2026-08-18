import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentSession, highestRole } from "@/lib/session";
import { SignOutButton } from "@/components/SignOutButton";

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
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-6">
            <Link href="/dashboard" className="flex items-center gap-2 font-semibold text-slate-900">
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white">
                H
              </span>
              Halomanage
            </Link>
            <nav className="flex items-center gap-4 text-sm text-slate-600">
              <Link href="/dashboard" className="hover:text-slate-900">Dashboard</Link>
              <Link href="/leave" className="hover:text-slate-900">Leave</Link>
              {canSeeTeam && <Link href="/team" className="hover:text-slate-900">Team</Link>}
              {canSeeAdmin && <Link href="/admin/employees" className="hover:text-slate-900">Employees</Link>}
              {canSeeAdmin && <Link href="/admin/payroll" className="hover:text-slate-900">Payroll</Link>}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className="badge bg-slate-100 text-slate-600">{role ?? "no role"}</span>
            <span className="text-sm text-slate-600">{session.email}</span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
