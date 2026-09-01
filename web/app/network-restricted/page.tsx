import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { Brand } from "@/components/Brand";
import { Icon } from "@/components/Icon";
import { SignOutButton } from "@/components/SignOutButton";
import { getCurrentSession } from "@/lib/session";

// Reached only via proxy.ts's rewrite when check_network_access() reports
// the visitor's IP is not on the organization's approved list (see
// 20260901100000_network_access_control.sql). Top-level, outside the
// (portal) route group — matches setup-required's "signed in but can't
// proceed" placement, and reuses the workspace-repair-shell look
// established for the same class of screen.
export default async function NetworkRestrictedPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");

  const headerList = await headers();
  const visitorIp = headerList.get("x-real-ip");

  return (
    <div className="workspace-repair-shell">
      <Brand />
      <div className="card workspace-repair-card">
        <span className="empty-state-icon"><Icon name="shield" size={25} /></span>
        <span className="eyebrow">Network restricted</span>
        <h1>This account can only be used from an approved network.</h1>
        <p>
          {session.organization?.name ?? "Your organization"} has restricted sign-in to specific networks, and this connection
          isn&apos;t one of them. If you believe this is a mistake, contact your administrator
          {visitorIp ? <> and share this address: <strong>{visitorIp}</strong></> : "."}
        </p>
        <div className="workspace-repair-actions">
          <SignOutButton className="btn-primary" />
          <a className="btn-secondary" href="/dashboard">Try again</a>
        </div>
      </div>
    </div>
  );
}
