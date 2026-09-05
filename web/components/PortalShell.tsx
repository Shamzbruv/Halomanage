"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Brand } from "@/components/Brand";
import { HelpTip } from "@/components/HelpTip";
import { Icon, type IconName } from "@/components/Icon";
import { SignOutButton } from "@/components/SignOutButton";

type NavItem = { href: string; label: string; icon: IconName };
type NavGroup = { label: string; items: NavItem[] };

const personalItems: NavGroup[] = [
  {
    label: "Workspace",
    items: [
      { href: "/dashboard", label: "Overview", icon: "dashboard" },
      { href: "/profile", label: "My profile", icon: "profile" },
    ],
  },
  {
    label: "My work",
    items: [
      { href: "/time", label: "Time & attendance", icon: "clock" },
      { href: "/leave", label: "Leave", icon: "leave" },
      { href: "/pay", label: "My pay", icon: "payroll" },
      { href: "/recognition", label: "Recognition", icon: "spark" },
      { href: "/rewards", label: "Rewards", icon: "spark" },
      { href: "/onboarding", label: "Onboarding", icon: "onboarding" },
      { href: "/appraisals", label: "Performance", icon: "performance" },
      { href: "/development", label: "Learning & assets", icon: "spark" },
      { href: "/documents", label: "Documents", icon: "document" },
    ],
  },
];

const adminItems: NavItem[] = [
  { href: "/admin/setup", label: "Setup guide", icon: "spark" },
  { href: "/admin/employees", label: "People", icon: "people" },
  { href: "/admin/migrations", label: "Migration Center", icon: "reports" },
  { href: "/admin/organization", label: "Organization", icon: "organization" },
  { href: "/admin/leave-types", label: "Leave policies", icon: "calendar" },
  { href: "/admin/onboarding", label: "Onboarding setup", icon: "onboarding" },
  { href: "/admin/offboarding", label: "Employee exits", icon: "people" },
  { href: "/admin/appraisals", label: "Performance setup", icon: "performance" },
  { href: "/admin/documents", label: "Document library", icon: "document" },
  { href: "/admin/payroll", label: "Pay records", icon: "payroll" },
  { href: "/admin/compensation-settings", label: "Compensation structure", icon: "payroll" },
  { href: "/admin/pay-calendars", label: "Pay calendars", icon: "calendar" },
  { href: "/admin/rewards", label: "Rewards catalog", icon: "spark" },
  { href: "/admin/reports", label: "Reports", icon: "reports" },
  { href: "/admin/roles", label: "Roles & permissions", icon: "shield" },
  { href: "/admin/security", label: "Identity & access", icon: "shield" },
];

// `help` is the plain-language answer to "what can I do in here, and what
// is this for?" — rendered as a HelpTip next to the page title in the
// topbar below, so it's the same one place for every tab in the app
// rather than something bolted onto each page individually.
const pageTitles: Array<{ pattern: RegExp; title: string; eyebrow: string; help: string }> = [
  { pattern: /^\/dashboard/, title: "Overview", eyebrow: "Your workspace", help: "Your at-a-glance snapshot — pending approvals, today's attendance, and quick actions relevant to your role. It's a summary, not a to-do list you have to clear." },
  { pattern: /^\/profile/, title: "My profile", eyebrow: "Personal workspace", help: "Your own employee record — the fields you're allowed to edit yourself, like contact details and your photo. Employment details such as position, pay, and status are set by HR and shown here read-only." },
  { pattern: /^\/time/, title: "Time & attendance", eyebrow: "Personal workspace", help: "Clock in and out, see your assigned work schedule, and review your attendance history. Spotted a mistake in a past record? Request a correction instead of it being silently overwritten." },
  { pattern: /^\/leave/, title: "Leave", eyebrow: "Personal workspace", help: "Check your available leave balance by type, submit a new request, and track every request through approval." },
  { pattern: /^\/pay/, title: "My pay", eyebrow: "Personal workspace", help: "Yes — this is your salary. See your current rate, next pay date, any allowances or bonuses on top of your base rate, and download a payslip for any approved pay run." },
  { pattern: /^\/recognition/, title: "Recognition", eyebrow: "Personal workspace", help: "Publicly thank a coworker for something they did — with or without points attached, depending on your organization's policy." },
  { pattern: /^\/rewards/, title: "Rewards", eyebrow: "Personal workspace", help: "Spend recognition points you've received on real rewards from your organization's catalog, and track your redemption history." },
  { pattern: /^\/onboarding/, title: "Onboarding", eyebrow: "Personal workspace", help: "Your personal checklist for getting fully set up in a new role — each step, its order, and what's still outstanding." },
  { pattern: /^\/appraisals/, title: "Performance", eyebrow: "Personal workspace", help: "Your performance checkpoints — your own self-reflection, your manager's feedback, and any reviews you've been asked to complete for someone else." },
  { pattern: /^\/development/, title: "Learning & assets", eyebrow: "Personal workspace", help: "Required and optional training assigned to you, professional certifications on file, and company equipment currently in your care." },
  { pattern: /^\/documents/, title: "Documents", eyebrow: "Personal workspace", help: "Files shared with you — contracts, policies, certificates, and HR letters. Anything requiring your acknowledgement stays visible here until you confirm it." },
  { pattern: /^\/team/, title: "Team hub", eyebrow: "Manager workspace", help: "Everyone in your reporting scope in one place — roster, working schedules, leave balances and approvals, and who's currently clocked in." },
  { pattern: /^\/admin\/setup/, title: "Setup guide", eyebrow: "Administration", help: "A checklist for getting a new organization ready to use — people, structure, policies, and templates. Nothing here has to happen in order; it just tracks what's still empty." },
  { pattern: /^\/admin\/employees/, title: "People", eyebrow: "Administration", help: "The master list of everyone in your organization. Create new hires, connect their sign-in account, and see who's active, pre-hire, or exited." },
  { pattern: /^\/admin\/migrations/, title: "Migration Center", eyebrow: "Administration", help: "Bulk-import employees from a spreadsheet export. Every import is a dry run you review and fix before anything is committed to real employee records." },
  { pattern: /^\/admin\/organization/, title: "Organization", eyebrow: "Administration", help: "Your company's structure — departments, positions, and locations — plus the company profile and branding shown on your organization's sign-in page." },
  { pattern: /^\/admin\/leave-types/, title: "Leave policies", eyebrow: "Administration", help: "Define the kinds of leave your organization offers — paid or unpaid, how balances accrue, notice periods, and who has to approve a request." },
  { pattern: /^\/admin\/onboarding/, title: "Onboarding setup", eyebrow: "Administration", help: "Build reusable onboarding templates — the steps every new hire works through — then start the right one for each new employee." },
  { pattern: /^\/admin\/offboarding/, title: "Offboarding", eyebrow: "Administration", help: "The exit counterpart to onboarding — build offboarding templates and start a tracked exit workflow when someone leaves." },
  { pattern: /^\/admin\/appraisals/, title: "Performance setup", eyebrow: "Administration", help: "Design checkpoint templates — probation, quarterly, annual, or anything else — and launch review cycles that assign one to your team." },
  { pattern: /^\/admin\/documents/, title: "Document library", eyebrow: "Administration", help: "Upload and manage the files your organization shares with employees — control who can see each one, whether it expires, and whether it requires acknowledgement." },
  { pattern: /^\/admin\/payroll/, title: "Pay records", eyebrow: "Administration", help: "Import pay-run results your payroll provider already calculated, reconcile them against your employees, and approve the batch. Halomanage never calculates payroll itself." },
  { pattern: /^\/admin\/compensation-settings/, title: "Compensation structure", eyebrow: "Administration", help: "Define the shared pay groups, grades, components, and change reasons that an individual employee's Change Compensation action picks from. Nothing here sets anyone's pay directly." },
  { pattern: /^\/admin\/pay-calendars/, title: "Pay calendars", eyebrow: "Administration", help: "Define pay schedules — weekly, biweekly, monthly, or custom — and generate the actual dated pay periods employees see on My Pay. A calendar with no periods generated yet is why a pay group can look empty." },
  { pattern: /^\/admin\/rewards/, title: "Rewards catalog", eyebrow: "Administration", help: "Manage the reward vendors and products employees can redeem points for, award points directly, and fulfill redemptions once someone claims one." },
  { pattern: /^\/admin\/reports/, title: "Reports", eyebrow: "Administration", help: "Organization-wide numbers in one place — headcount, pending leave, onboarding progress, items about to expire, and payroll batch history." },
  { pattern: /^\/admin\/roles/, title: "Roles & permissions", eyebrow: "Administration", help: "Control what each role can do. Adjust a built-in role's permission bundle for your organization, or create a custom role with exactly the access you need." },
  { pattern: /^\/admin\/security/, title: "Identity & access", eyebrow: "Administration", help: "Configure single sign-on for your organization's email domain and restrict sign-in to approved networks." },
];

function initials(name: string) {
  return name.split(" ").filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function UserAvatar({ name, avatarUrl, small }: { name: string; avatarUrl: string | null; small?: boolean }) {
  return (
    <span className={`user-avatar${small ? " small" : ""}`}>
      {avatarUrl ? <img src={avatarUrl} alt="" /> : initials(name) || "U"}
    </span>
  );
}

function isActive(pathname: string, href: string) {
  if (href === "/dashboard") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function Navigation({ groups, pathname, onNavigate }: { groups: NavGroup[]; pathname: string; onNavigate?: () => void }) {
  return (
    <nav className="portal-nav" aria-label="Primary navigation">
      {groups.map((group) => (
        <div className="portal-nav-group" key={group.label}>
          <p>{group.label}</p>
          <div>
            {group.items.map((item) => (
              <Link
                aria-current={isActive(pathname, item.href) ? "page" : undefined}
                className={isActive(pathname, item.href) ? "active" : ""}
                href={item.href}
                key={item.href}
                onClick={onNavigate}
              >
                <Icon name={item.icon} size={19} />
                <span>{item.label}</span>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}

export function PortalShell({ children, avatarUrl, canSeeAdmin, canSeeTeam, email, name, organizationName, roleLabels }: {
  children: React.ReactNode;
  avatarUrl: string | null;
  canSeeAdmin: boolean;
  canSeeTeam: boolean;
  email: string | null;
  name: string;
  organizationName: string;
  roleLabels: string[];
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileDrawerRef = useRef<HTMLElement>(null);
  const groups = [...personalItems];
  if (canSeeTeam) groups.push({ label: "Team", items: [{ href: "/team", label: "Team hub", icon: "team" }] });
  if (canSeeAdmin) groups.push({ label: "Manage", items: adminItems });

  const page = pageTitles.find((candidate) => candidate.pattern.test(pathname)) ?? { title: "Halomanage", eyebrow: "Workspace", help: null };

  useEffect(() => {
    if (!mobileOpen) return;

    const drawer = mobileDrawerRef.current;
    const previousOverflow = document.body.style.overflow;
    const focusable = drawer?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    const firstFocusable = focusable?.[0];
    const lastFocusable = focusable?.[focusable.length - 1];

    document.body.style.overflow = "hidden";
    firstFocusable?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileOpen(false);
        return;
      }

      if (event.key !== "Tab" || !firstFocusable || !lastFocusable) return;
      if (event.shiftKey && document.activeElement === firstFocusable) {
        event.preventDefault();
        lastFocusable.focus();
      } else if (!event.shiftKey && document.activeElement === lastFocusable) {
        event.preventDefault();
        firstFocusable.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      mobileMenuButtonRef.current?.focus();
    };
  }, [mobileOpen]);

  return (
    <div className="portal-shell">
      <aside className="portal-sidebar">
        <div className="portal-brand-row"><Brand href="/dashboard" inverse /></div>
        <div className="portal-organization">
          <span className="organization-avatar">{initials(organizationName) || "HM"}</span>
          <span><small>Organization</small><strong>{organizationName}</strong></span>
        </div>
        <Navigation groups={groups} pathname={pathname} />
        <div className="portal-account">
          <UserAvatar name={name} avatarUrl={avatarUrl} />
          <span className="portal-account-copy"><strong>{name}</strong><small>{roleLabels.length > 0 ? roleLabels.join(" · ") : email}</small></span>
          <SignOutButton compact />
        </div>
      </aside>

      {mobileOpen && (
        <>
          <button type="button" className="portal-backdrop" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />
          <aside
            aria-label="Mobile navigation"
            aria-modal="true"
            className="portal-mobile-drawer open"
            id="mobile-navigation"
            ref={mobileDrawerRef}
            role="dialog"
          >
            <div className="portal-mobile-drawer-head">
              <Brand href="/dashboard" inverse />
              <button type="button" className="icon-button inverse" aria-label="Close navigation" onClick={() => setMobileOpen(false)}><Icon name="x" /></button>
            </div>
            <div className="portal-organization">
              <span className="organization-avatar">{initials(organizationName) || "HM"}</span>
              <span><small>Organization</small><strong>{organizationName}</strong></span>
            </div>
            <Navigation groups={groups} pathname={pathname} onNavigate={() => setMobileOpen(false)} />
          </aside>
        </>
      )}

      <div className="portal-content">
        <header className="portal-topbar">
          <div className="portal-mobile-brand">
            <button
              aria-controls="mobile-navigation"
              aria-expanded={mobileOpen}
              aria-label="Open navigation"
              className="icon-button"
              onClick={() => setMobileOpen(true)}
              ref={mobileMenuButtonRef}
              type="button"
            ><Icon name="menu" /></button>
            <Brand href="/dashboard" compact />
          </div>
          <div className="portal-page-title"><span>{page.eyebrow}</span><h1>{page.title}{page.help && <HelpTip title={page.title}>{page.help}</HelpTip>}</h1></div>
          <div className="portal-topbar-actions">
            <Link href="/profile" className="topbar-profile" aria-label="Open my profile">
              <UserAvatar name={name} avatarUrl={avatarUrl} small />
              <span className="topbar-profile-copy"><strong>{name}</strong><small>{email}</small></span>
            </Link>
          </div>
        </header>
        <main className="portal-main" id="main-content" tabIndex={-1}>{children}</main>
      </div>
    </div>
  );
}
