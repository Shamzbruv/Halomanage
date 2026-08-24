"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Brand } from "@/components/Brand";
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
  { href: "/admin/organization", label: "Organization", icon: "organization" },
  { href: "/admin/leave-types", label: "Leave policies", icon: "calendar" },
  { href: "/admin/onboarding", label: "Onboarding setup", icon: "onboarding" },
  { href: "/admin/appraisals", label: "Performance setup", icon: "performance" },
  { href: "/admin/documents", label: "Document library", icon: "document" },
  { href: "/admin/payroll", label: "Pay records", icon: "payroll" },
  { href: "/admin/reports", label: "Reports", icon: "reports" },
];

const pageTitles: Array<{ pattern: RegExp; title: string; eyebrow: string }> = [
  { pattern: /^\/dashboard/, title: "Overview", eyebrow: "Your workspace" },
  { pattern: /^\/profile/, title: "My profile", eyebrow: "Personal workspace" },
  { pattern: /^\/time/, title: "Time & attendance", eyebrow: "Personal workspace" },
  { pattern: /^\/leave/, title: "Leave", eyebrow: "Personal workspace" },
  { pattern: /^\/onboarding/, title: "Onboarding", eyebrow: "Personal workspace" },
  { pattern: /^\/appraisals/, title: "Performance", eyebrow: "Personal workspace" },
  { pattern: /^\/development/, title: "Learning & assets", eyebrow: "Personal workspace" },
  { pattern: /^\/documents/, title: "Documents", eyebrow: "Personal workspace" },
  { pattern: /^\/team/, title: "Team hub", eyebrow: "Manager workspace" },
  { pattern: /^\/admin\/setup/, title: "Setup guide", eyebrow: "Administration" },
  { pattern: /^\/admin\/employees/, title: "People", eyebrow: "Administration" },
  { pattern: /^\/admin\/organization/, title: "Organization", eyebrow: "Administration" },
  { pattern: /^\/admin\/leave-types/, title: "Leave policies", eyebrow: "Administration" },
  { pattern: /^\/admin\/onboarding/, title: "Onboarding setup", eyebrow: "Administration" },
  { pattern: /^\/admin\/appraisals/, title: "Performance setup", eyebrow: "Administration" },
  { pattern: /^\/admin\/documents/, title: "Document library", eyebrow: "Administration" },
  { pattern: /^\/admin\/payroll/, title: "Pay records", eyebrow: "Administration" },
  { pattern: /^\/admin\/reports/, title: "Reports", eyebrow: "Administration" },
];

function initials(name: string) {
  return name.split(" ").filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
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

export function PortalShell({ children, canSeeAdmin, canSeeTeam, email, name, organizationName, role }: {
  children: React.ReactNode;
  canSeeAdmin: boolean;
  canSeeTeam: boolean;
  email: string | null;
  name: string;
  organizationName: string;
  role: string | null;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const groups = [...personalItems];
  if (canSeeTeam) groups.push({ label: "Team", items: [{ href: "/team", label: "Team hub", icon: "team" }] });
  if (canSeeAdmin) groups.push({ label: "Manage", items: adminItems });

  const page = pageTitles.find((candidate) => candidate.pattern.test(pathname)) ?? { title: "Halomanage", eyebrow: "Workspace" };

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
          <span className="user-avatar">{initials(name) || "U"}</span>
          <span className="portal-account-copy"><strong>{name}</strong><small>{role ? role.replace(/_/g, " ") : email}</small></span>
          <SignOutButton compact />
        </div>
      </aside>

      {mobileOpen && <button className="portal-backdrop" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
      <aside className={`portal-mobile-drawer ${mobileOpen ? "open" : ""}`} aria-hidden={!mobileOpen}>
        <div className="portal-mobile-drawer-head">
          <Brand href="/dashboard" inverse />
          <button className="icon-button inverse" aria-label="Close navigation" onClick={() => setMobileOpen(false)}><Icon name="x" /></button>
        </div>
        <div className="portal-organization">
          <span className="organization-avatar">{initials(organizationName) || "HM"}</span>
          <span><small>Organization</small><strong>{organizationName}</strong></span>
        </div>
        <Navigation groups={groups} pathname={pathname} onNavigate={() => setMobileOpen(false)} />
      </aside>

      <div className="portal-content">
        <header className="portal-topbar">
          <div className="portal-mobile-brand">
            <button className="icon-button" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Icon name="menu" /></button>
            <Brand href="/dashboard" compact />
          </div>
          <div className="portal-page-title"><span>{page.eyebrow}</span><h1>{page.title}</h1></div>
          <div className="portal-topbar-actions">
            <Link href="/profile" className="topbar-profile" aria-label="Open my profile">
              <span className="user-avatar small">{initials(name) || "U"}</span>
              <span className="topbar-profile-copy"><strong>{name}</strong><small>{email}</small></span>
            </Link>
          </div>
        </header>
        <main className="portal-main">{children}</main>
      </div>
    </div>
  );
}
