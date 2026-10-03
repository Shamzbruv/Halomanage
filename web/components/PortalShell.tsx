"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Brand } from "@/components/Brand";
import { ClockWidget } from "@/components/clock/Clock";
import type { ClockView } from "@/lib/clock";
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
      { href: "/settings", label: "Settings", icon: "settings" },
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
  { href: "/admin/attendance", label: "Time & attendance", icon: "clock" },
  { href: "/admin/onboarding", label: "Onboarding setup", icon: "onboarding" },
  { href: "/admin/offboarding", label: "Employee exits", icon: "people" },
  { href: "/admin/appraisals", label: "Performance setup", icon: "performance" },
  { href: "/admin/documents", label: "Document library", icon: "document" },
  { href: "/admin/development", label: "Learning & assets", icon: "spark" },
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
  { pattern: /^\/profile/, title: "My profile", eyebrow: "Personal workspace", help: "Your official employee record — what your employer has on file about you. Keep your own contact details current; employment details are set by HR and shown read-only, and you can request a correction if anything is wrong." },
  { pattern: /^\/settings/, title: "Settings", eyebrow: "Personal workspace", help: "Your account — which notifications appear in your bell, your sign-in method, password and multi-factor authentication, recent sign-in activity, and signing out other devices. Your employee record itself is under My profile." },
  { pattern: /^\/time/, title: "Time & attendance", eyebrow: "Personal workspace", help: "Clock in and out, see your assigned work schedule, and review your attendance history. Spotted a mistake in a past record? Request a correction instead of it being silently overwritten." },
  { pattern: /^\/leave/, title: "Leave", eyebrow: "Personal workspace", help: "Check your available leave balance by type, submit a new request, and track every request through approval." },
  { pattern: /^\/pay/, title: "My pay", eyebrow: "Personal workspace", help: "Yes — this is your salary. See your current rate, next pay date, any allowances or bonuses on top of your base rate, and download a payslip for any approved pay run." },
  { pattern: /^\/recognition/, title: "Recognition", eyebrow: "Personal workspace", help: "Publicly thank a coworker for something they did — with or without points attached, depending on your organization's policy." },
  { pattern: /^\/rewards/, title: "Rewards", eyebrow: "Personal workspace", help: "Spend recognition points you've received on real rewards from your organization's catalog, and track your redemption history." },
  { pattern: /^\/onboarding/, title: "Onboarding", eyebrow: "Personal workspace", help: "Your personal checklist for getting fully set up in a new role — each step, its order, and what's still outstanding." },
  { pattern: /^\/appraisals/, title: "Performance", eyebrow: "Personal workspace", help: "Your performance checkpoints — your own self-reflection, your manager's feedback, and any reviews you've been asked to complete for someone else." },
  { pattern: /^\/development/, title: "Learning & assets", eyebrow: "Personal workspace", help: "Required and optional training assigned to you, professional certifications on file, and company equipment currently in your care." },
  { pattern: /^\/documents/, title: "Documents", eyebrow: "Personal workspace", help: "Files shared with you — contracts, policies, certificates, and HR letters. Anything requiring your acknowledgement stays visible here until you confirm it. Don't see something you need, like a job letter? Request it from here too." },
  { pattern: /^\/team\/attendance/, title: "Team attendance", eyebrow: "Manager workspace", help: "Decide attendance corrections and overtime for the people in your scope, see who is working, late, absent or on leave on any day, and review exceptions over a period. Approved leave and holidays are never counted as absences." },
  { pattern: /^\/team/, title: "Team hub", eyebrow: "Manager workspace", help: "Everyone in your reporting scope in one place — roster, working schedules, leave balances and approvals, and who's currently clocked in." },
  { pattern: /^\/admin\/setup/, title: "Setup guide", eyebrow: "Administration", help: "A checklist for getting a new organization ready to use — people, structure, policies, and templates. Nothing here has to happen in order; it just tracks what's still empty." },
  { pattern: /^\/admin\/employees/, title: "People", eyebrow: "Administration", help: "The master list of everyone in your organization. Create new hires, connect their sign-in account, and see who's active, pre-hire, or exited." },
  { pattern: /^\/admin\/migrations/, title: "Migration Center", eyebrow: "Administration", help: "Bulk-import employees from a spreadsheet export. Every import is a dry run you review and fix before anything is committed to real employee records." },
  { pattern: /^\/admin\/organization/, title: "Organization", eyebrow: "Administration", help: "Your company's structure — departments, positions, and locations — plus the company profile and branding shown on your organization's sign-in page." },
  { pattern: /^\/admin\/leave-types/, title: "Leave policies", eyebrow: "Administration", help: "Define the kinds of leave your organization offers — paid or unpaid, how balances accrue, notice periods, and who has to approve a request." },
  { pattern: /^\/admin\/attendance/, title: "Time & attendance setup", eyebrow: "Administration", help: "The rules behind time tracking: grace periods, how breaks count, when a forgotten clock-out is flagged, overtime approval, the work schedules people follow (including overnight shifts), holidays, and who is on which schedule." },
  { pattern: /^\/admin\/onboarding/, title: "Onboarding setup", eyebrow: "Administration", help: "Build reusable onboarding templates — the steps every new hire works through — then start the right one for each new employee." },
  { pattern: /^\/admin\/offboarding/, title: "Offboarding", eyebrow: "Administration", help: "The exit counterpart to onboarding — build offboarding templates and start a tracked exit workflow when someone leaves." },
  { pattern: /^\/admin\/appraisals/, title: "Performance setup", eyebrow: "Administration", help: "Design checkpoint templates — probation, quarterly, annual, or anything else — and launch review cycles that assign one to your team." },
  { pattern: /^\/admin\/documents/, title: "Document library", eyebrow: "Administration", help: "Upload and manage the files your organization shares with employees, and fulfill or decline document requests — job letters and similar things employees have asked for that you haven't already shared." },
  { pattern: /^\/admin\/development/, title: "Learning & assets", eyebrow: "Administration", help: "Build the catalog of training courses and equipment your organization offers, then assign a course, a certification, or a piece of equipment to a specific person from their own People record." },
  { pattern: /^\/admin\/payroll/, title: "Pay records", eyebrow: "Administration", help: "Import pay-run results your payroll provider already calculated, reconcile them against your employees, and approve the batch. Halomanage never calculates payroll itself." },
  { pattern: /^\/admin\/compensation-settings/, title: "Compensation structure", eyebrow: "Administration", help: "Define the shared pay groups, grades, components, and change reasons that an individual employee's Change Compensation action picks from. Nothing here sets anyone's pay directly." },
  { pattern: /^\/admin\/pay-calendars/, title: "Pay calendars", eyebrow: "Administration", help: "Define pay schedules — weekly, biweekly, monthly, or custom — and generate the actual dated pay periods employees see on My Pay. A calendar with no periods generated yet is why a pay group can look empty." },
  { pattern: /^\/admin\/rewards/, title: "Rewards catalog", eyebrow: "Administration", help: "Manage the reward vendors and products employees can redeem points for, award points directly, and fulfill redemptions once someone claims one." },
  { pattern: /^\/admin\/reports/, title: "Reports", eyebrow: "Administration", help: "Organization-wide numbers in one place — headcount, pending leave, onboarding progress, items about to expire, and payroll batch history." },
  { pattern: /^\/admin\/roles/, title: "Roles & permissions", eyebrow: "Administration", help: "Control what each role can do. Adjust a built-in role's permission bundle for your organization, or create a custom role with exactly the access you need." },
  { pattern: /^\/admin\/security/, title: "Identity & access", eyebrow: "Administration", help: "How people sign in: single sign-on for your email domain, multi-factor authentication requirements, which notifications employees can't switch off, and approved networks." },
];

const SIDEBAR_STORAGE_KEY = "halomanage.sidebar.collapsed";

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

function matches(pathname: string, href: string) {
  if (href === "/dashboard") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

// Only the most specific matching link is active — /team/attendance
// highlights "Team attendance", not "Team hub" as well.
function activeHref(pathname: string, groups: NavGroup[]) {
  return groups.flatMap((group) => group.items.map((item) => item.href))
    .filter((href) => matches(pathname, href))
    .sort((a, b) => b.length - a.length)[0];
}

// When the desktop sidebar is collapsed the labels are visually hidden, so
// each link carries its own aria-label and a title tooltip instead.
function Navigation({ groups, pathname, onNavigate, collapsed = false }: { groups: NavGroup[]; pathname: string; onNavigate?: () => void; collapsed?: boolean }) {
  const active = activeHref(pathname, groups);
  return (
    <nav className="portal-nav" aria-label="Primary navigation">
      {groups.map((group) => (
        <div className="portal-nav-group" key={group.label}>
          <p>{group.label}</p>
          <div>
            {group.items.map((item) => (
              <Link
                aria-current={item.href === active ? "page" : undefined}
                aria-label={collapsed ? item.label : undefined}
                className={item.href === active ? "active" : ""}
                href={item.href}
                key={item.href}
                onClick={onNavigate}
                title={collapsed ? item.label : undefined}
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

export function PortalShell({ children, avatarUrl, canSeeAdmin, canSeeTeam, canSeeTeamAttendance, clock, email, name, organizationName, roleLabels, visibleAdminHrefs }: {
  children: React.ReactNode;
  avatarUrl: string | null;
  canSeeAdmin: boolean;
  canSeeTeam: boolean;
  canSeeTeamAttendance: boolean;
  clock: ClockView | null;
  email: string | null;
  name: string;
  organizationName: string;
  roleLabels: string[];
  // Which admin hrefs this session's actual permissions let it open —
  // narrower than "should the Manage section render at all" (canSeeAdmin).
  // Without this, a custom role scoped to one admin page saw links to
  // every admin page, each one a dead end back to /dashboard.
  visibleAdminHrefs: string[];
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  // Desktop-only UI preference. Per-browser localStorage is deliberate: it
  // is a convenience, not account data, and storage can be unavailable
  // (private windows, blocked site data) — hence the try/catch.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileDrawerRef = useRef<HTMLElement>(null);
  const groups = [...personalItems];
  const teamItems: NavItem[] = [];
  if (canSeeTeam) teamItems.push({ href: "/team", label: "Team hub", icon: "team" });
  if (canSeeTeamAttendance) teamItems.push({ href: "/team/attendance", label: "Team attendance", icon: "clock" });
  if (teamItems.length) groups.push({ label: "Team", items: teamItems });
  if (canSeeAdmin) {
    const items = adminItems.filter((item) => visibleAdminHrefs.includes(item.href));
    if (items.length > 0) groups.push({ label: "Manage", items });
  }

  const page = pageTitles.find((candidate) => candidate.pattern.test(pathname)) ?? { title: "Halomanage", eyebrow: "Workspace", help: null };

  useEffect(() => {
    try {
      // Read after mount, not in useState's initializer: the server render
      // has no localStorage, and initializing differently on the client
      // would cause a hydration mismatch.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSidebarCollapsed(window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1");
    } catch {
      // Storage unavailable — stay expanded.
    }
  }, []);

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? "1" : "0");
      } catch {
        // Preference just won't persist.
      }
      return next;
    });
  }

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
    <div className={`portal-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <aside className="portal-sidebar">
        <div className="portal-brand-row">
          <Brand href="/dashboard" inverse compact={sidebarCollapsed} />
          <button
            type="button"
            className="sidebar-collapse-button"
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!sidebarCollapsed}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={toggleSidebar}
          >
            <Icon name={sidebarCollapsed ? "chevron-right" : "chevron-left"} size={17} />
          </button>
        </div>
        <div className="portal-organization" title={sidebarCollapsed ? organizationName : undefined}>
          <span className="organization-avatar">{initials(organizationName) || "HM"}</span>
          <span><small>Organization</small><strong>{organizationName}</strong></span>
        </div>
        <Navigation groups={groups} pathname={pathname} collapsed={sidebarCollapsed} />
        <div className="portal-account" title={sidebarCollapsed ? name : undefined}>
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
            {clock && <ClockWidget view={clock} />}
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
