import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { FeatureToggleList, type FeatureRow } from "@/components/platform/FeatureToggleList";

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

type EmployeeRow = {
  id: string;
  first_name: string;
  last_name: string;
  work_email: string | null;
  status: string;
  has_account: boolean;
  role: string | null;
};

export default async function PlatformOrganizationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: orgs }, { data: employees }, { data: featureCatalog }, { data: overrides }] = await Promise.all([
    supabase.rpc("platform_list_organizations"),
    supabase.rpc("platform_list_organization_employees", { p_org_id: id }),
    supabase.from("platform_features").select("key, name, description").order("key"),
    supabase.from("organization_feature_overrides").select("feature_key, enabled, note").eq("organization_id", id),
  ]);

  const org = (orgs as OrgRow[] | null)?.find((row) => row.id === id);
  if (!org) notFound();

  const overrideByKey = new Map((overrides ?? []).map((row) => [row.feature_key, row]));
  const features: FeatureRow[] = (featureCatalog ?? []).map((feature) => {
    const override = overrideByKey.get(feature.key);
    return {
      key: feature.key,
      name: feature.name,
      description: feature.description,
      enabled: override?.enabled ?? false,
      hasOverride: Boolean(override),
      note: override?.note ?? null,
    };
  });

  return (
    <div>
      <Link href="/platform/organizations" style={{ fontSize: "0.78rem", color: "var(--p-text-muted)" }}>← All organizations</Link>
      <div className="platform-topbar" style={{ marginTop: "0.5rem" }}>
        <div>
          <span>Organization</span>
          <h1>{org.name}</h1>
        </div>
        <span className="platform-badge neutral">{org.subscription_status ?? "no subscription"}</span>
      </div>

      <div className="platform-metric-grid">
        <div className="platform-metric-card"><small>Employees</small><strong>{org.employee_count}</strong></div>
        <div className="platform-metric-card"><small>Active</small><strong>{org.active_employee_count}</strong></div>
        <div className="platform-metric-card"><small>Portal accounts</small><strong>{org.portal_account_count}</strong></div>
        <div className="platform-metric-card"><small>Created</small><strong style={{ fontSize: "1.1rem" }}>{new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(org.created_at))}</strong></div>
      </div>

      <div style={{ display: "grid", gap: "1.5rem", gridTemplateColumns: "1.1fr 0.9fr" }}>
        <div className="platform-card">
          <h2 style={{ fontSize: "0.95rem", fontWeight: 700, marginBottom: "0.75rem" }}>People</h2>
          {!employees || employees.length === 0 ? (
            <p className="platform-empty">No employee records.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="platform-table">
                <thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Account</th><th>Role</th></tr></thead>
                <tbody>
                  {(employees as EmployeeRow[]).map((employee) => (
                    <tr key={employee.id}>
                      <td>{employee.first_name} {employee.last_name}</td>
                      <td style={{ color: "var(--p-text-muted)" }}>{employee.work_email ?? "—"}</td>
                      <td><span className="platform-badge neutral">{employee.status}</span></td>
                      <td>{employee.has_account ? <span className="platform-badge success">Linked</span> : <span className="platform-badge warning">No account</span>}</td>
                      <td>{employee.role ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="platform-card">
          <h2 style={{ fontSize: "0.95rem", fontWeight: 700, marginBottom: "0.75rem" }}>Feature access</h2>
          <FeatureToggleList organizationId={org.id} features={features} />
        </div>
      </div>
    </div>
  );
}
