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

export default async function PlatformOrganizationsPage() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_list_organizations");
  const organizations = (data ?? []) as OrgRow[];

  return (
    <div>
      <div className="platform-topbar">
        <div>
          <span>Every tenant</span>
          <h1>Organizations</h1>
        </div>
      </div>

      {error && <p className="platform-alert-error">{error.message}</p>}

      <div className="platform-card">
        {organizations.length === 0 ? (
          <p className="platform-empty">No organizations yet.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="platform-table">
              <thead>
                <tr><th>Organization</th><th>Slug</th><th>Subscription</th><th>Employees</th><th>Active</th><th>Portal accounts</th><th>Created</th></tr>
              </thead>
              <tbody>
                {organizations.map((org) => (
                  <tr key={org.id}>
                    <td><Link href={`/platform/organizations/${org.id}`}>{org.name}</Link></td>
                    <td style={{ color: "var(--p-text-muted)", fontFamily: "monospace", fontSize: "0.76rem" }}>{org.slug}</td>
                    <td><span className="platform-badge neutral">{org.subscription_status ?? "—"}</span></td>
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
    </div>
  );
}
