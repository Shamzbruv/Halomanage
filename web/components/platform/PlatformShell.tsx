"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { PlatformRole } from "@/lib/platform-session";

const navItems = [
  { href: "/platform", label: "Dashboard" },
  { href: "/platform/organizations", label: "Organizations" },
  { href: "/platform/sso", label: "SSO requests" },
  { href: "/platform/reward-providers", label: "Reward providers" },
  { href: "/platform/staff", label: "Platform staff" },
  { href: "/platform/audit", label: "Audit log" },
];

function isActive(pathname: string, href: string) {
  if (href === "/platform") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function PlatformShell({
  children,
  email,
  role,
}: {
  children: React.ReactNode;
  email: string | null;
  role: PlatformRole;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();

  async function signOut() {
    await supabase.auth.signOut();
    router.push("/platform/login");
    router.refresh();
  }

  return (
    <div className="platform-shell">
      <aside className="platform-sidebar">
        <div className="platform-brand">
          <span className="platform-brand-mark">H</span>
          <span>
            Platform
            <small>Halomanage HQ</small>
          </span>
        </div>
        <nav className="platform-nav" aria-label="Platform navigation">
          {navItems.map((item) => (
            <Link key={item.href} href={item.href} className={isActive(pathname, item.href) ? "active" : ""}>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="platform-staff-badge">
          <span className="role-tag">{role}</span>
          <strong>{email}</strong>
          <button type="button" className="platform-btn platform-btn-secondary" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="platform-main">{children}</main>
    </div>
  );
}
