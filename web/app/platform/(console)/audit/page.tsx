import { createClient } from "@/lib/supabase/server";

type AuditRow = {
  id: string;
  actor_user_id: string | null;
  action: string;
  target_organization_id: string | null;
  target_type: string | null;
  target_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
};

export default async function PlatformAuditPage() {
  const supabase = await createClient();
  const [{ data: auditRows }, { data: staff }, { data: orgs }] = await Promise.all([
    supabase.from("platform_audit_log").select("*").order("created_at", { ascending: false }).limit(200),
    supabase.from("platform_staff").select("user_id, display_name"),
    supabase.rpc("platform_list_organizations"),
  ]);

  const staffNameByUserId = new Map((staff ?? []).map((row) => [row.user_id, row.display_name]));
  const orgNameById = new Map(((orgs ?? []) as { id: string; name: string }[]).map((row) => [row.id, row.name]));
  const rows = (auditRows ?? []) as AuditRow[];

  return (
    <div>
      <div className="platform-topbar">
        <div>
          <span>Accountability</span>
          <h1>Platform audit log</h1>
        </div>
      </div>

      <div className="platform-card">
        {rows.length === 0 ? (
          <p className="platform-empty">Nothing logged yet.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="platform-table">
              <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Organization</th><th>Detail</th></tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td style={{ whiteSpace: "nowrap", color: "var(--p-text-muted)" }}>{new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(row.created_at))}</td>
                    <td>{row.actor_user_id ? staffNameByUserId.get(row.actor_user_id) ?? row.actor_user_id : "system"}</td>
                    <td><span className="platform-badge accent">{row.action}</span></td>
                    <td>{row.target_organization_id ? orgNameById.get(row.target_organization_id) ?? row.target_organization_id : "—"}</td>
                    <td style={{ maxWidth: 360, fontSize: "0.74rem", color: "var(--p-text-muted)", fontFamily: "monospace" }}>
                      {row.detail ? JSON.stringify(row.detail) : "—"}
                    </td>
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
