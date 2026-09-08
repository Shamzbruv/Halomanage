import { redirect } from "next/navigation";
import { PortalShell } from "@/components/PortalShell";
import { getCurrentSession, sessionCan } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import type { AppPermission } from "@/lib/supabase/types";
import { Brand } from "@/components/Brand";
import { Icon } from "@/components/Icon";
import { SignOutButton } from "@/components/SignOutButton";

// One href → required-permission map, kept in sync with each admin page's
// own route guard (grep `sessionCan(session,` under app/(portal)/admin/*)
// so this list can never disagree with what a page actually enforces.
// Previously canSeeAdmin alone decided whether the whole "Manage" section
// rendered, and every item inside it always rendered once that was true —
// a custom role scoped to, say, only roles.manage saw links to every other
// admin page too, each one a dead end that silently bounced to /dashboard.
// Documented as a known "cosmetic rough edge" in ARCHITECTURE.md; fixing it
// here so a narrowly-scoped role's nav matches what it can actually open.
const ADMIN_PAGE_PERMISSIONS: Record<string, AppPermission[]> = {
  "/admin/setup": ["organization.manage"],
  "/admin/employees": ["employee.manage"],
  "/admin/migrations": ["employee.manage"],
  "/admin/organization": ["organization.manage"],
  "/admin/leave-types": ["leave.manage_policies"],
  "/admin/onboarding": ["onboarding.manage_templates"],
  "/admin/offboarding": ["employee.manage"],
  "/admin/appraisals": ["appraisal.manage_cycles"],
  "/admin/documents": ["documents.manage_org"],
  "/admin/development": ["training.manage", "assets.manage"],
  "/admin/payroll": ["payroll.import"],
  "/admin/compensation-settings": ["compensation.manage_structure"],
  "/admin/pay-calendars": ["pay_calendar.read", "pay_calendar.manage"],
  "/admin/rewards": ["rewards.manage_catalog", "rewards.award_points", "rewards.fulfill"],
  "/admin/reports": ["reports.org"],
  "/admin/roles": ["roles.manage"],
  "/admin/security": ["organization.manage"],
};

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (session.dataError) {
    // This card previously had no working way out: "Try again" reloads the
    // same page (useless if the underlying cause isn't transient) and
    // "Repair workspace setup" is a different flow entirely — for a
    // genuinely broken org/employee record, not a stuck session. Someone
    // whose browser holds a stale or already-revoked session (e.g. they
    // signed out in another tab, or the cookie is mid-refresh) had no
    // button anywhere on this screen to actually sign out and get a clean
    // login — SignOutButton fixes that directly, and doesn't depend on
    // correctly diagnosing which of many possible error shapes caused this.
    return (
      <div className="workspace-repair-shell">
        <Brand />
        <div className="card workspace-repair-card">
          <span className="empty-state-icon"><Icon name="shield" size={25} /></span>
          <span className="eyebrow">Workspace connection</span>
          <h1>We couldn&apos;t load your organization data.</h1>
          <p>This can happen when a session is stale — signing out and back in almost always fixes it. No information has been lost.</p>
          <div className="workspace-repair-actions">
            <SignOutButton className="btn-primary" />
            <a className="btn-secondary" href="/dashboard">Try again</a>
          </div>
          <p className="mt-3 text-xs text-stone-500">
            Still stuck after signing back in? <a className="text-royal-700 hover:text-royal-800" href="/signup/complete">Repair workspace setup</a>.
          </p>
        </div>
      </div>
    );
  }
  // session.roles only ever holds the 4 built-in role values — someone
  // holding ONLY a custom organization role (see
  // 20260831100000_custom_organization_roles.sql) would incorrectly look
  // "roleless" here and get bounced into workspace repair forever.
  // roleLabels covers both, so it's the right "does this person hold
  // anything at all" check.
  if (!session.employee || !session.organizationId || session.roleLabels.length === 0 || !session.organization) {
    redirect("/signup/complete?repair=1");
  }

  // Navigation follows the same effective permission bundle as RLS. This
  // keeps custom role bundles and effective-dated promotions/demotions from
  // disagreeing with what the database actually allows.
  const canSeeTeam = sessionCan(session, "employee.read_team") || sessionCan(session, "employee.read_org");
  // "Manage" is shown if any admin page underneath it would actually let
  // this person in — not just organization.manage, so a custom role
  // granted a narrower slice (e.g. just roles.manage, or just
  // payroll.import) still sees its own section instead of a nav with no
  // way to reach a page it's fully authorized to use.
  const canSeeAdmin = [
    "organization.manage",
    "employee.manage",
    "leave.manage_policies",
    "onboarding.manage_templates",
    "appraisal.manage_cycles",
    "documents.manage_org",
    "training.manage",
    "assets.manage",
    "payroll.import",
    "compensation.manage_structure",
    "pay_calendar.manage",
    "pay_calendar.read",
    "rewards.manage_catalog",
    "rewards.award_points",
    "rewards.fulfill",
    "reports.org",
    "roles.manage",
  ].some((permission) => sessionCan(session, permission as Parameters<typeof sessionCan>[1]));
  // The per-item counterpart to canSeeAdmin above: which of those hrefs this
  // session can actually open, not just whether the section header should
  // render at all.
  const visibleAdminHrefs = Object.entries(ADMIN_PAGE_PERMISSIONS)
    .filter(([, permissions]) => permissions.some((permission) => sessionCan(session, permission)))
    .map(([href]) => href);
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
      roleLabels={session.roleLabels}
      visibleAdminHrefs={visibleAdminHrefs}
    >
      {children}
    </PortalShell>
  );
}
