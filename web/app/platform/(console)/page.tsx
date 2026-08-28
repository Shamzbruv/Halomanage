import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

type OrgRow = {
  id: string;
  name: string;
  slug: string;
  subscription_status: string | null;
  employee_count: number;
  active_employee_count: number;
  portal_account_count: number;
  created_at: string;
};

type SsoRequestRow = { id: string; status: string };

type AuditRow = {
  id: string;
  action: string;
  target_organization_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
};

export default async function PlatformDashboardPage() {
  const supabase = await createClient();
  const [{ data: orgs }, { data: ssoRequests }, { data: audit }] = await Promise.all([
    supabase.rpc("platform_list_organizations"),
    supabase.rpc("platform_list_sso_requests"),
    supabase.from("platform_audit_log").select("id, action, target_organization_id, detail, created_at").order("created_at", { ascending: false }).limit(8),
  ]);

  const organizations = (orgs ?? []) as OrgRow[];
  const pendingSso = ((ssoRequests ?? []) as SsoRequestRow[]).filter((row) => row.status === "requested").length;
  const totalEmployees = organizations.reduce((sum, org) => sum + Number(org.employee_count), 0);
  const activeEmployees = organizations.reduce((sum, org) => sum + Number(org.active_employee_count), 0);
  const portalAccounts = organizations.reduce((sum, org) => sum + Number(org.portal_account_count), 0);

  return (
    <div>
      <div className="platform-topbar">
        <div>
          <span>Overview</span>
          <h1>The whole ecosystem, one screen.</h1>
        </div>
      </div>

      <div className="platform-metric-grid">
        <div className="platform-metric-card"><small>Organizations</small><strong>{organizations.length}</strong></div>
        <div className="platform-metric-card"><small>Total employees</small><strong>{totalEmployees}</strong></div>
        <div className="platform-metric-card"><small>Active employees</small><strong>{activeEmployees}</strong></div>
        <div className="platform-metric-card"><small>Portal accounts</small><strong>{portalAccounts}</strong></div>
        <div className="platform-metric-card"><small>Pending SSO requests</small><strong>{pendingSso}</strong></div>
      </div>

      <div className="platform-card" style={{ marginBottom: "1.5rem" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.75rem" }}>
          <h2 style={{ fontSize: "0.95rem", fontWeight: 700 }}>Organizations</h2>
          <Link href="/platform/organizations" className="platform-btn platform-btn-secondary">View all</Link>
        </div>
        {organizations.length === 0 ? (
          <p className="platform-empty">No organizations yet.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="platform-table">
              <thead><tr><th>Organization</th><th>Employees</th><th>Active</th><th>Portal accounts</th><th>Created</th></tr></thead>
              <tbody>
                {organizations.slice(0, 6).map((org) => (
                  <tr key={org.id}>
                    <td><Link href={`/platform/organizations/${org.id}`}>{org.name}</Link></td>
                    <td>{org.employee_count}</td>
                    <td>{org.active_employee_count}</td>
                    <td>{org.portal_account_count}</td>
                    <td>{new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(org.created_at))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="platform-card">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.75rem" }}>
          <h2 style={{ fontSize: "0.95rem", fontWeight: 700 }}>Recent platform activity</h2>
          <Link href="/platform/audit" className="platform-btn platform-btn-secondary">View audit log</Link>
        </div>
        {!audit || audit.length === 0 ? (
          <p className="platform-empty">Nothing logged yet.</p>
        ) : (
          <ul style={{ display: "flex", flexDirection: "column", gap: "0.6rem", fontSize: "0.82rem" }}>
            {(audit as AuditRow[]).map((row) => (
              <li key={row.id} style={{ display: "flex", justifyContent: "space-between", gap: "1rem", borderBottom: "1px solid var(--p-border)", paddingBottom: "0.5rem" }}>
                <span><span className="platform-badge accent">{row.action}</span></span>
                <span style={{ color: "var(--p-text-muted)" }}>{new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(row.created_at))}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
